---
title: "How a bytecode VM in Rust beat CPython 3.14"
description: "Eleven profile-guided steps with real Rust: lexical-addressed locals, unboxed i64 arithmetic, an unsafe hot loop, and self-tail-calls in place — taking a tree-walking Lisp from 1682 ms to 95 ms on fib(30) and past CPython on every loop."
pubDate: 2026-06-12
tags: ["rust", "performance", "compilers"]
repo: "https://github.com/kissishka/risp"
faq:
  - q: "Can a bytecode interpreter written in Rust beat CPython?"
    a: "Yes. risp's bytecode VM computes fib(30) in 95 ms versus its tree-walker's 1682 ms, and it beats CPython 3.14 on arithmetic (78 vs 96 ms) and tail-recursive loops (25 vs 31 ms). It trails CPython only on call-bound recursion like fib."
  - q: "Why is a Rust VM faster than CPython at arithmetic?"
    a: "risp keeps integers unboxed: Value::Int(i64) lives inline on the stack with no heap pointer or refcount. CPython heap-allocates and refcounts a PyLong object for every intermediate, even 1 + 1, so the arithmetic-dense loop is where risp wins by the widest margin."
  - q: "How do you make a bytecode interpreter faster, step by step?"
    a: "Resolve variables to array indices at compile time instead of hashmap lookups, emit dedicated arithmetic opcodes, cache the active frame in registers, skip bounds checks on compiler-guaranteed indices, and turn self-tail-calls into in-place loops. Each step removed one profiled bottleneck, taking fib(30) from 1682 ms to 95 ms."
---

[risp](/en/blog/building-a-lisp-in-rust-with-claude-code/)'s tree-walking
interpreter took **1682 ms** to compute `fib(30)`. Its bytecode VM does it in
**95 ms** — and on loops and arithmetic it beats CPython 3.14 outright. None of
that came from one clever trick. It came from removing one bottleneck at a time
and letting the next one surface. Here's the whole arc, in real code:

| # | change | fib | tailsum | arith | what it removed |
|--:|--------|----:|--------:|------:|-----------------|
| 0 | tree-walker (baseline) | 1682 ms | 760 ms | 2459 ms | — |
| 1 | bytecode VM (naïve) | 270 ms | 90 ms | — | AST re-analysis + string-hashed env |
| 2 | inline integer arithmetic | 235 ms | 78 ms | — | generic builtin dispatch for `+ - < =` |
| 4 | register-cached frame | 170 ms | 60 ms | — | frame-stack indexing + `Rc` bump per call |
| 8 | **unchecked hot path** | 108 ms | 35 ms | 94 ms | **bounds-check branches per op** |
| 10 | **self-tail-call in place** | 106 ms | **25 ms** | **72 ms** | **frame setup per loop iteration** |
| 11 | **stack-based locals** | **95 ms** | 28 ms | 78 ms | **the per-call frame vector** |
| — | CPython 3.14 | 61 ms | 31 ms | 96 ms | |

## Compile once: variables become array indices

A tree-walker re-derives the meaning of every node every time it runs it: is the
head a special form? a macro? Then it allocates a vector for the operands and
recurses. Reading a variable means hashing its name and probing a `HashMap` at
every scope frame up the chain. All of that is a function of the program text,
not the runtime values, so it can be done once. The compiler resolves every
variable reference to a fixed slot at compile time:

```rust
fn resolve(&mut self, name: &Rc<str>) -> Resolved {
    let last = self.fns.len() - 1;
    // `rposition`, not `position`: a shadowing `let` sits at a HIGHER slot,
    // so the innermost binding must win.
    if let Some(i) = self.fns[last].slots.iter().rposition(|s| s == name) {
        return Resolved::Local(i as u32);
    }
    for f in &self.fns[..last] {
        if f.slots.iter().any(|s| s == name) { return Resolved::Capture; }
    }
    Resolved::Global(self.g.intern(name))
}
```

A local reference then compiles to `Op::LoadLocal(i)`, and at runtime that's a
single `stack[base + i]` read, an array index the CPU can keep in a register. No
hashing, no map probe. This is the single biggest win — `fib` dropped from 1682 ms
to 270 ms in one step — and it's exactly why CPython's `LOAD_FAST` (also an array
index) is its fast opcode.

## Keep integers unboxed

This is the structural reason a Rust VM can beat CPython at all. The compiler
emits dedicated opcodes for two-argument arithmetic instead of a generic call:

```rust
let fast = match &**op {
    "+" => Some(Op::Add), "-" => Some(Op::Sub), "*" => Some(Op::Mul),
    "<" => Some(Op::Lt),  ">" => Some(Op::Gt),  "=" => Some(Op::NumEq),
    // ... <= >=
    _ => None,
};
if let Some(fop) = fast
    && !self.redefined_ops.contains(&**op)        // (def + ...) suppresses inlining
    && matches!(self.resolve(op), Resolved::Global(_))
{
    self.compile(&parts[1], false)?;
    self.compile(&parts[2], false)?;
    self.emit(fop);
    return Ok(());
}
```

The VM's fast path handles the `(Int, Int)` case in a few instructions and
delegates everything else to the real builtin, so semantics (including the
overflow trap) stay identical:

```rust
fn bin_arith(
    stack: &mut Vec<Value>,
    int_fast: fn(i64, i64) -> Option<i64>,
    builtin: fn(&[Value]) -> RispResult,
) -> Result<(), RispError> {
    // SAFETY: a binary op is emitted only after its two operands are pushed.
    let b = unsafe { stack.pop().unwrap_unchecked() };
    let a = unsafe { stack.pop().unwrap_unchecked() };
    if let (Value::Int(x), Value::Int(y)) = (&a, &b)
        && let Some(z) = int_fast(*x, *y)
    {
        stack.push(Value::Int(z));
        return Ok(());
    }
    let r = builtin(&[a, b])?;
    stack.push(r);
    Ok(())
}
// dispatch: Op::Add => bin_arith(&mut stack, i64::checked_add, b_add)?,
```

