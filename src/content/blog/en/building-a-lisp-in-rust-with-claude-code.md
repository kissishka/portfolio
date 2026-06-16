---
title: "Building a Lisp interpreter in Rust with Claude Code"
description: "How I built risp — a zero-dependency Lisp in Rust with a tree-walker, a bytecode VM, and a Cranelift JIT — pairing with Claude Code, and the differential-testing discipline that keeps AI-written systems code honest."
pubDate: 2026-06-16
tags: ["rust", "lisp", "claude-code"]
faq:
  - q: "What is risp?"
    a: "risp is a small Lisp interpreter written in Rust with zero dependencies in its default build. It has three execution engines (a tree-walker, a bytecode VM, and an optional Cranelift JIT) that share one evaluator, environment, and standard library. It was built by pairing with Claude Code."
  - q: "How do you keep an AI-written interpreter correct?"
    a: "risp runs every program through two engines, a simple reference tree-walker and the optimized VM or JIT, and asserts byte-identical results with a differential-testing helper called agree(). The tree-walker is the oracle, so any optimization that disagrees fails the build before it can ship."
  - q: "Does risp have any dependencies?"
    a: "No. A default cargo build resolves zero external crates. The only dependency, Cranelift for the JIT, is quarantined behind a --features jit flag, so the standard-library-only interpreter never pulls in third-party code unless you explicitly opt in."
---

risp is a small Lisp interpreter written in Rust: zero dependencies in the
default build, three execution engines, and an optional JIT that beats CPython
3.14 by 10–23×. I built it pairing with **Claude Code**. The speed isn't what I
want to talk about, though. This post is about the workflow, and the discipline
that made an agent-accelerated systems project something I could actually trust.

## A charter, not a backlog

Before any code, I fixed the invariants. The crate doc states the most important
one in its first sentence, and it reads as a constraint, not a boast:

```rust
//! # risp
//!
//! A small, std-only Lisp interpreter in Rust.
//!
//! The pipeline is: `text -> lexer -> parser -> Value -> eval -> Value`.
//!
//! A single [`Value`] enum serves as BOTH the parsed AST and the runtime value
//! — homoiconicity made literal. ... A hand-written iterative teardown reclaims
//! arbitrarily long or deep `Rc` graphs ... without overflowing the Rust stack.
//! [`eval`] is an explicit-stack machine ...
```

The one dependency risp ever takes — Cranelift, for the JIT — is quarantined
behind a feature flag so the default build resolves *nothing*:

```rust
/// Optional Cranelift-backed native JIT for the integer subset. Compiled only
/// under `--features jit`; the default build is std-only with zero dependencies.
#[cfg(feature = "jit")]
pub mod jit;
```

That `#[cfg(feature = "jit")]` is the enforcement: no code in that module
compiles unless you opt in, so a default `cargo build` pulls no external crates
at all. When an agent is doing the typing, constraints like this are the steering
wheel. They turn "write a Lisp" into a problem with hard edges that every later
decision has to respect.

## One value, three engines

risp grew three execution engines over its life — a tree-walker, a
[bytecode VM](/en/blog/bytecode-vm-faster-than-cpython/), and a
[Cranelift JIT](/en/blog/cranelift-jit-for-a-lisp-in-rust/) — but they all hang
off one tiny CLI dispatch, and they all share the same evaluator, environment,
and standard library:

```rust
let result: Result<(), RispError> = match args.as_slice() {
    // No arguments: interactive REPL.
    [] => repl::run(),
    // `-e EXPR`: evaluate one expression.
    [flag, expr] if flag == "-e" => runner::run_str(expr),
    // `--vm PATH`: run a file on the bytecode VM fast path.
    [flag, path] if flag == "--vm" => risp::vm::run_file(path),
    // `--jit PATH`: VM + Cranelift JIT (requires `--features jit`).
    #[cfg(feature = "jit")]
    [flag, path] if flag == "--jit" => risp::jit::run_file(path),
    // A single path argument: run the file on the tree-walker.
    [path] if !path.starts_with('-') => runner::run_file(path),
    _ => { /* usage error */ }
};
```

The default path is the tree-walker. The VM and the JIT are accelerators layered
over it, and the tree-walker never gets deleted as the faster engines arrive. It
stays on as the reference implementation, which turns out to be the whole
foundation of the testing strategy below.

## The no-panic contract

A REPL that crashes on a typo is useless, so risp has exactly one error type, and
the core never panics on user input:

```rust
/// The one typed error enum threaded through every interpreter stage.
#[derive(Debug, Clone)]
pub enum RispError {
    // --- reader stage ---
    UnexpectedEof,          // the REPL uses this to ask for more input
    UnexpectedClose,
    UnterminatedString,
    InvalidNumber(String),
    BadDottedList,
    // --- eval stage ---
    UnboundSymbol(String),
    NotCallable(String),
    Arity { name: String, expected: String, got: usize },
    TypeError { op: &'static str, expected: &'static str, got: String },
    BadSpecialForm { form: &'static str, msg: String },
    DivisionByZero,
    Custom(String),         // from the `(error "msg")` builtin
}
```

