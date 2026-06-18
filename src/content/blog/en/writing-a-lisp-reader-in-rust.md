---
title: "Writing a Lisp reader in Rust: from text to a Value tree"
description: "A deep dive into risp's reader — a Lisp-agnostic tokenizer, an iterative explicit-stack parser that can't overflow on deep nesting, reader-macro desugaring, dotted-pair handling, and an atom classifier that declines ambiguous numbers instead of guessing."
pubDate: 2026-06-17
tags: ["rust", "lisp", "parsing"]
repo: "https://github.com/kissishka/risp"
faq:
  - q: "What does a Lisp reader do?"
    a: "A Lisp reader turns source text into data. In risp it runs in two stages: a tokenizer that splits text into tokens with no Lisp knowledge, and a parser that assembles tokens into a Value tree. Because the output is the same Value type the evaluator runs, there is no separate AST."
  - q: "How do you parse deeply nested code without overflowing the stack?"
    a: "Replace recursive descent with an explicit stack. risp's reader keeps a Vec of open-list frames instead of recursing per open paren, so source nested a million parens deep reads in constant Rust stack. The same iterative discipline governs printing and freeing the result."
  - q: "How does quote sugar like 'x become (quote x)?"
    a: "The reader treats prefix reader macros as desugaring. A quote token pushes a pending wrapper; when the next complete form is read, the wrappers are applied innermost-last, so 'x becomes (quote x) and ',x becomes (quote (unquote x)). No special Value variant is needed."
---

A Lisp reader is the part that turns source *text* into *data*. In
[risp](/en/blog/building-a-lisp-in-rust-with-claude-code/) that data is the very
same `Value` tree the evaluator runs on — there is no separate AST type — so the
reader is also where homoiconicity is born. It runs in two stages with a sharp
line between them: a tokenizer that knows nothing about Lisp, and a parser that
adds all the meaning. This post walks both.

## The tokenizer knows no Lisp

The lexer's whole job is to split text into a flat `Vec<Token>`. It classifies
nothing — `42`, `+`, and `foo` all come out as the same `Token::Atom`, to be
sorted out later. There's no regex; it's one `match` over a `Peekable<Chars>`:

```rust
pub enum Token {
    LParen, RParen,
    Quote, Quasiquote, Unquote, UnquoteSplice,  // reader-macro sugar
    Atom(String),   // a bare lexeme to be classified later
    Str(String),    // a string literal, already unescaped
}
```

The only two arms that need any lookahead are `,@` and string escapes. The comma
peeks one character to decide between unquote and unquote-splicing:

```rust
',' => {
    chars.next(); // consume ','
    if chars.peek() == Some(&'@') {
        chars.next(); // consume '@'
        tokens.push(Token::UnquoteSplice);
    } else {
        tokens.push(Token::Unquote);
    }
}
```

A bare lexeme is read by accumulating characters until something structural ends
it — whitespace, a paren, a reader-macro char, a comment, or a quote. That
terminator set is the lexer's entire notion of "what separates tokens":