`Value::Int(i64)` lives inline on the stack: no heap pointer, no refcount. The
fast path matches two ints, calls `i64::checked_add` (an `add` plus an overflow
check), and pushes the result, never touching the allocator. CPython, by
contrast, heap-allocates and refcounts a `PyLong` object for every arithmetic
intermediate, even `1 + 1`. That's why the arithmetic-dense loop is where risp
wins by the widest margin. And the `redefined_ops` scan keeps it honest: if a
program ever does `(def + …)`, `+` is removed from the inline set and routed
through the normal call path, so rebinding an operator still works.

## The hot loop: registers and unchecked indexing

Once allocation and lookups were gone, the residue was the dispatch machinery
itself. The VM holds the active frame entirely in local variables (`closure`,
`ip`, `base`, `cells`), so suspended callers live in a `Vec` while the running
frame's instruction pointer is just a `usize` in a register. And on the paths
where the compiler guarantees an index is valid, it skips the bounds check:

```rust
loop {
    // SAFETY: every function ends in `Return` and all jumps target valid indices,
    // so `ip` is always in range. The VM<->tree-walker differential tests guard this.
    let op = unsafe { *closure.func.code.get_unchecked(ip) };
    ip += 1;
    match op {
        Op::Const(i) => {
            let v = unsafe { closure.func.consts.get_unchecked(i as usize) }.clone();
            stack.push(v);
        }
        Op::LoadLocal(i) => {
            // SAFETY: base + i indexes this frame's locals; i < n_slots (compiler).
            let v = unsafe { stack.get_unchecked(base + i as usize) }.clone();
            stack.push(v);
        }
        // ...
    }
}
```

Each removed check is a compare-and-branch the CPU was running tens of millions of
times. On the arithmetic loop that's hundreds of millions of branches gone, and
`arith` went 129 → 94 ms. There's no per-call locals vector either: locals live
directly on the operand stack at `[base .. base + n_slots]`, so a call's
already-evaluated arguments simply become the callee's locals in place. The
`unsafe` is a real trade, since a compiler bug could now cause UB, which is why
those accesses are the most heavily tested code in the project (more below).

## Self-tail-call in place — the decisive loop win

A tail loop like `(loop (- n 1) (+ acc n))` was still doing a full frame switch
every iteration. The fix detects the common case, a function tail-calling
itself, and overwrites its own locals instead:

```rust
Op::TailCall(argc) => {
    // ... resolve callable ...
    Value::Compiled(c) => {
        let f = &c.func;
        check_arity(f, argc)?;
        // Shift the (already-evaluated) args down onto `base` — the TCO.
        for i in 0..argc {
            let v = std::mem::replace(&mut stack[callee + 1 + i], Value::Nil);
            stack[base + i] = v;
        }
        stack.truncate(base + argc);
        stack.resize(base + f.n_slots, Value::Nil);
        // A self-recursive loop keeps the same closure and (empty) cells —
        // skip that register churn. `n_cells == 0` is load-bearing.
        if !(Rc::ptr_eq(&c, &closure) && f.n_cells == 0) {
            cells = make_cells(f.n_cells);
            closure = c;
        }
        ip = 0;   // jump to the top
    }
}
```

Three guards make this correct, and all three earn their place. `Rc::ptr_eq(&c,
&closure)` ensures it's the same activation tail-calling itself, not mutual
recursion between two closures from the same template. `f.n_cells == 0` ensures
no inner closure captured this frame's locals; if something did, reusing the
slots would make two iterations share a binding, so the code falls through to
allocate fresh cells. And `check_arity` runs unconditionally. When the guards
pass, a tail-recursive Lisp loop becomes what it morally is, a machine loop:
write the new locals, jump to `ip = 0`. That pushed `tailsum` to 25 ms (past
CPython's 30) and `arith` to 72 ms (past CPython's 96).

## Guarded by a second interpreter

Every `unsafe` block above names a compiler-enforced invariant, and risp doesn't
just assert those invariants, it tests them. The VM's output is held
byte-identical to the [tree-walker's by differential
tests](/en/blog/building-a-lisp-in-rust-with-claude-code/): the same program runs
on both engines and the results must match exactly. If a compiler bug ever emitted
an out-of-range index, the test would catch it as a wrong value before it could
ever become undefined behavior in the field. The compiler even defers a malformed
but unreached `cond` clause's error to runtime via an `Op::Raise`, so the VM
errors at exactly the moment, with the same message, the tree-walker would. The
`unsafe` rests on a simpler interpreter that never changed.

## The one shape it couldn't win

After eleven steps, risp's VM beats CPython on `sum` (28 ms vs 31), the arithmetic
loop (78 vs 96), and a `cond`/`let`-dense dispatch loop (203 vs 208), but trails
**1.55×** on call-bound `fib` (95 vs 61). `fib`'s recursion is non-tail (two calls
feed a `+`), so it never hits the cheap self-tail-call path and pays full call
overhead ~2.7M times, against CPython's specialised, computed-goto'd inline call
path. No amount of polishing a portable `match`-dispatched bytecode loop was going
to beat native code at pure recursion. So the next step stopped interpreting and
[started emitting machine code](/en/blog/cranelift-jit-for-a-lisp-in-rust/),
closing the gap by an order of magnitude.
