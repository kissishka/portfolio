---
title: "Macros and quasiquote: code that writes code in risp"
description: "A deep dive into risp's macro system in Rust — how defmacro, demand-driven expansion, the quasiquote engine, and gensym let a Lisp grow control structures like while and unless that no function can express."
pubDate: 2026-06-10
tags: ["lisp", "macros", "interpreters"]
faq:
  - q: "Why can't Lisp macros be regular functions?"
    a: "A function evaluates all its arguments before its body runs, so it cannot decide whether code runs or invent new control structures. Written as a function, (unless cold (wear-coat)) would always call wear-coat. Macros transform code before evaluation, so they can add control structures like while and unless."
  - q: "What is quasiquote in Lisp?"
    a: "Quasiquote is a template language for building code. A backtick quotes a structure literally, comma (unquote) drops a computed value into a hole, and comma-at (unquote-splicing) splices the elements of a list into a position, which is what makes variadic macros possible."
  - q: "What is gensym and why is it needed?"
    a: "gensym generates a unique symbol that cannot collide with user names. risp's gensyms look like {g 0}, with a space inside braces that the reader can never produce from source, so a macro's temporary variables are structurally incapable of capturing or shadowing the caller's variables."
---

Some things can't be functions. `unless` is the classic case: a function
evaluates all its arguments before its body runs, so `(unless cold (wear-coat))`
would call `wear-coat` unconditionally. To decide whether code runs at all, or to
invent a control structure the language never shipped, you have to transform the
code before it is evaluated. That is what macros do, and in
[risp](/en/blog/building-a-lisp-in-rust-with-claude-code/) the whole mechanism is
a few hundred lines of Rust over the same `Value` tree the reader produces. This
post goes under the hood.

## A macro is a closure that runs on code

At the user level, `defmacro` looks just like defining a function, except the
parameters bind to unevaluated code:

```lisp
(defmacro unless (test body)
  `(if ,test () ,body))