```rust
while let Some(&cc) = chars.peek() {
    if cc.is_whitespace()
        || cc == '(' || cc == ')'
        || cc == '\'' || cc == '`' || cc == ','
        || cc == ';' || cc == '"'
    {
        break;
    }
    lexeme.push(cc);
    chars.next();
}
tokens.push(Token::Atom(lexeme));
```

Notice `.` isn't in that set, so `foo.bar` is one atom and a lone `.` is its own
atom — the reader, not the lexer, gives `.` its dotted-pair meaning. Keeping the
tokenizer this dumb means every Lisp-specific decision lives in exactly one place
downstream.

## Reading is a loop, not recursive descent

The usual way to build a tree from tokens is recursive descent: a `read`
function that calls itself on each nested `(`. But the reader handles
user-supplied text, and source can nest arbitrarily deep — `((((…))))` a hundred
thousand parens deep is a valid (if useless) program. Recursive descent would
overflow the Rust stack on it. So risp's reader, like
[everything else that touches user-controlled depth](/en/blog/no-stack-overflow-lisp-interpreter-rust/),
is an explicit-stack loop. One `Frame` per open list:

```rust
struct Frame {
    items: Vec<Value>,        // elements gathered so far
    wrappers: Vec<Rc<str>>,   // reader-macro tags to apply when this list closes
    seen_dot: bool,           // dotted-pair state
    tail: Option<Value>,
}
```

`read_form` reads exactly one complete form by pushing a frame on `(`, popping it
on `)`, and placing each completed value into the frame beneath it:

```rust
fn read_form(&mut self) -> RispResult {
    let mut frames: Vec<Frame> = Vec::new();
    let mut pending: Vec<Rc<str>> = Vec::new();

    loop {
        let Some(tok) = self.next().cloned() else {
            return Err(RispError::UnexpectedEof);   // open frame at end of input
        };
        let completed: Value = match tok {
            Token::LParen => {
                frames.push(Frame { items: Vec::new(),
                    wrappers: std::mem::take(&mut pending),
                    seen_dot: false, tail: None });
                continue;
            }
            Token::RParen => { /* pop a frame, build the list (below) */ }
            Token::Atom(a) => apply_wrappers(classify_atom(&a)?, std::mem::take(&mut pending)),
            // ... Str, the reader-macro tokens, and `.` ...
        };
        // Place `completed` into the enclosing frame, or return it if top-level.
        match frames.last_mut() {
            Some(frame) => frame.items.push(completed),
            None => return Ok(completed),
        }
    }
}
```

Because nothing recurses, a source nesting depth of millions reads in constant
Rust stack. There's a test that builds a 100,000-deep nest on a deliberately
small 256 KiB stack thread and parses, renders, *and* drops it — all three have
to be iterative or the thread dies:

```rust
let src: String = "(".repeat(depth) + &")".repeat(depth);
let v = parse_one(&src).expect("deep nest must parse");
let rendered = v.to_string(); // Display must be iterative too
drop(v);                      // and so must Drop
```

## Reader macros are just desugaring

The `'`, `` ` ``, `,`, `,@` prefixes aren't special-cased in the evaluator —
they're rewritten to ordinary calls at read time. A quote token doesn't produce a
value; it pushes a *pending wrapper* that decorates whatever form comes next:

```rust
Token::Quote => { pending.push(Rc::from("quote")); continue; }
Token::Unquote => { pending.push(Rc::from("unquote")); continue; }
```

When the next complete form arrives, `apply_wrappers` folds those tags around it,
innermost-last, so stacked prefixes nest correctly:

```rust
/// `',x` becomes `(quote (unquote x))`.
fn apply_wrappers(mut v: Value, wrappers: Vec<Rc<str>>) -> Value {
    for tag in wrappers.into_iter().rev() {
        v = Value::list(vec![Value::Symbol(tag), v]);
    }
    v
}
```

So `'x` reads as `(quote x)`, `` `(a ,b) `` reads as
`(quasiquote (a (unquote b)))`, and the
[quasiquote engine](/en/blog/lisp-macros-quasiquote-rust/) later recognizes those
desugared forms purely by shape. The reader needs no dedicated `Value` variant
for any of them — they're just lists whose head is a symbol.

## Dotted pairs are a tiny state machine

`(a . b)` builds a single cons cell rather than a list, and `(a b . rest)` builds
an improper list. The reader handles this with two fields on the frame —
`seen_dot` and `tail` — and a few guards that reject every malformed
shape:

```rust
// A `.` only has dotted meaning INSIDE a list; at top level it's a symbol.
Token::Atom(ref a) if a == "." && !frames.is_empty() => {
    let frame = frames.last_mut().expect("frame present");
    if frame.items.is_empty() || frame.seen_dot || !pending.is_empty() {
        return Err(RispError::BadDottedList);   // `( . b)`, `(a . . b)`, `(a . 'b)`
    }
    frame.seen_dot = true;
    continue;
}
```

After the dot, exactly one form may follow before the close, and it becomes the
list's tail; a second form, or a missing one, is a `BadDottedList`. A `Nil` tail
collapses back to a proper list, so `(1 2 . ())` reads identically to `(1 2)`.
The point of all these guards is that the reader has one definition of a valid
dotted form and refuses everything else, instead of building something subtly
wrong.

## Classifying an atom: decline, don't guess

Once the parser has a bare lexeme, it has to decide what it *is*. The order is
integer, then float, then the literal keywords, otherwise a symbol:

```rust
fn classify_atom(s: &str) -> RispResult {
    if let Ok(n) = s.parse::<i64>() { return Ok(Value::Int(n)); }
    if let Ok(x) = s.parse::<f64>() {
        if !is_number_word(s) { return Ok(Value::Float(x)); }  // reject inf/nan words
    }
    match s {
        "#t" | "true"  => return Ok(Value::Bool(true)),
        "#f" | "false" => return Ok(Value::Bool(false)),
        "nil"          => return Ok(Value::Nil),
        _ => {}
    }
    if looks_numeric(s) && !is_number_word(s) {
        return Err(RispError::InvalidNumber(s.to_string()));   // `1.2.3`
    }
    Ok(Value::Symbol(Rc::from(s)))
}
```

Two refusals are doing careful work here. First, `f64::parse` happily accepts
`inf`, `nan`, and `infinity`; those read far more naturally as *symbols*, so
`is_number_word` filters them back out. Second, and more importantly, a lexeme
that *looks* numeric — starts with a digit, or a sign/dot followed by a digit —
but fails to parse is an **error**, not a symbol:

```rust
fn looks_numeric(s: &str) -> bool {
    let mut chars = s.chars();
    match chars.next() {
        Some(c) if c.is_ascii_digit() => true,
        Some('+' | '-' | '.') => matches!(chars.next(), Some(c) if c.is_ascii_digit() || c == '.'),
        _ => false,
    }
}
```

So `1.2.3` doesn't silently become a symbol named `1.2.3`; it's an
`InvalidNumber`. That's the same instinct the
[JIT's type checker](/en/blog/cranelift-jit-for-a-lisp-in-rust/) follows — when
the input is ambiguous, decline loudly rather than guess.

## The REPL rides on one error variant

The reader has one more job: telling the REPL when input is *incomplete* versus
*wrong*. A user typing a multi-line form should get a continuation prompt, not an
error. risp drives this off the parser's own `UnexpectedEof` rather than a
hand-rolled paren counter. `parse_prefix` reads as many complete forms as it can
and reports what's left:

```rust
pub enum Prefix {
    Empty,                 // blank / whitespace / comment-only
    Complete(Vec<Value>),  // every token consumed into complete forms
    Incomplete(Vec<Value>),// some complete forms, then input ends mid-form
}
```

The REPL loop maps those three outcomes directly to behavior: `Empty` re-prompts,
`Incomplete` keeps buffering another line, `Complete` evaluates each form and
resets. A genuine parse error — a stray `)` — is reported and the buffer cleared,
so a typo never wedges or crashes the session:

```rust
match parser::parse_prefix(&buffer) {
    Ok(Prefix::Empty) => { buffer.clear(); continue; }
    Ok(Prefix::Incomplete(_)) => continue,            // ....> continuation prompt
    Ok(Prefix::Complete(forms)) => { /* eval each, then reset */ }
    Err(e) => { eprintln!("error: {e}"); buffer.clear(); }
}
```

Multi-line editing, paste handling, and per-line error recovery all fall out of
one fact: the same code path that builds the tree also knows precisely when the
tree isn't finished yet.

The reader is small, but it sets the terms for everything above it. Its output is
`Value`, not a bespoke AST, which is what lets a macro be
[an ordinary function from code to code](/en/blog/lisp-macros-quasiquote-rust/).
Its loop-not-recursion shape is the first place the
[no-input-crashes-the-host rule](/en/blog/no-stack-overflow-lisp-interpreter-rust/)
has to hold. And its decline-don't-guess classifier means a malformed number is
caught at read time, before it can masquerade as a symbol three engines deep.
