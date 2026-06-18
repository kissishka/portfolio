---
title: "Designing a Lisp interpreter in Rust with no stack overflows"
description: "A deep dive into risp's iterative core — the Value enum, a hand-written iterative Drop, and an explicit-stack CEK evaluator that read, print, compare, free, and evaluate a million-deep structure without overflowing the Rust stack."
pubDate: 2026-06-11
tags: ["rust", "interpreters", "lisp"]
repo: "https://github.com/kissishka/risp"
faq:
  - q: "How do you stop a tree-walking interpreter from overflowing the stack?"
    a: "Turn every recursive walk over user data into an explicit-stack loop. risp uses an iterative CEK evaluator, a hand-written iterative Drop, and loop-based printing and equality, so the Rust call stack stays a few frames deep no matter how deep the input goes."
  - q: "Why does freeing a long linked list overflow the stack in Rust?"
    a: "Cons cells behind Rc get a recursive destructor: dropping one Pair drops its cdr, which drops the next, and so on. Freeing a 500,000-element list recurses 500,000 frames deep. risp replaces the derived Drop with an iterative teardown that moves children onto a heap work-stack."
  - q: "What is a CEK machine?"
    a: "A CEK machine evaluates expressions with an explicit control register and a heap stack of continuation frames instead of host recursion. risp's evaluator is one loop over (St, Vec<Frame>), so tail calls run in constant space and a million-deep non-tail recursion grows a heap vector, never the Rust call stack."
---

A Lisp interpreter is mostly recursion over trees, and recursion over
user-supplied trees is a stack overflow waiting to happen. The design rule behind
[risp](/en/blog/building-a-lisp-in-rust-with-claude-code/) was blunt: **no input
should ever crash the host.** Not a million-element list, not a million-deep
recursion, not a deeply nested literal. That one rule shaped the entire core, and
it turns out you have to defend it in five different places.

## One enum is both program and data

risp is homoiconic by construction: a single `Value` enum is the parsed AST *and*
the runtime value.

```rust
/// The one enum that is both AST and runtime value.
#[derive(Clone, Debug)]
pub enum Value {
    Nil,
    Bool(bool),
    Int(i64),
    Float(f64),
    Str(Rc<str>),
    Symbol(Rc<str>),
    /// A cons cell: the building block of lists AND of program forms.
    Pair(Rc<Pair>),
    Builtin(Rc<Builtin>),
    Closure(Rc<Closure>),
    /// A macro: like a closure, but invoked on its UNEVALUATED arguments.
    Macro(Rc<Closure>),
    Compiled(Rc<ClosureObj>),
}

pub struct Pair {
    pub car: Value,
    pub cdr: Value,
}
```

When the reader parses `(+ 1 2)` it produces a `Value::Pair` whose `car` is
`Value::Symbol("+")` and whose `cdr` is a chain of more pairs; the evaluator
operates on that exact structure with no separate AST type. Every heap payload
sits behind an `Rc`, so `Value: Clone` is always O(1): cloning a `Pair`
increments one reference count, it doesn't copy the list. And because `Pair` is
just two `Value` slots, `car`/`cdr`/`cons` are O(1) field operations. Notice
`Macro` reuses `Rc<Closure>`: a macro is structurally a closure with a different
enum tag, and [that tag is the whole macro
system](/en/blog/lisp-macros-quasiquote-rust/).

## The hidden hazard: dropping a long list

Here's the trap that catches everyone. Cons cells behind `Rc` get a recursive
destructor for free: dropping a `Pair` drops its `cdr`, which drops the next
`Pair`'s `cdr`, and so on. Free a list 500,000 elements long and that's a
500,000-frame recursion on the Rust call stack: instant overflow. risp replaces
the derived destructor with a hand-written iterative one:

```rust
impl Drop for Pair {
    fn drop(&mut self) {
        // Seed the shared iterative teardown with this cell's two slots so a long
        // `cdr` spine or deep `car` nest is reclaimed without recursing.
        dismantle(vec![
            Teardown::Val(std::mem::replace(&mut self.car, Value::Nil)),
            Teardown::Val(std::mem::replace(&mut self.cdr, Value::Nil)),
        ]);
    }
}
```

The trick is `mem::replace`: instead of letting the fields drop in place (which
would recurse), it moves them out, leaving harmless `Nil`s behind, and hands
them to a loop:

