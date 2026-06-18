---
title: "Fusing a risp pipeline to beat CPython: killing 400,000 allocations wasn't enough"
description: "In risp, a zero-dependency Rust Lisp, fusing map/filter/fold cuts 400,000 allocations to O(1) — but only a monomorphized i64 loop beats CPython: 4 ms vs 24 ms."
pubDate: 2026-06-18
tags: ["lisp", "performance", "jit"]
repo: "https://github.com/kissishka/risp"
faq:
  - q: "How do you fuse a map/filter/fold pipeline so it allocates once?"
    a: "Use transducers: compose transformations of a reducing function and run a single reduce that pushes each element through the whole composed transform straight into the accumulator, so no intermediate list is built at any stage. In risp this drops a pipeline from roughly 400,000 heap allocations to O(1) intermediate allocation."
  - q: "Is eliminating allocation enough to beat CPython on map/fold?"
    a: "No. Removing risp's 400,000 allocations with generic transducers moved it from 3.36x slower than CPython to 2.78x slower — better, but not winning. The remaining cost is the per-element generic closure call, which the integer JIT cannot specialize. You must kill both the allocation and the closure to win."
  - q: "How fast is risp's fused integer pipeline versus CPython?"
    a: "The sum-of fusion macro reduces a map/filter pipeline over an integer range to a self-contained i64 loop the JIT compiles to native code: 4 ms versus CPython's 24 ms at 200,000 elements (about 6x faster). At 20 million elements the JIT runs in 0.01 s against the VM's 0.79 s, a roughly 79x gap that only a real register loop produces."
---

