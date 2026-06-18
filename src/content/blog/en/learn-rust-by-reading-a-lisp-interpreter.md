---
title: "Learn Rust by reading risp, a real Lisp interpreter (not another toy project)"
description: "risp, a zero-dependency Rust Lisp, ships a learn/ directory: file-by-file order (error.rs to eval.rs) and 19 lessons, each pinned to a real file and line."
pubDate: 2026-06-18
tags: ["rust", "lisp", "learning"]
repo: "https://github.com/kissishka/risp"
faq:
  - q: "How can you learn Rust by reading a Lisp interpreter?"
    a: "risp ships a learn/ directory with two paths: reading-order.md walks the codebase file by file from the gentlest (error.rs, 129 lines) to the payoff (eval.rs, ~700 lines), and curriculum.md teaches 19 lessons concept by concept. Every lesson is anchored to a real file-and-line pointer with a hands-on exercise and a cargo check so the compiler corrects you."
  - q: "What is the recommended file reading order for the risp codebase?"
    a: "error.rs first for the most-used idioms, then lexer.rs for ownership and slices, then value.rs in two passes as the heart of the project, then parser.rs for recursion and Result, then env.rs for Rc<RefCell<...>> interior mutability, then eval.rs for the explicit-stack machine. An optional advanced track covers bytecode.rs, compiler.rs, vm.rs, and jit.rs."
  - q: "What Rust concepts does the risp curriculum cover?"
    a: "Nineteen lessons across five parts: basics like control flow, ownership, enums, structs, and lifetimes; errors and traits; the memory model with Rc, RefCell, collections, and closures; modules and Cargo features; and advanced topics including custom iterative Drop, the explicit-stack evaluator, bytecode, and unsafe Rust at the JIT boundary with transmute and get_unchecked."
---

