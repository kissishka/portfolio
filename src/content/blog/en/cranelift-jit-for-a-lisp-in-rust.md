---
title: "Adding a Cranelift JIT that runs 10–23× faster than CPython"
description: "A deep dive into risp's opt-in Cranelift JIT in Rust: a decline-don't-guess type checker, lowering if/cond/let to Cranelift IR, inline signed-overflow detection, tail-calls as loop back-edges, and a deopt guard — beating CPython by 10× to 42×."
pubDate: 2026-06-13
tags: ["rust", "performance", "jit"]
faq:
  - q: "How much faster than CPython is a Cranelift JIT for a Lisp?"
    a: "risp's opt-in Cranelift JIT runs fib about 10x faster than CPython 3.14 (6.3 ms vs 61 ms), a tail-sum loop 13x, an arithmetic loop 23x, and a control-flow-dense dispatch loop about 42x (5 ms vs 208 ms)."
  - q: "How does a JIT stay correct?"
    a: "risp's JIT compiles only the narrow subset it can prove equivalent to the tree-walker (fixed-arity integer and boolean functions) and declines everything else, handing it back to the VM. A total type checker returns None for any unsupported leaf, so a single unhandled case disqualifies the whole function."
  - q: "What is deoptimization (deopt) in a JIT?"
    a: "Deopt means bailing out of native code back to the interpreter instead of crashing. risp's JIT runs non-tail recursion on the bounded C stack; past a depth limit it records a deopt signal and re-runs the call on the heap-stack VM, matching the tree-walker's result without a stack overflow."
---