[risp](/en/blog/building-a-lisp-in-rust-with-claude-code/) is a Lisp I wrote in
Rust with three execution engines stacked behind one front end: a tree-walker, a
register-cached [bytecode VM](/en/blog/bytecode-vm-faster-than-cpython/), and an
opt-in [Cranelift JIT](/en/blog/cranelift-jit-for-a-lisp-in-rust/) that turns
self-contained integer functions into native machine code. This is not the 2019
"Risp" from the *Risp in (almost) 200 lines of Rust* tutorial — same pun, very
different animal ([source on GitHub](https://github.com/kissishka/risp)), and the difference is the whole point of this post: on the
integer benchmarks that JIT runs 10–40× faster than CPython 3.14, and yet on the
*list* benchmarks — `map`, `filter`, `fold` — risp lost to CPython, and getting
it back took something other than a bigger JIT.

## The canonical pipeline is 400,000 allocations wearing a trench coat

Here is the benchmark, the same shape every "functional pipeline" microbenchmark
uses — square a range, sum the squares:

```lisp
(fold + 0 (map (lambda (x) (* x x)) (range 200000 '())))
```

Read it inside-out and count the heap. `range` builds a 200,000-cell cons list.
`map` walks that and builds **another** 200,000-cell list. `fold` walks the
second one to a single number. That's roughly **400,000 `Rc<Pair>` heap
allocations**, plus all the refcount traffic to free them again — and that
allocation *is* the benchmark. The interpreter overhead is a rounding error next
to it.

CPython's `reduce(operator.add, map(lambda x: x*x, range(1, 200001)), 0)` looks
character-for-character identical, but `range` and `map` are **lazy iterators**:
nothing materializes, the pipeline streams one element at a time at O(1) extra
memory, and `reduce`/`operator.add` are C. The gap was never my interpreter
being slow — it was 400,000 allocations CPython simply never performs.

The measurement confirms the story exactly (for the full baseline analysis see [why CPython beats a native-compiling Lisp](/en/blog/why-cpython-beats-a-native-compiling-lisp/)). Eager risp versus CPython at
2×10⁵:

| pipeline (2×10⁵) | engine | time | vs CPython |
| --- | --- | ---: | ---: |
| eager `map` + `fold` (builds ~400k cons) | VM / JIT | 68 / 69 ms | **3.36× slower** |

The JIT column matches the VM at 69 ms because list-building code isn't
integer-eligible — the JIT looks at it, sees `cons` and `Pair`, declines, and
hands it straight back to the VM as bytecode. There is nothing here for it to
compile. The goal, stated precisely: drive *intermediate* allocation from O(n)
to O(1), the way CPython's iterators do.

## The trap that looks like fusion but allocates per element

The obvious first idea is a lazy stream — a cons cell whose tail is a thunk you
force on demand. It *reads* like a lazy iterator. It is a disaster. Each step
allocates a cons cell **and** a thunk closure to hold the rest of the
computation, so you've gone from one allocation per element to two. That is
worse than the eager version it was supposed to fix.

This is the load-bearing rule for the rest of the post: **if your "fusion"
allocates a node per element, it is not fusion.** I confirmed this in the design
and did not pursue it. Real fusion has to thread each element through every
stage without ever materializing a place to put it.

## Transducers encode the pipeline as data, not as capturing closures

The shape that actually delivers O(1) intermediate allocation is the
**transducer**: instead of each stage producing a collection, each stage wraps a
*reducing function*, and one `reduce` pushes every source element through the
whole composed transform straight into the accumulator. No stage ever builds a
collection.

The non-obvious implementation detail is *how the stages are represented*. In
risp's `prelude.lisp` a transducer is **data — a list — not a closure**:

```lisp
;; A transducer here is DATA, not a capturing closure: `(map-x f)` is the
;; two-element list `(map f)` and `(filter-x p)` is `(filter p)`. They are kept
;; as data on purpose — a closure that closed over `f`/`p` would capture an
;; enclosing local, which the bytecode compiler rejects, so the whole facility
;; would be tree-walker-only.
(def map-x (lambda (f) (list (list (quote map) f))))
(def filter-x (lambda (p) (list (list (quote filter) p))))
```

That `(quote map)` / `(quote filter)` tag is not stylistic. risp's bytecode
compiler does not emit captured-variable upvalues — the same constraint that
forces [`map`/`filter`/`fold` to thread their function argument explicitly
rather than close over it](/en/blog/risp-standard-library-in-lisp-not-rust/). A
transducer built the Clojure way, as a closure capturing `f` or `p`, would be
rejected by the VM compiler and the whole feature would be stuck on the
tree-walker. Encoding the stage as the list `(map f)` and threading it through
explicit parameters keeps every transducer function eligible for the `--vm` and
`--jit` fast path.

The actual fusion is one tail-recursive driver that threads a single element
through the remaining stages and into the reducer, with no intermediate list at
any step:

```lisp
;; Drive ONE source element `x` through the remaining `stages`, threading the
;; reducer `rf` and accumulator `acc`. A `map` stage rewrites the live value; a
;; `filter` stage that rejects SHORT-CIRCUITS and returns `acc` unchanged. When
;; the stages are exhausted the element has survived the whole pipeline, so it
;; is reduced in: `(rf acc x)`. No intermediate list is ever built.
(def transduce--step
  (lambda (stages rf acc x)
    (if (null? stages)
        (rf acc x)
        (let ((stage (car stages)))
          (let ((tag (car stage)) (op (car (cdr stage))))
            (if (equal? tag (quote map))
                (transduce--step (cdr stages) rf acc (op x))
                ;; filter: keep threading the SAME x only if the predicate holds.
                (if (op x)
                    (transduce--step (cdr stages) rf acc x)
                    acc)))))))
```

A `map` stage rewrites the live value and threads `(op x)` onward; a `filter`
stage either keeps threading the same `x` or short-circuits to `acc` unchanged.
Only the single accumulator is ever threaded. This is genuine fusion — and it
works:

| pipeline (2×10⁵) | engine | time | vs CPython |
| --- | --- | ---: | ---: |
| generic `transduce` (alloc-free, closure-bound) | VM / JIT | 63 ms | **2.78× slower** |

Allocation-free, and it *still loses.*

## The honest finding: killing allocation alone does not beat CPython

Removing
all ~400,000 allocations moved risp from **3.36× slower to 2.78× slower** — a
real improvement, and nowhere near parity. Eliminating allocation, the thing
everyone reaches for first, was a big chunk of the gap but not the whole gap.

The remaining cost is the **per-element generic closure call**. `transduce`
invokes a runtime closure (`op`, `rf`) for every single element, and a generic
closure is *exactly* what the JIT cannot specialize: it isn't a self-contained
integer function, it's a cross-function call through a captured value. risp's VM
pays per-element closure dispatch where CPython's C `reduce` does not, and the
JIT can do nothing about it — its closures capture `f`/`p`, so they run on the
VM but are never JIT-eligible, for the [same decline-don't-guess reason it
refuses lists and cross-function calls
entirely](/en/blog/cranelift-jit-for-a-lisp-in-rust/).

The honest finding: for a dynamically-typed VM, **laziness/fusion
is necessary to be competitive but not sufficient to win.** You have to kill the
allocation *and* the closure.

## Removing the source list too, then monomorphizing the whole loop

Two more moves close it. First, even a fused pipeline fed `(range lo hi)` still
materializes the *input* list. `reduce-range` deletes that by driving the reducer
directly over the half-open interval with a counting loop — the integers exist
only as loop variables, the streaming analogue of CPython's lazy `range`:

```lisp
;; Reduce `[lo hi)` with `rf` from `acc`, one integer at a time, no list built.
(def reduce-range
  (lambda (rf acc lo hi)
    (if (< lo hi)
        (reduce-range rf (rf acc lo) (+ lo 1) hi)
        acc)))
```

That kills the last allocation but leaves the closure call. The win — the only
thing that actually beats CPython — is to stop passing the stages as runtime
*functions* and start passing them as inline *expression templates*. That's the
`sum-of` fusion **macro**. Its macro-time helper `sum-of--build` splices each
stage's body straight into the loop:

```lisp
;; Build the new-accumulator expression for ONE element, folding the remaining
;; `stages` over the current-value expression `cur`, accumulating into `acc`.
;; (A macro-time helper: it returns CODE.)
(def sum-of--build
  (lambda (stages cur acc)
    (if (null? stages)
        (list (quote +) acc cur)
        (let ((stage (car stages)))
          (let ((kind (car stage))
                (var (car (car (cdr stage))))
                (form (car (cdr (cdr stage)))))
            (if (equal? kind (quote map))
                ;; (let ((var cur)) <build rest with current value = form>)
                (list (quote let) (list (list var cur))
                      (sum-of--build (cdr stages) form acc))
                ;; filter: (let ((var cur)) (if form <build rest with cur=var> acc))
                (list (quote let) (list (list var cur))
                      (list (quote if) form
                            (sum-of--build (cdr stages) var acc)
                            acc))))))))
```

A `map` stage emits `(let ((var cur)) ...)` binding the element and threading its
*body expression* as the next current value; a `filter` stage emits the same
binding wrapped in an `(if form ... acc)`. The [macro](/en/blog/lisp-macros-quasiquote-rust/)
then wraps that in a `gensym`'d tail-recursive loop with `i`/`acc` parameters so
nothing captures the call site:

```lisp
(defmacro sum-of args
  (let ((loop (gensym))
        (stages (reverse (cdr (reverse args))))   ; all but last
        (src (car (reverse args))))               ; the (range lo hi) form
    (let ((lo (car (cdr src)))
          (hi (car (cdr (cdr src)))))
      `(begin
         (def ,loop
           (lambda (i acc)
             (if (< i ,hi)
                 (,loop (+ i 1) ,(sum-of--build stages (quote i) (quote acc)))
                 acc)))
         (,loop ,lo 0)))))