```rust
pub(crate) fn dismantle(mut stack: Vec<Teardown>) {
    while let Some(item) = stack.pop() {
        match item {
            Teardown::Val(Value::Pair(rc)) => {
                if let Ok(mut p) = Rc::try_unwrap(rc) {
                    stack.push(Teardown::Val(std::mem::replace(&mut p.car, Value::Nil)));
                    stack.push(Teardown::Val(std::mem::replace(&mut p.cdr, Value::Nil)));
                }
            }
            Teardown::Val(Value::Closure(rc)) | Teardown::Val(Value::Macro(rc)) => {
                if let Ok(c) = Rc::try_unwrap(rc) {
                    let Closure { env, .. } = c;
                    stack.push(Teardown::Env(env));   // closures capture scopes too
                }
            }
            Teardown::Val(_) => {}
            Teardown::Env(e) => {
                if let Ok(cell) = Rc::try_unwrap(e) {
                    let mut env = cell.into_inner();
                    let (parent, vals) = env.take_children();
                    if let Some(p) = parent { stack.push(Teardown::Env(p)); }
                    stack.extend(vals.into_iter().map(Teardown::Val));
                }
            }
        }
    }
}
```

It's a classic explicit-stack graph walk. The key move: a node's children are
pushed onto the heap work-stack before the node itself drops, so its own `Drop`
always finds empty `Nil` slots and returns in O(1). No chain can recurse.
`Rc::try_unwrap` is what makes it safe with shared structure: it descends into a
cell only when this is the last owner, and a still-shared cell is left for its
final owner to reclaim later. The `Teardown` enum unifies two hazards into one
work-stack — long `Value` chains and the deep scope chains captured by closures —
so freeing a closure that closed over a thousand nested `let` frames is just as
flat. There's a test that builds 200,000-deep structures on a thread with a
256 KiB stack and drops them; a recursive `Drop` would blow that instantly.

## Evaluation is a loop, not a recursion

The same principle governs evaluation. risp's evaluator is an explicit-stack CEK
machine: a two-variant *control register* and a heap stack of continuation
*frames*.

```rust
/// The machine's control register: an expression to evaluate, or a value
/// being handed back to the top continuation.
enum St {
    Eval(Value, Env),
    Ret(Value),
}

enum Frame {
    App  { pending: Vec<Value>, vals: Vec<Value>, env: Env },
    Seq  { rest: Vec<Value>, env: Env },
    If   { conseq: Value, alt: Option<Value>, env: Env },
    Let  { names: Vec<Rc<str>>, pending: Vec<Value>, vals: Vec<Value>, body: Vec<Value>, env: Env },
    And  { rest: Vec<Value>, env: Env },
    // ... Def, Set, Or, Cond, MacroExpand
}
```

The whole evaluator is one loop that alternates between the two:

```rust
/// The single drive loop: alternately evaluate an expression or feed a value to
/// the top frame, until the frame stack empties.
fn run_loop(mut st: St, mut stack: Vec<Frame>) -> RispResult {
    loop {
        st = match st {
            St::Eval(expr, env) => step_eval(expr, env, &mut stack)?,
            St::Ret(val) => match stack.pop() {
                None => return Ok(val),
                Some(frame) => step_return(frame, val, &mut stack)?,
            },
        };
    }
}
```

The entire evaluator state at any instant is `(St, Vec<Frame>)`. The Rust call
stack stays three frames deep (`run_loop` → `step_eval`/`step_return`) no matter
how deep the program is.

### Tail calls in constant space

When a closure is applied, `apply_value` doesn't recurse — it returns the body as
the next `St::Eval`:

```rust
fn apply_value(callable: Value, args: Vec<Value>, stack: &mut Vec<Frame>) -> Result<St, RispError> {
    match callable {
        Value::Builtin(b) => (b.func)(&args).map(St::Ret),
        Value::Closure(c) => {
            let frame = child(&c.env);
            bind_params(&c, &args, &frame)?;
            // Fast path for the common single-form body: tail-evaluate it.
            if c.body.len() == 1 {
                Ok(St::Eval(c.body[0].clone(), frame))
            } else {
                Ok(begin_sequence(c.body.to_vec(), frame, stack))
            }
        }
        other => Err(RispError::NotCallable(other.to_string())),
    }
}
```

`run_loop` just reassigns `st` and continues. If the body's last expression is
another call, `step_eval` pushes one `Frame::App`, resolves it, and calls
`apply_value` again, which again returns `St::Eval`. A tail-recursive function
replaces the current computation rather than stacking on top of it, so the heap
`Vec<Frame>` stays O(1) deep for any number of iterations. `Frame::Seq` makes this
automatic: the last form of any body is entered with a bare `St::Eval` and no new
frame, so it's always in proper tail position.