After eleven optimization steps,
[risp](/en/blog/building-a-lisp-in-rust-with-claude-code/)'s
[bytecode VM beat CPython everywhere except call-bound
recursion](/en/blog/bytecode-vm-faster-than-cpython/) — `fib(30)` stayed 1.55×
behind. No amount of polishing a portable `match`-dispatched loop beats CPython's
specialised native call path at pure recursion. So the last step stops
interpreting and starts **emitting machine code** with
[Cranelift](https://cranelift.dev). The result: `fib` **6.3 ms vs CPython's
61 ms (~10×)**, `tailsum` 2.4 ms (13×), the arithmetic loop 4.1 ms (23×), and a
`cond`/`let`/`and`/`or`-dense dispatch loop **5 ms vs 208 ms (~42×)**.

The hard part of a JIT isn't speed. It's staying correct. risp's answer is to
compile only what it can prove equivalent to the tree-walker, and decline
everything else.

## Decline, don't guess: eligibility

Only a narrow subset is eligible: a top-level `(def NAME (lambda …))`, fixed
arity ≤ 4, single-expression body, stably bound (never redefined or `set!`). The
driver doesn't even infer the return type. It guesses `Int`, then `Bool`, and
accepts the first guess that type-checks as a consistent fixed point:

```rust
let ret = [Ty::Int, Ty::Bool]
    .into_iter()
    .find(|&guess| checker.check(&body, guess, &mut params.clone()) == Some(guess));
if let Some(ret) = ret {
    out.push(FnDef { name: name.clone(), params, body, ret, guarded });
}
```

The checker is a total function returning `Option<Ty>`: `Some` if the expression
provably lives in the `{Int, Bool}` subset, `None` for anything else. And
`None` propagates through `?`, so a single unsupported leaf disqualifies the
whole function:

```rust
fn check(&self, expr: &Value, self_ret: Ty, scope: &mut Vec<Rc<str>>) -> Option<Ty> {
    match expr {
        Value::Int(_) => Some(Ty::Int),
        Value::Bool(_) => Some(Ty::Bool),
        Value::Symbol(s) => scope.iter().any(|l| l == s).then_some(Ty::Int),
        Value::Pair(_) => {
            let (head, args) = as_call(expr)?;
            match &*head {
                "if" => {
                    if args.len() != 3 || self.check(&args[0], self_ret, scope)? != Ty::Bool {
                        return None;   // an Int condition is DECLINED (risp's 0 is truthy)
                    }
                    let t = self.check(&args[1], self_ret, scope)?;
                    let e = self.check(&args[2], self_ret, scope)?;
                    (t == e).then_some(t)   // both branches must share a type
                }
                "and" | "or" => self.check_and_or(&args, self_ret, scope),
                "cond"       => self.check_cond(&args, self_ret, scope),
                "let"        => self.check_let(&args, self_ret, scope),
                _ if self.is_primitive(head, scope) => { /* 2 Int args -> Int/Bool */ }
                _ if head == &**self.self_name => { /* self-call: Int args -> self_ret */ }
                _ => None,   // lists, closures, cross-function calls, ...
            }
        }
        _ => None,
    }
}
```

Look at what it refuses: an `Int` used as an `if` condition (risp truthiness
makes `0` truthy, which a raw Cranelift branch would misread), a `cond` without a
final `else` (the value wouldn't always be typed), `and`/`or` over non-`Bool`
operands, and anything involving lists, strings, closures, or cross-function
calls. There's exactly one way to say "yes" and a dozen ways to say "no." If the
JIT can't prove equivalence, the function is handed back to the VM untouched.
That's what lets it be aggressive (raw `i64`s, `mem::transmute` at the boundary)
without ever risking a wrong answer: the only risk it takes is failing to compile
something it could have. And because the integer subset is closed under `i64`
(every leaf is an `i64`, `/` is excluded because it promotes to float), the **JIT
never has to box a value mid-execution**. It's registers from entry to return.

## Lowering to Cranelift IR

Every variable becomes a Cranelift `Variable` (a mutable SSA slot), so parameters,
`let`-bindings, and merge points all reuse the builder's own use/def machinery and
Cranelift inserts the phis automatically. Bodies compile in one of two modes:
`tail` (every path ends in a terminator) or `value` (produce one `i64`). An `if`
in *value* position shows the pattern cleanly — both branches define one result
variable and jump to a merge block:

```rust
fn value_if(&mut self, args: &[Value]) -> Result<ClValue, RispError> {
    let cond = self.value(&args[0])?;
    let then_b = self.b.create_block();
    let else_b = self.b.create_block();
    let merge = self.b.create_block();
    let rv = self.b.declare_var(types::I64);
    brif(self.b, cond, then_b, else_b);

    self.b.switch_to_block(then_b);
    let tv = self.value(&args[1])?;
    self.b.def_var(rv, tv);
    jump(self.b, merge);

    self.b.switch_to_block(else_b);
    let ev = self.value(&args[2])?;
    self.b.def_var(rv, ev);
    jump(self.b, merge);

    self.b.switch_to_block(merge);
    Ok(self.b.use_var(rv))
}
```

Booleans have no separate IR type. They're `iconst` `0`/`1`, and comparisons
`uextend` their result to `i64`, so the whole machine works on one register class.
`and`/`or` lower to short-circuit branch chains where the skipped operand is
never evaluated (matching the tree-walker exactly), and because the type checker
forced all operands to `Bool`, branching on them directly is sound. This is why
the `cond`/`let`/`and`/`or`-dense dispatch benchmark is the JIT's widest margin
(42×): those control forms become native branches instead of VM opcode dispatch.

## Checked arithmetic in native code

Speed that changes a result is a bug. `+ - *` emit inline signed-overflow
detection so the JIT traps exactly where the VM's `checked_add` would error.
Addition uses the classic sign-bit identity: overflow iff the operands share a
sign but the result differs:

```rust
"+" => {
    let r = self.b.ins().iadd(a, c);
    let t1 = self.b.ins().bxor(a, r);
    let t2 = self.b.ins().bxor(c, r);
    let t3 = self.b.ins().band(t1, t2);
    let ov = self.b.ins().icmp_imm(IntCC::SignedLessThan, t3, 0);
    (r, ov)
}
"*" => {
    // Full 128-bit product; overflow iff it doesn't fit back in i64.
    let a128 = self.b.ins().sextend(types::I128, a);
    let b128 = self.b.ins().sextend(types::I128, c);
    let p = self.b.ins().imul(a128, b128);
    let lo = self.b.ins().ireduce(types::I64, p);
    let lo128 = self.b.ins().sextend(types::I128, lo);
    let ov = self.b.ins().icmp(IntCC::NotEqual, lo128, p);
    (lo, ov)
}
// then: brif(self.b, overflow, self.trap_block, cont);
```

On overflow, control branches to a trap block that records the failure into a
context struct and returns. Back in Rust, the call boundary turns that into the
same typed error the builtin raises:

```rust
if ctx.trapped != 0 {
    return match ctx.errkind {
        ERR_DEOPT => Ok(None),   // re-run on the VM (see below)
        _ => Err(RispError::Custom("integer overflow".into())),
    };
}
```

So `(* 9223372036854775807 2)` errors identically whether it ran on the VM or the
JIT. It never wraps.

## Tail calls are loop back-edges; non-tail calls are native calls

A function tail-calling *itself* must run in constant native stack to match the
VM's TCO — so it compiles not to a `call` but to a `jump` back to the loop header
with the parameter variables rebound:

```rust
// Self tail-call -> rebind params and loop (constant native stack).
_ if &*head == self.self_name && args.len() == self.arity && self.lookup(&head).is_none() => {
    let mut newvals = Vec::with_capacity(args.len());
    for a in &args { newvals.push(self.value(a)?); }   // evaluate ALL args first
    for (i, nv) in newvals.into_iter().enumerate() {
        self.b.def_var(self.param_vars[i], nv);
    }
    jump(self.b, self.header);
    return Ok(());
}
```

Evaluating every argument before rebinding any parameter is what makes `(f b a)`
correct. The result is a genuine machine-code loop: no `call`, no stack growth.
A non-tail self-call (like `fib`'s two recursive calls) instead compiles to a
real native `call` and then checks whether the callee trapped, bailing if so. That
distinction is what the next section hinges on.

## Deopting instead of crashing

Non-tail recursion uses the native C stack, which is bounded (~8 MiB). A linearly
deep non-tail recursion — `(sum n) = (+ n (sum (- n 1)))`, a million deep — would
overflow it and `SIGABRT`, whereas the [tree-walker recurses on the
heap](/en/blog/no-stack-overflow-lisp-interpreter-rust/) and returns a value. To
stay behaviorally identical without crashing, every function with a non-tail
self-call carries a runtime depth guard that deopts past a ceiling:

```rust
let depth_entry = if def.guarded {
    let d = b.ins().load(types::I64, MemFlags::trusted(), ctx_val, 16);
    let d1 = b.ins().iadd(d, b.ins().iconst(types::I64, 1));
    b.ins().store(MemFlags::trusted(), d1, ctx_val, 16);
    let over = b.ins().icmp_imm(IntCC::SignedGreaterThan, d1, DEPTH_LIMIT);
    let deopt_block = b.create_block();
    brif(&mut b, over, deopt_block, header);
    // deopt_block: set ctx.errkind = ERR_DEOPT, return sentinel 0.
    Some(d)
} else {
    jump(&mut b, header);   // no guard, no per-call overhead at all
    None
};
```

Past `DEPTH_LIMIT` (10,000) it records `ERR_DEOPT`, which is not an error, and
returns, signaling the VM to re-run the call on its heap-stack bytecode path. The
guard counts live depth, not total calls: every normal return restores the saved
pre-bump depth, so `fib`'s two sibling subtrees don't add up. That's why `fib`
never trips it (`fib(30)` is only ~30 frames deep, vastly below 10,000) and runs
fully native for its 10× win, while the deopt path is pure insurance for
pathological linear recursion. Which function needs a guard is decided statically
by walking the body for a non-tail self-call, so a pure tail-recursive loop pays
nothing.

## The call boundary

The native function's ABI is `extern "C" fn(*mut JitCtx, i64…) -> i64`, where
`JitCtx` is `#[repr(C)]` so the compiled code can hard-code its field offsets:

```rust
#[repr(C)]
struct JitCtx {
    trapped: i64,   // @ 0
    errkind: i64,   // @ 8
    depth: i64,     // @ 16
}
```

When the VM reaches a call whose callee has native code *and* whose arguments are
all `Int`, it transmutes the finalized code pointer to the right arity and jumps
in:

```rust
let r: i64 = unsafe {
    match entry.arity {
        1 => mem::transmute::<*const u8, extern "C" fn(*mut JitCtx, i64) -> i64>(p)(cx, int(0)),
        2 => mem::transmute::<*const u8, extern "C" fn(*mut JitCtx, i64, i64) -> i64>(p)(cx, int(0), int(1)),
        // ... 0, 3, 4
        _ => unreachable!("jit arity is capped at 4 during eligibility"),
    }
};
```

A `fib` call then calls `fib` with a native `call` instruction, register-allocated,
never re-entering the interpreter. Three interpreter costs vanish at once: no
opcode dispatch, no frame plumbing (args ride in registers), and no boxing. And
the fallback is what makes this safe to ship: a function that was never eligible
has no native entry, so its call sites run the ordinary bytecode path, and even
an eligible function falls back per-call the moment it sees a non-`Int`
argument at runtime. The JIT is a pure accelerator layered over the unchanged
step-1–11 engine.

## Why it's opt-in

Cranelift is a real dependency, so the whole JIT lives behind `#[cfg(feature =
"jit")]`. A default `cargo build` still resolves **zero dependencies** and ships
the std-only interpreter unchanged; `--features jit` is the "I'll take the
dependency for native speed" switch. The one shape a portable interpreter couldn't
win falls to native code by an order of magnitude (`fib` from 1.55× behind to
~10× ahead) without the default build taking on a single line of external code.
And every bit of it is held byte-identical to the tree-walker by the [same
differential tests](/en/blog/building-a-lisp-in-rust-with-claude-code/) that guard
the VM: overflow parity, deopt-instead-of-crash, and decline-correctly are all
asserted against the reference engine.