The variants are grouped by the stage that produces them, so a failure's origin
is legible at a glance. `UnexpectedEof` does real work: it's the signal that
tells the REPL to keep buffering a multi-line form instead of reporting an error.
There is no `Box<dyn Error>` anywhere on the evaluator path; `RispResult =
Result<Value, RispError>` is threaded through every public function. Panics are
reserved for genuine interpreter-internal invariant violations, never for
anything a program can trigger.

## Keep the AI honest with differential tests

This is the part that matters most. Generating systems code with an agent is
fast. Fast enough that the bottleneck becomes trust, not typing. risp's answer
is a single helper that appears, almost identically, in both `tests/vm.rs` and
`tests/jit.rs`:

```rust
/// Assert the VM and the tree-walker agree (and return that shared result).
fn agree(src: &str) -> String {
    let interp = Interpreter::new();
    let tree = interp.run_source(src).unwrap().to_string();
    let got = vm_eval(src);
    assert_eq!(tree, got, "VM disagrees with tree-walker for {src:?}");
    got
}
```

That's the thesis made executable: run the same program on two engines, serialize
both results, assert byte-equality. The tree-walker is the oracle, and every
optimization is continuously tested against it. The JIT's version goes further
and normalizes both sides to `Result<String, String>`, so it tests error parity,
not just success parity.

Why does this matter so much for AI-written code? Because the fast paths are
exactly where a plausible-looking change quietly breaks a corner case. Two real
examples that `agree()` caught:

```rust
#[test]
fn redefined_operators_are_not_inlined() {
    // Rebinding a core operator must take effect on the VM too.
    assert_eq!(agree("(def + (lambda (a b) 999)) (+ 1 2)"), "999");
    assert_eq!(agree("(+ 1 2)"), "3");   // not redefined -> still inlined, still correct
}
```

A bytecode compiler that inlines `+` into an `Add` opcode will, if you're not
careful, keep inlining it even after the program redefines `+` as a function.
That's a subtle wrong-answer bug, and `agree()` forces the VM to produce `999` or
fail the build. The second case is a regression that used to abort the whole process:

```rust
#[test]
fn deep_non_tail_recursion_deopts_instead_of_overflowing() {
    // (Regression: before the depth guard this exited 134 / "stack overflow".)
    assert_eq!(
        agree("(def sum (lambda (n) (if (< n 1) 0 (+ n (sum (- n 1)))))) (sum 1000000)"),
        "500000500000"
    );
}
```

The JIT compiles integer recursion to native code on the bounded C stack; a
million-deep non-tail recursion would overflow it and `SIGABRT`. The fix (a deopt
guard that falls back to the heap-stack VM) is the kind of aggressive, fiddly
systems change you'd be nervous to let an agent write. The test defuses that: it
runs the same program through the tree-walker, which recurses on the heap and
returns the right answer, then asserts the JIT matches it exactly. A crash produces
no value, so it's an automatic failure.

Across the suite that's ~60 ground-truth tree-walker tests in `integration.rs`,
plus 14 VM and 12 JIT tests that all route through `agree()`. The `unsafe`
blocks in the VM and the native code-gen in the JIT aren't a bet against
correctness. A second, simpler interpreter that never moved is checking every one
of them.

## The Interpreter facade

All of this sits behind one embeddable type, with the standard library baked in
at compile time and loaded through the same path user code uses:

```rust
impl Interpreter {
    pub fn new() -> Self {
        let global = env::new_global();
        builtins::install(&global);
        let interp = Interpreter { global };
        interp.load_prelude();   // include_str!("prelude.lisp"), evaluated
        interp
    }
}
```

`map`, `filter`, and `fold` aren't native — they live in a risp-level prelude
`include_str!`'d into the binary and evaluated on startup, which keeps the native
surface minimal and the recursion on the evaluator's own heap stack.

## What the loop actually felt like

The division of labour stayed constant the whole way: I held the invariants and
the definition of "done," Claude Code supplied the throughput, and the differential
tests arbitrated. The hard ideas — an
[iterative evaluator that never overflows the
stack](/en/blog/no-stack-overflow-lisp-interpreter-rust/),
[macros that expand to native loops](/en/blog/lisp-macros-quasiquote-rust/), a
bytecode VM that beats CPython, a JIT on top of it — got built and verified far
faster than I'd have managed alone, and never once shipped a change I couldn't
explain. That's the case for building this way: the agent is the horsepower, the
charter and the oracle tests are the brakes, and you need both.