Most "learn Rust" resources hand you toy programs: a temperature converter, a guessing game, a grep clone you abandon at chapter six. [risp](/en/blog/building-a-lisp-in-rust-with-claude-code/) takes the opposite bet. It is a real, std-only Lisp interpreter — not the famous 2019 blog-post "Risp" that fit in a gist, but a multi-thousand-line crate with a lexer, a recursive-descent parser, an explicit-stack evaluator, a [bytecode VM that outpaces CPython 3.14](/en/blog/why-cpython-beats-a-native-compiling-lisp/), and an optional Cranelift JIT — and it ships a `learn/` directory that turns that working artifact into a Rust course. The pitch is simple: you learn a language faster by reading code that does something than by writing code that does nothing, provided someone hands you the *order* to read it in. [risp](https://github.com/kissishka/risp) does. This post walks that order.

## One pipeline, read gentlest-first

The whole project is a single pipeline, stated in `lib.rs`:

```
text → lexer → parser → Value → eval → Value
```

Reading it in execution order would throw you straight at the evaluator, which is the hardest file in the repo. So `learn/reading-order.md` does the opposite — it sorts the files easy-to-hard by *Rust difficulty*, not by data flow. You start at `error.rs`, 129 lines, the gentlest file and, not coincidentally, the one whose idioms appear in every other file. It is where you meet data-carrying `enum` variants like `Arity { name, expected, got }`, the `Display` trait written by hand, constructor functions, and the `RispResult` alias threaded through the entire codebase. Rust's whole error story is `Result<T, E>`; this file *is* the `E`. Master the idioms here and the other six files stop looking foreign.

The full recommended path is:

1. **`error.rs`** (129 lines) — data-carrying enums, `Display`, the `RispResult` alias.
2. **`lexer.rs`** (209 lines) — ownership and slices: `&str` versus `String`, borrowing the input instead of copying it.
3. **`value.rs`** — the heart, read in two passes (more below).
4. **`parser.rs`** (399 lines) — recursion and `Result`: recursive descent, `?` propagation, building `Rc<Pair>` cons cells.
5. **`env.rs`** (217 lines) — `Rc<RefCell<...>>` interior mutability, the pattern every beginner trips on.
6. **`eval.rs`** (~700 lines) — the payoff: an explicit-stack machine, not a recursive tree-walker.

There is an optional advanced track after that — `bytecode.rs` → `compiler.rs` → `vm.rs` (a second engine, a [bytecode VM that outpaces CPython 3.14](/en/blog/bytecode-vm-faster-than-cpython/)) and then `jit.rs` (native codegen behind `--features jit`), plus the networking layer whose `Bytes` and `Tcp` Value variants are documented in the [HTTP server post](/en/blog/http-server-in-a-zero-dependency-lisp/). But the six core files are the spine.

## `value.rs` is the heart — read it twice

The reading order puts `value.rs` third and tells you to read it *in two passes*, because it is the file every other file imports. One enum, `Value`, is **both** the parsed AST and the runtime value — homoiconicity made literal — and it has thirteen variants:

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
    Pair(Rc<Pair>),
    Builtin(Rc<Builtin>),
    Closure(Rc<Closure>),
    Macro(Rc<Closure>),
    Compiled(Rc<ClosureObj>),
    Bytes(Rc<[u8]>),
    Tcp(Rc<std::cell::RefCell<TcpKind>>),
}
```

The first pass, lines 1–120, is about *why every heavy payload sits behind an `Rc`*. That is the central Rust lesson of the project: shared ownership without a garbage collector. Because `Str`, `Symbol`, `Pair`, `Closure`, and the rest are all reference-counted pointers, `Value: Clone` is **O(1)** — cloning a value copies a pointer and bumps a refcount, never the structure it points at. The scalar variants (`Int`, `Bool`, `Float`) are a trivial bit-copy. Either way nothing is duplicated, which is exactly how a GC-less language lets several lists share one tail. That single fact explains a thousand `.clone()` calls scattered through the codebase that would otherwise look profligate.

The second pass — which the doc tells you to defer until `Rc` feels natural — is the hand-written `Drop` for `Pair` and its helper `dismantle`. I cover the why in detail in [the no-stack-overflow post](/en/blog/no-stack-overflow-lisp-interpreter-rust/); here it is enough to know the reading order flags it as advanced and tells you to come back. The point of two passes is pedagogical honesty: you can understand the `Value` enum's *shape* on day one and its *teardown* on day ten, and pretending otherwise just produces a reader who bounces off line 110 and quits.

## The curriculum: nineteen lessons, each pinned to a line

Some people think file-by-file; others think concept-by-concept. For the second kind, `learn/curriculum.md` walks the same code as nineteen lessons across five parts. The two docs deliberately interleave — `parser.rs` shows up in the curriculum under lifetimes (L5) and `ok_or` (L6), not as its own chapter — so you can switch tracks mid-stream.

What makes the curriculum work is the anchoring rule, stated up front: **the snippet is abridged; the `file.rs:line` pointer is the real lesson.** Every lesson cites exact lines, gives a hands-on exercise, and ends with a `cargo` check. Lesson 1, control flow, points at `main.rs:17` for slice patterns and guards, `eval.rs:606` for `let-else`, and `compiler.rs:92` for let-chains:

```rust
let result: Result<(), RispError> = match args.as_slice() {
    [] => repl::run(),                                     // slice pattern: zero args
    [flag, expr] if flag == "-e" => runner::run_str(expr), // guard
    [path] if !path.starts_with('-') => runner::run_file(path),
    _ => { /* usage error */ }
};
let Value::Symbol(sym) = &head else { return Err(/* … */) };  // let-else: bind-or-bail
```

The exercise is to add a `[flag] if flag == "--version"` arm and run `cargo run -- --version`. That is the whole pedagogy in miniature: read the cited lines, change one thing, let the compiler tell you whether you understood. The curriculum's own instruction is blunt — "don't just read; change the code and let `cargo` correct you. That feedback loop *is* the course."

Part 1 (L1–5) is the basics: control flow and slice patterns, ownership and `&str` vs `String` at `lexer.rs:32`, enums with data, structs and `impl` blocks and constructors at `value.rs:94`, and lifetimes at `parser.rs:20` where `Parser<'a>` borrows its token slice. From there it climbs: Part 2 is errors and traits (`Result`, `?`, `map_err`, the custom error enum, then `Display`/`Error`/`From`/`Default`); Part 3 is the memory model — `Rc`, then the `Rc<RefCell<...>>` pattern for the scope chain at `env.rs:15`, then collections, iterators, and closures; Part 4 is modules, the lib/bin split, and conditional compilation with Cargo features. Each rung is anchored, each has an exercise, each ends with a check.

## Part 5: the signature tricks