```

The emitted loop body is pure `+ - * <` over `i` and `acc`, with **no call out**
— precisely the self-contained integer subset the existing JIT compiles to a
native register loop. There is no list to allocate and no closure to dispatch
through, because the stages have been spliced inline as code. One compiler change
made this reach the JIT: the VM path now macroexpands instead of bailing macros
to the tree-walker, so the `sum-of` expansion runs on `--vm`/`--jit` and its
`i64` loop becomes native code.

## The boundary is sharp: only the fused-to-integer shape wins

```lisp
;; Shape:
;;   (sum-of (map (x) (* x x)) (filter (x) (> x 100000)) (range 1 N))
```

Verified, fused `map` at 2×10⁵: tree **233 ms** / VM **13 ms** / JIT **4 ms**
versus CPython **24 ms** — about **6× faster**. Fused `filter` at 2×10⁵: JIT
**4 ms** versus CPython **19 ms** — about **5× faster**. Watch the cascade on
one workload: eager **68 ms** → generic-fused VM **13 ms** → monomorphic-fused
JIT **4 ms**. Fusion buys the first ~5×; reaching the JIT buys the rest.

And it is genuinely native code, not a constant-folding fluke. At **20,000,000**
elements the JIT runs in **0.01 s** against the VM's **0.79 s** — a roughly
**79×** gap that only a real register loop produces — and the result is
bit-identical (`2666686666700000`) across tree-walker, VM, and JIT. The
[differential tests that hold the JIT byte-identical to the
tree-walker](/en/blog/cranelift-jit-for-a-lisp-in-rust/) cover this too: fusing a
pipeline is not allowed to change an answer.

The boundary is worth stating without spin. `sum-of` is a **specialized fusion
form** — reduce a `map`/`filter` pipeline over an integer range to a number —
not general list processing. General `map`/`filter` over arbitrary values still
build lists. Generic transducers over arbitrary functions are allocation-free but
stay ~2.8× off CPython on per-element closure dispatch. risp beats CPython
*exactly* on the shape that fuses to integers — numeric reductions, counts, sums, filtered aggregates.

The route to beating CPython on pipelines ran through fusion into the integer
JIT I already had, not through building a bigger one. (If you want to trace how
risp's internals fit together, [learn Rust by reading a Lisp interpreter](/en/blog/learn-rust-by-reading-a-lisp-interpreter/) walks the codebase from scratch.) A bigger JIT — boxed
values, heap allocation, refcounting, and closure dispatch all in machine code —
would have been weeks of the most hazardous compiler work for a payoff capped
around 1.5–2.5×, because it attacks interpretation overhead while leaving the
allocation, and then the closure dispatch, exactly where they were. Fusion
deletes the allocation; monomorphization deletes the closure; the JIT that
already existed does the rest. It is the lazy answer in both senses — less new
machinery, and it wins by *not doing work*: the 400,000 allocations that were
never necessary and the per-element dispatch a specialized loop never needs.