### Non-tail nesting grows the heap, not the stack

What about genuinely non-tail recursion, like `(+ 1 (+ 1 (+ 1 …)))` a million
deep? Evaluating the outer `+` pushes a `Frame::App` onto the heap `Vec` and
moves to the inner call, which pushes another, and so on. A million nested calls
produce a million `Frame::App` entries in a heap vector, which can grow to
gigabytes, while the Rust call stack, capped at a few megabytes, never grows at
all. So this returns an answer where CPython raises `RecursionError` at depth
~1000:

```lisp
(def sum-to (lambda (n acc) (if (= n 0) acc (sum-to (- n 1) (+ acc n)))))
(sum-to 1000000 0)   ; => 500000500000
```

## Everything that touches user data is iterative

Once you commit to the rule, it has to hold everywhere, or the weakest
traversal becomes the crash. So structural equality runs on an explicit
work-stack with a visited-set that also collapses shared DAGs to linear time:

```rust
pub fn risp_equal(a: &Value, b: &Value) -> bool {
    let mut work: Vec<(Value, Value)> = vec![(a.clone(), b.clone())];
    let mut visited: HashSet<(usize, usize)> = HashSet::new();
    while let Some((p, q)) = work.pop() {
        match (&p, &q) {
            (Value::Pair(x), Value::Pair(y)) => {
                if Rc::ptr_eq(x, y) { continue; }
                let key = (Rc::as_ptr(x) as usize, Rc::as_ptr(y) as usize);
                if !visited.insert(key) { continue; }
                work.push((x.car.clone(), y.car.clone()));
                work.push((x.cdr.clone(), y.cdr.clone()));
            }
            _ => { if !risp_eq(&p, &q) { return false; } }
        }
    }
    true
}
```

So does printing: `Display` interleaves "render this sub-value" and "emit this
literal token" steps on a stack, unwinding a list's spine in a tight inner loop
so a flat 500,000-element list prints without stack growth:

```rust
enum Step { Render(Value), Raw(&'static str) }
let mut stack = vec![Step::Render(self.clone())];
while let Some(step) = stack.pop() {
    match step {
        Step::Raw(s) => f.write_str(s)?,
        Step::Render(v) if matches!(v, Value::Pair(_)) => {
            // unwind the cdr-spine into `seq`, pushed in reverse so it pops in order
            // ... then: stack.extend(seq.into_iter().rev());
        }
        Step::Render(atom) => write_atom(f, &atom)?,
    }
}
```

And so does materializing a call's argument list (`list_vec`, a tight `cur =
p.cdr.clone()` loop), and walking the scope chain for a variable. Reading,
printing, structural equality, reclamation, and evaluation are all iterative.
The only ordinary recursion left in the whole interpreter is bounded by the
source text rather than runtime data: quasiquote template nesting depth.

## The one cost: variable lookup

Iterative safety isn't free. An environment is a `HashMap` per scope plus a
parent pointer, and lookup walks the chain:

```rust
pub fn lookup(env: &Env, name: &str) -> Option<Value> {
    let mut cursor = env.clone();
    loop {
        let next = {
            let frame = cursor.borrow();
            if let Some(v) = frame.vars.get(name) { return Some(v.clone()); }
            frame.parent.clone()
        };
        match next {
            Some(parent) => cursor = parent,
            None => return None,
        }
    }
}
```

Iterative, so a deep scope chain costs heap iterations, not stack frames, but
each step is a string hash and a `HashMap` probe. For a tree-walker that's a fine
trade. It's also the single biggest performance gap between a naïve interpreter
and a fast one, and closing it — resolving every variable to an array index at
compile time — is exactly what risp's [bytecode VM
does](/en/blog/bytecode-vm-faster-than-cpython/) to leave the tree-walker (and
CPython) behind.

The lesson generalizes past Lisp. In any interpreter, every recursive walk over
user-controlled data is a latent crash that only shows up on the input you didn't
test. Turn each one into a loop, and "how deep can the input go?" stops being a
question you have to fear. That discipline, not coincidentally, is also what makes
it safe to build [aggressive `unsafe` fast paths and a native
JIT](/en/blog/cranelift-jit-for-a-lisp-in-rust/) on top of a core you can trust.