The advanced lessons are where risp stops being a generic Rust tutorial and starts teaching its own hard-won design. Two tricks recur, and both come from one rule — *when recursion lives in the data, you cannot afford recursion in the code.*

Lesson 15 is the custom `Drop`. A proper list of 200,000 cons cells is a 200,000-deep `Rc` graph, and the compiler-generated recursive destructor would recurse one frame per cell and overflow the stack the moment you freed it. risp's fix is a hand-written, iterative teardown:

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

`Drop` is the one trait you can never derive — you always hand-write it — and the exercise drives that home brutally: replace the body with the naive recursive version, watch the deep-structure test overflow, then revert. There is a real regression test at `value.rs:613` that builds 200,000-deep structures on a thread with a 256 KiB stack and proves build, compare, *and* drop all run in constant stack.

Lesson 16 applies the same idea to evaluation. `eval.rs:114` is `run_loop`, an explicit-stack CEK machine: a two-variant control register (`St::Eval` / `St::Ret`) and a heap `Vec<Frame>` of continuations. A nested call grows the `Vec`, not the Rust call stack, so deep Lisp recursion that would blow a tree-walker runs in bounded space — and tail calls run in constant space. The exercise has you print `stack.len()` while running a 100,000-iteration tail-recursive loop and watch the frame stack stay nearly flat.

## Reaching `unsafe` at the JIT boundary

Lesson 18 is the summit: `unsafe` Rust, taught where the project actually needs it rather than as an abstract footgun. The doc is careful to frame it correctly — `unsafe` does not turn off the borrow checker; it unlocks five specific operations the compiler cannot verify, and you discharge the obligation with a `// SAFETY:` comment stating the invariant you are upholding. risp uses it in exactly two places, both in the "call an unsafe fn" category.

The first is `jit.rs:99`, where `mem::transmute` reinterprets a raw code pointer as a typed `extern "C"` function so the VM can *call* JIT-compiled machine code:

```rust
// SAFETY: `p` is a finalized native fn compiled with this exact extern "C" ABI,
// kept alive by the JITModule; `arity` matches.
let r: i64 = unsafe { match entry.arity {
    1 => mem::transmute::<*const u8, extern "C" fn(*mut JitCtx, i64) -> i64>(p)(cx, int(0)),
    /* … */
}};
```

The ABI must match exactly — that is the entire invariant the comment is promising. The second use is `get_unchecked` at `vm.rs:246`, which skips bounds checks in the bytecode hot loop because the compiler has already guaranteed every index is valid. The [Cranelift JIT post](/en/blog/cranelift-jit-for-a-lisp-in-rust/) goes deeper on the codegen side; the curriculum's job is narrower and better-suited to learning — make you read every `// SAFETY:` comment in `vm.rs` and `jit.rs` and state, for each, what would break if the invariant were false.

That is the right altitude to meet `unsafe` for the first time: two call sites, each guarded, each with a stated reason, sitting on top of a core whose iterative discipline you already trust.

## How to actually use it

The reading order and the curriculum agree on one thing, and it is the most important advice in either file: learn by breaking it. The milestone projects ladder up from trivial to genuine. The first is adding a `(square x)` builtin — roughly ten lines, but it forces you to touch `Value`, `RispResult`, and arity-checking all at once, which is most of Part 1 and Part 2 in one exercise. The last is adding an `Op::PrintTop` opcode: define it in `bytecode.rs`, emit it in `compiler.rs`, handle it in `vm.rs`, which forces the full compiler-to-VM round-trip and proves you understood Part 5.

Everything is checkable from the same four commands the docs put at the top of both files:

```
cargo run                      # REPL — try (+ 1 2 3), (car '(a b c))
cargo run -- -e "(+ 1 2 3)"    # one-shot
cargo test                     # see what's verified
cargo doc --open               # the doc-comments become a browsable book
```

The reason this works as a course and a pile of "read the Rust book" links does not is that every concept is load-bearing. The `Rc` you learn in Lesson 8 is the same `Rc` whose teardown overflows the stack in Lesson 15 and whose pointer you `transmute` in Lesson 18. You are never learning a feature for its own sake — you are learning the feature this specific interpreter needed to exist, in the order it needed them. Open `error.rs`, run `cargo doc --open` alongside it, and start breaking things.
