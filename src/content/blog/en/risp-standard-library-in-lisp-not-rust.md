---
title: "Why risp's standard library is written in risp, not Rust"
description: "A deep dive into the native/Lisp boundary in risp — a flat table of std-only builtins, an int-preserving numeric tower, and why map/filter/fold are defined in a risp prelude rather than in Rust: a native higher-order builtin would re-enter the evaluator on the host stack and could overflow."
pubDate: 2026-06-18
tags: ["rust", "lisp", "interpreters"]
repo: "https://github.com/kissishka/risp"
faq:
  - q: "Why is map written in Lisp instead of as a native function?"
    a: "A native higher-order builtin like map would have to call back into the evaluator to apply its function argument, and that re-entry happens on the Rust call stack. Recursion routed through such a map could overflow the host stack. Defining map in a risp prelude keeps that recursion on the evaluator's own heap frame-stack, which can't overflow."
  - q: "How are native builtins structured in risp?"
    a: "Every native builtin is a plain fn(&[Value]) -> RispResult, registered in one flat table. There is no trait and no dynamic dispatch. The same table is installed into both the tree-walker's global environment and the bytecode VM, so the two engines share one native core."
  - q: "How is the risp prelude loaded?"
    a: "The prelude is a risp source file embedded into the binary with include_str! and evaluated when an Interpreter is constructed, through the same path user code uses. Because it is fixed source rather than user input, a failure to evaluate it is treated as an interpreter bug and panics."
---

Every interpreter draws a line between what's written in the host language and
what's written in the interpreted one. Where you draw it is usually a matter of
taste — but in [risp](/en/blog/building-a-lisp-in-rust-with-claude-code/) one
stretch of that line is load-bearing for a correctness guarantee. `map`,
`filter`, and `fold` sit on the *Lisp* side, and not by accident.

## The native core is a flat table

The native library is intentionally small and intentionally boring. Every builtin
has the same shape — a plain function from a slice of arguments to a result — and
they're registered in one flat table. No trait, no `dyn`, no registry object:

```rust
type BuiltinFn = fn(&[Value]) -> RispResult;

pub fn builtin_entries() -> &'static [(&'static str, BuiltinFn)] {
    &[
        ("+", b_add), ("-", b_sub), ("*", b_mul), ("/", b_div),
        ("=", b_num_eq), ("<", b_lt), (">", b_gt), ("<=", b_le), (">=", b_ge),
        ("cons", b_cons), ("car", b_car), ("cdr", b_cdr),
        ("list", b_list), ("length", b_length), ("append", b_append), ("reverse", b_reverse),
        ("not", b_not), ("eq?", b_eq), ("equal?", b_equal),
        ("null?", b_null), ("pair?", b_pair), ("list?", b_listp),
        // ... type predicates, I/O, error, gensym
    ]
}
```

What's on that table is the irreducible core: arithmetic, the cons primitives,
equality, predicates, a little I/O, and `gensym`. What's *not* on it is as
deliberate as what is — there is no `b_map`, no `b_filter`, no `b_fold`. The same
table installs into the tree-walker's global environment and into the
[bytecode VM](/en/blog/bytecode-vm-faster-than-cpython/), so both engines share
one native surface and there's no second implementation to keep in sync.

## The native side has to get the number tower right

The flat signature hides some real work. Arithmetic, for instance, has to preserve
exact integers but promote to float the moment a float appears, across a variadic
argument list. risp threads a small `Num` type through a fold to do it:

```rust
enum Num { Int(i64), Float(f64) }

fn fold_numeric(op: &'static str, acc: Num, rest: &[Value],
    int_op: fn(i64, i64) -> Result<i64, RispError>,   // checked: traps on overflow
    float_op: fn(f64, f64) -> f64,
) -> Result<Num, RispError> {
    let mut acc = acc;
    for v in rest {
        let n = as_num(op, v)?;
        acc = match (acc, n) {
            (Num::Int(a), Num::Int(b)) => Num::Int(int_op(a, b)?),  // stays exact
            (a, b) => Num::Float(float_op(a.as_f64(), b.as_f64())), // promotes
        };
    }
    Ok(acc)
}
```