(unless #f 'ran)                     ; => ran
(macroexpand '(unless cold (coat)))  ; => (if cold () (coat))
```

Inside the interpreter, a macro is structurally identical to a closure (same
parameters, same body, same captured environment) but wrapped in a distinct
`Value::Macro` variant so the evaluator can tell them apart:

```rust
// src/specials.rs
pub fn make_macro(args: &[Value], env: &Env) -> Result<Value, RispError> {
    if args.len() < 3 {
        return Err(RispError::bad_form(
            "defmacro",
            "expects (defmacro name (params) body...)",
        ));
    }
    let name = args[0]
        .as_sym()
        .map_err(|_| RispError::bad_form("defmacro", "name must be a symbol"))?
        .clone();
    let (params, rest) = parse_params("defmacro", &args[1])?;
    let body: Vec<Value> = args[2..].to_vec();

    let closure = Closure {
        name: Some(name.clone()),
        params,
        rest,
        body: Rc::new(body),
        env: env.clone(),
    };
    let macro_val = Value::Macro(Rc::new(closure));
    env.borrow_mut().define(name, macro_val.clone());
    Ok(macro_val)
}
```

The only thing that distinguishes a macro from a lambda is that `Value::Macro`
tag. Everything interesting happens later, when the evaluator hits a call site
whose operator is bound to one.

## Expansion is demand-driven, not a separate pass

A lot of Lisps run a dedicated macro-expansion pass over the whole program before
evaluation. risp doesn't. Its evaluator is an explicit-stack machine (the same
[iterative design that keeps deep recursion off the Rust
stack](/en/blog/no-stack-overflow-lisp-interpreter-rust/)), and macro expansion
happens inside the evaluation step itself, on demand:

```rust
// src/eval.rs — step_eval
Value::Pair(ref p) => {
    let head = p.car.clone();
    let rest = p.cdr.clone();
    if let Value::Symbol(sym) = &head {
        // Special-form dispatch happens BEFORE argument evaluation.
        if is_special(sym) {
            let args = rest.list_vec()?;
            return eval_special(sym, args, env, stack);
        }
        // A macro use expands (on UNEVALUATED operands) and the result
        // is evaluated in its place.
        if let Some(mac) = macro_lookup(sym, &env) {
            let operands = rest.list_vec()?;
            let expansion = expand_once(&mac, operands)?;
            return Ok(St::Eval(expansion, env));
        }
    }
    // Ordinary application: evaluate the operator, then the operands.
    let operands = rest.list_vec()?;
    stack.push(Frame::App { pending: operands, vals: Vec::new(), env: env.clone() });
    Ok(St::Eval(head, env))
}
```

The check order matters: **special form, then macro, then ordinary
application.** When the head is a macro, risp passes the operand forms raw — as
`Value` trees, code-as-data — into the macro body, runs it, and feeds the result
straight back into the machine via `St::Eval(expansion, env)`. The expansion is
re-entered like any other expression, and if it expands into another macro call,
the next loop iteration handles that too. Expansion is just evaluation that happens
to produce code instead of a value:

```rust
// src/eval.rs
pub fn expand_once(mac: &Closure, operands: Vec<Value>) -> RispResult {
    let frame = child(&mac.env);
    bind_params(mac, &operands, &frame)?;
    eval_seq(&mac.body, &frame)
}
```

## Quasiquote: building code from a template

Writing expansions by hand with `cons` and `list` is unreadable. Quasiquote is the
template language that fixes that: backtick `` ` `` quotes a structure literally,
`,` (unquote) drops a computed value into a hole, and `,@` (unquote-splicing)
drops the elements of a list into a hole. That last one is what makes variadic
macros possible: `. body` captures the rest arguments, and `,@body` splices them
into a `begin`:

```lisp
(defmacro when (test . body)
  `(if ,test (begin ,@body) ()))
```

The engine behind it is one recursive walk over the template, parameterised by an
unquote depth so that nested quasiquotes behave:

```rust
// src/specials.rs
pub fn quasi(template: &Value, depth: usize, env: &Env) -> Result<Value, RispError> {
    // Atoms are literal.
    if !matches!(template, Value::Pair(_)) {
        return Ok(template.clone());
    }
    // `,x` — fire at depth 1, otherwise peel one level and rebuild.
    if let Some(inner) = tagged(template, "unquote") {
        return if depth == 1 {
            eval(&inner, env)
        } else {
            Ok(retag("unquote", quasi(&inner, depth - 1, env)?))
        };
    }
    // Nested `` `x `` raises the depth.
    if let Some(inner) = tagged(template, "quasiquote") {
        return Ok(retag("quasiquote", quasi(&inner, depth + 1, env)?));
    }
    // A general list: walk the spine, handling `,@x` in element position.
    let mut out: Vec<Value> = Vec::new();
    let mut cur = template.clone();
    loop {
        match cur {
            Value::Pair(p) => {
                let car = p.car.clone();
                if let Some(inner) = tagged(&car, "unquote-splicing") {
                    if depth == 1 {
                        let spliced = eval(&inner, env)?;
                        let elems = spliced.list_vec().map_err(|_| {
                            RispError::bad_form("quasiquote", "unquote-splicing expects a list")
                        })?;
                        out.extend(elems);          // <-- the splice
                    } else {
                        out.push(retag("unquote-splicing", quasi(&inner, depth - 1, env)?));
                    }
                } else {
                    out.push(quasi(&car, depth, env)?);
                }
                cur = p.cdr.clone();
            }
            Value::Nil => return Ok(Value::list(out)),
            other => return Ok(Value::list_with_tail(out, quasi(&other, depth, env)?)),
        }
    }
}
```

(I've trimmed the dotted-tail edge cases, an `,x` or `,@x` sitting in the tail
position of an improper list, but the shape is exactly this.) The interesting
parts:

- An **atom is literal**: `` `5 `` is just `5`. Only `Pair`s need work.
- **`,x` at depth 1 calls `eval` immediately**, substituting a live runtime value
  into the code tree being built. That's the bridge between expansion-time
  computation and the code it emits.
- **`,@x` at depth 1 evaluates `x`, demands a list, and `out.extend(elems)`**,
  flattening a variable number of forms into a single position. This is the only
  way to splice a list of statements into one code slot.
- **Nested quasiquotes raise the depth**; unquotes only fire at depth 1, so an
  inner `` `(... ,x) `` keeps its `,x` for the inner level. The `tagged` helper
  recognises the reader's desugared `(unquote x)` / `(unquote-splicing x)` forms
  purely by shape, with no dedicated `Value` variant needed.

`quasi` is also the one place risp recurses on the Rust stack in proportion to
source depth (one frame per nesting level of quasiquote), and that's fine,
because template nesting is bounded by the program text, not by runtime data.

## gensym: names that can't be captured

risp's macros are **unhygienic by default**: an expansion lands in the caller's
scope, so any temporary name the macro introduces can collide with (or shadow)
a variable the caller passed in. `swap!` is the textbook hazard, because it needs
a temporary:

```lisp
(defmacro swap! (a b)
  (let ((g (gensym)))
    `(let ((,g ,a)) (set! ,a ,b) (set! ,b ,g))))
```

`gensym` is the escape hatch, and its implementation is a neat trick:

```rust
// src/builtins.rs
fn b_gensym(args: &[Value]) -> RispResult {
    if args.len() > 1 {
        return Err(RispError::arity("gensym", "0 or 1", args.len()));
    }
    let prefix = match args.first() {
        None => "g".to_string(),
        Some(Value::Str(s)) => s.to_string(),
        Some(Value::Symbol(s)) => s.to_string(),
        Some(other) => return Err(RispError::type_error("gensym", "string or symbol", other)),
    };
    let n = GENSYM_COUNTER.with(|c| {
        let v = c.get();
        c.set(v.wrapping_add(1));
        v
    });
    Ok(Value::Symbol(Rc::from(format!("{{{prefix} {n}}}"))))
}
```

The generated name looks like `{g 0}`, `{g 1}`, …, and it contains a **space
inside braces, a pattern the risp reader can never produce from source text.** So
a gensym is structurally incapable of colliding with any identifier a programmer
could type, and the monotonic counter keeps successive gensyms distinct from each
other. Hygiene by construction, opt-in, no `syntax-rules` machinery required.

## macroexpand: see exactly what you wrote

Because a macro is "just" a function from code to code, you can ask risp to show
you the code it produces, without running it:

```rust
// src/eval.rs
pub fn macroexpand_full(mut form: Value, env: &Env) -> RispResult {
    loop {
        let (head, rest) = match &form {
            Value::Pair(p) => (p.car.clone(), p.cdr.clone()),
            _ => return Ok(form),
        };
        let Value::Symbol(sym) = &head else { return Ok(form); };
        if is_special(sym) { return Ok(form); }
        match macro_lookup(sym, env) {
            Some(mac) => { let operands = rest.list_vec()?; form = expand_once(&mac, operands)?; }
            None => return Ok(form),
        }
    }
}
```

It loops `expand_once` until the head is no longer a macro, then returns the
macro-free form unevaluated. It expands only the top level (the standard
`macroexpand`, not `macroexpand-all`), which is exactly what you want when
debugging a single macro.

## The payoff: a loop the language doesn't have

risp has no `while`. So you write one — out of `defmacro`, quasiquote, and a
`gensym`-hygienic helper:

```lisp
(defmacro while (test body)
  (let ((loop (gensym)))
    `(begin
       (def ,loop (lambda () (if ,test (begin ,body (,loop)) 0)))
       (,loop))))

(while (< i 1000000)
  (begin (set! total (+ total i))
         (set! i (+ i 1))))
```

At expansion time, `loop` is bound to a fresh `{g 0}`; the template then splices
the gensym in as a definition name and drops the caller's `,test` and `,body`
trees into the `if`. The call site expands, once before evaluation, into roughly:

```lisp
(begin
  (def {g 0} (lambda () (if (< i 1000000) (begin <body> ({g 0})) 0)))
  ({g 0}))
```

Three things make this work and cost nothing:

1. **The helper name can't be captured:** `{g 0}` is unreadable, so the `def` it
   introduces is invisible to the caller's scope.
2. **The recursion is a tail call:** `({g 0})` sits in tail position, so risp's
   evaluator runs it in [constant stack for any number of
   iterations](/en/blog/no-stack-overflow-lisp-interpreter-rust/). A million
   iterations don't grow the stack.
3. **It's gone before runtime:** the macro disappears at expansion; what runs is
   an ordinary tail-recursive function.

Python has no equivalent: you cannot add a new control structure to Python from
inside Python. Even risp's own `map`, `filter`, and `fold` live in a
[risp-level prelude](/en/blog/building-a-lisp-in-rust-with-claude-code/) rather
than in Rust, for a related reason: keeping their recursion on the evaluator's
heap stack instead of the host's.

That's the appeal of homoiconic code: because a program is just a `Value`
tree, a macro is an ordinary function that happens to run at expansion time and
return more tree. The language is extensible from within, and the extension is
indistinguishable from a built-in once it expands.