The `int_op` is a *checked* operation, so `(+ a b)` traps on overflow rather than
wrapping — the same trap the [VM's fast path](/en/blog/bytecode-vm-faster-than-cpython/)
and the [JIT's inline overflow check](/en/blog/cranelift-jit-for-a-lisp-in-rust/)
preserve, so all three engines agree on what `(* 9223372036854775807 2)` does.
This is the kind of thing that *should* be native: it's a tight, finite operation
on primitive values with no call back into user code.

## The line map and fold can't cross

Now the higher-order functions. `map` has to apply its function argument to each
element — which means calling back into the evaluator. Written as a native
builtin, that callback runs on the *Rust call stack*:

```text
eval -> b_map (native) -> eval(user fn) -> ... -> b_map -> eval(user fn) -> ...
        └─ each layer is a real Rust stack frame ─┘
```

So a recursion routed *through* a native `map` would consume host stack per
level, and a big enough input would overflow it — silently undoing the entire
[no-input-crashes-the-host guarantee](/en/blog/no-stack-overflow-lisp-interpreter-rust/)
that the iterative evaluator works so hard to provide. The evaluator can grow its
frame-stack on the heap to gigabytes; a native re-entry can't, because it's
pinned to the few-megabyte C stack. That's the whole reason `map`/`filter`/`fold`
are not native.

## The prelude: a standard library in the language itself

Instead they live in `prelude.lisp`, written in risp, where their recursion runs
on the [evaluator's own heap frame-stack](/en/blog/no-stack-overflow-lisp-interpreter-rust/)
and can't overflow. The whole file is three definitions:

```lisp
;; Left fold. Tail-recursive, so folding a list is constant frame-stack; any
;; recursion in `f` grows the heap frame-stack, not the Rust stack.
(def fold
  (lambda (f init xs)
    (if (null? xs)
        init
        (fold f (f init (car xs)) (cdr xs)))))

;; map and filter in terms of fold + reverse — no native re-entry.
(def map
  (lambda (f xs)
    (reverse (fold (lambda (acc x) (cons (f x) acc)) '() xs))))

(def filter
  (lambda (p xs)
    (reverse (fold (lambda (acc x) (if (p x) (cons x acc) acc)) '() xs))))
```

`fold` is tail-recursive, so it runs in constant frame-stack no matter how long
the list is, and `map`/`filter` are defined *in terms of* `fold`, so they inherit
that for free. Every primitive they lean on — `null?`, `car`, `cdr`, `cons`,
`reverse` — is native and finite. The recursion that could blow up is the one the
user supplies in `f`, and that recursion now flows through `eval`, which grows the
heap, not the host stack.

## Loading it: include_str! and one sanctioned panic

The prelude is embedded into the binary and evaluated when an `Interpreter` is
built, through the exact same path user code takes:

```rust
impl Interpreter {
    pub fn new() -> Self {
        let global = env::new_global();
        builtins::install(&global);     // native table first
        let interp = Interpreter { global };
        interp.load_prelude();          // then the risp-level stdlib
        interp
    }

    fn load_prelude(&self) {
        const PRELUDE: &str = include_str!("prelude.lisp");
        self.run_source(PRELUDE).expect("prelude.lisp must evaluate cleanly");
    }
}
```

Note the order: natives install first, because the prelude is written *against*
them. And note the `expect`. risp's core
[never panics on user input](/en/blog/building-a-lisp-in-rust-with-claude-code/) —
every malformed program returns a typed `RispError`. The prelude is the one place
a panic is correct, precisely because it *isn't* user input: it's fixed source
shipped in the binary, so a failure to evaluate it is an interpreter bug, and
crashing loudly at startup beats limping along with a broken standard library.

The boundary between native and interpreted is often presented as a performance
question. Here it's a correctness one. Keep the native surface minimal and finite;
push anything that has to call back into user code down into the language itself;
and the host stack stays entirely out of the user's recursion. Writing the standard
library in the language it serves is what keeps the no-overflow promise true all
the way up.
