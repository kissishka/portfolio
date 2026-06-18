---
title: "Why risp, a native-compiling Lisp, loses to CPython on map/fold: allocation, not codegen"
description: "risp, a zero-dependency Rust Lisp, beats CPython by 9–40× on integers but loses 3× on map+fold — the bottleneck is ~400,000 cons-cell allocations, not dispatch."
pubDate: 2026-06-18
tags: ["rust", "performance", "jit"]
repo: "https://github.com/kissishka/risp"
faq:
  - q: "Why does CPython beat a native-compiling Lisp at map and fold?"
    a: "risp's map, filter, and fold are eager and materialize roughly 400,000 cons cells, while CPython's range/map/filter are lazy iterators that allocate none and stream one element at a time. The bottleneck is allocation and memory traffic, not interpreter dispatch — so a JIT that removes dispatch overhead does not help."
  - q: "Why doesn't risp's JIT compile its map/filter/fold code?"
    a: "risp's JIT is an integer JIT by design — it only compiles self-contained i64 arithmetic. The list functions touch tagged Value enums, heap-allocated Rc<Pair> cons cells, reference counting, and dynamic dispatch, none of which fit in a CPU register. On those benchmarks the JIT column equals the VM column because Cranelift emits no machine code at all."
  - q: "What is the highest-leverage way to speed up data-structure-heavy code?"
    a: "Do less allocation, not the same allocations faster. On the map/fold benchmark, fusing the pipeline so no intermediate list is built deletes about 400,000 allocations outright. As a bonus, the de-listed loop becomes a self-contained integer loop that the existing JIT can compile to native code."
---

[risp](https://github.com/kissishka/risp) is a small, std-only
Lisp interpreter written in Rust — not the 2019 "Risp" tutorial of the same name,
but a project with three execution engines ([overview post](/en/blog/building-a-lisp-in-rust-with-claude-code/)): a tree-walking interpreter, a
register-cached bytecode VM, and, behind `--features jit`, a Cranelift-backed JIT
that compiles integer functions straight to native machine code. I built each of
those layers to chase CPython, and on the integer benchmarks the JIT wins by an
embarrassing margin. Then I pointed the same JIT at `map` and `fold`, expected
another rout, and lost to CPython by 3×. The story of *why* I lost is the most
useful thing this project has taught me about performance, because the reason is
not the one almost everyone guesses.

## The integer benchmarks make the JIT look like a superweapon

When every value is an `i64` that lives in a CPU register, a JIT does not merely
edge out an interpreter — it leaves it in a different time zone. These are risp's
integer rows against CPython 3.14:

```
benchmark              tree-walker     VM      JIT    CPython 3.14
fib(30)                    1670 ms   108 ms    7 ms      62 ms
arith loop 2e6             2382 ms   100 ms    5 ms      93 ms
dispatch 2e6               4841 ms   213 ms    5 ms     211 ms
```

`fib(30)` in **7 milliseconds**: about 9× faster than CPython, and the
control-flow-dense `dispatch` loop is JIT 5 ms against CPython's 211 ms — roughly
40×. This is not a fluke of one benchmark; it is the structural payoff of
[lowering an integer subset to Cranelift IR](/en/blog/cranelift-jit-for-a-lisp-in-rust/).
When you compile `i64` arithmetic to registers, you beat *any* bytecode
interpreter, CPython included, because you have deleted interpretation entirely.

So when I taught risp's prelude — `fold`, `map`, `filter` — to run on the VM and
JIT instead of only the tree-walker, the prediction wrote itself: run the
`map`/`fold` benchmark under `--jit`, get a single-digit-millisecond number, take
the victory lap. It did not happen.

## On the list rows the JIT emits nothing at all

Here are the higher-order list rows from the same run:

```
benchmark              tree-walker     VM      JIT    CPython 3.14
fold(+) over 2e5            351 ms    33 ms   32 ms      18 ms
map sq + fold 2e5          622 ms    65 ms   65 ms      21 ms
filter + fold 2e5          531 ms    52 ms   52 ms      20 ms
```

Two things jump off the page. First, **the JIT column equals the VM column.**
`65 ms` and `65 ms`; `52 ms` and `52 ms`. Compare that to the integer rows, where
`jit` (7 ms) sits an order of magnitude below `vm` (108 ms). That gap *is* the
native code — its presence proves Cranelift compiled the function, and its absence
proves Cranelift looked at the function and walked away. For `map sq + fold`,
`--jit` and `--vm` are byte-for-byte the same program: the JIT left the list code
as bytecode and did not emit a single instruction of machine code for it.

Second, **CPython wins.** 21 ms against risp's 65 ms on `map sq + fold` — 3× — on
the exact workload where risp's JIT is supposed to be a superweapon. The
native-compiling Lisp loses to the "slow scripting language" by a factor of three.

If you stop reading here you will conclude the JIT is broken or the prelude is
badly written. Neither is true, and the difference matters.

## The JIT abstaining is correct, not a bug

risp's JIT is an *integer* JIT by design. Its eligibility analysis asks one
question of every function: is this self-contained `i64` arithmetic — `if`, `let`,
`cond`, `and`/`or`, the comparison and math operators, and calls to other
functions just like it? If yes, every value lives in a register and Cranelift
emits a tight native loop. If no, the function stays on the bytecode VM. That is
the same [decline-don't-guess discipline](/en/blog/cranelift-jit-for-a-lisp-in-rust/)
that keeps the JIT correct: a single unsupported leaf disqualifies the whole
function.

`map`, `filter`, and `fold` are emphatically a "no," and you can read why directly
in the prelude. Here is `fold` and the accumulator-threaded `map`, [defined in
risp itself rather than as Rust builtins](/en/blog/risp-standard-library-in-lisp-not-rust/):

```lisp
;; Left fold. Tail-recursive, so folding a list is constant frame-stack; any
;; recursion in `f` grows the heap frame-stack, not the Rust stack.
(def fold
  (lambda (f init xs)
    (if (null? xs)
        init
        (fold f (f init (car xs)) (cdr xs)))))

(def map--acc
  (lambda (f xs acc)
    (if (null? xs) (reverse acc) (map--acc f (cdr xs) (cons (f (car xs)) acc)))))
(def map (lambda (f xs) (map--acc f xs '())))
```

Look at what this code touches. The arguments are not `i64`; they are `Value`, a
24-byte tagged enum (int, float, string, symbol, **pair**, closure, builtin) that
cannot be kept in a register the way an `i64` can. A list in risp is a chain of
`Rc<Pair>`, so every `cons` is a heap allocation — and `map--acc` calls `cons`
once per element, *building a new list*. Every `car`, `cdr`, and `cons` clones and
drops `Rc`s, so native code would have to emit the reference-count inc/dec and
`Drop` logic correctly: the part of a dynamic-language JIT most likely to corrupt
memory if you get it wrong. And `(f (car xs))` is dynamic dispatch — `f` could be
a Rust `fn` pointer, a compiled closure, or a tree-walker closure, a runtime
branch rather than a static call.

To native-compile that, you do not *extend* the integer JIT; you build a second,
far larger one — a boxed-value JIT with a heap-allocation ABI, refcounting in
machine code, and closure dispatch. That is the machinery a serious Scheme
implementation spends years on, and for a std-only hobby Lisp it would dwarf the
rest of the codebase. The JIT abstaining here is the correct call by a deliberately
narrow tool. Which leaves the real question untouched: **CPython does not JIT this
either, so why is it three times faster?**

## The real reason is laziness, not codegen

Here is the CPython benchmark:

```python
reduce(operator.add, map(lambda x: x * x, range(1, 200001)), 0)
```

In Python 3, `range`, `map`, and `filter` are **lazy iterators**. That pipeline
allocates *no intermediate list*. It streams: pull one `x` from `range`, square
it, hand it to `reduce`, fold it into the accumulator, discard it, repeat. Peak
extra memory is one element at a time. `functools.reduce` and `operator.add` are
implemented in C, so the fold loop is a C `while` loop, not Python bytecode; only
the `lambda x: x*x` runs per element, and CPython 3.11+'s adaptive specializing
interpreter inline-caches `int * int` down to a fast path. The transient `PyLong`
objects are small, short-lived, and recycled almost immediately by `pymalloc`'s
free-lists.

Now look at what risp's benchmark actually does:

```lisp
(fold + 0 (map (lambda (x) (* x x)) (range 200000)))
```

risp's `map`, `filter`, and `range` are **eager**. Each stage materializes a full
list before the next one runs:

- `(range 200000)` builds a **200,000-cell** cons list.
- `(map sq …)` walks it and builds **another 200,000-cell** cons list.
- *then* `fold` walks that second list.

That is roughly **400,000 `Rc<Pair>` heap allocations** — plus the reference-count
traffic to build them and tear them down — that CPython never performs. At a
conservative 50–100 ns per allocate-and-free, that is *most* of risp's 65 ms,
spent before a single multiplication happens.

This is the whole story in one sentence: **risp is allocation-bound; CPython is
streaming.** The bottleneck is not interpreter dispatch — the thing a JIT removes —
it is the heap. CPython did not win this benchmark with a faster interpreter or a
JIT of its own. It won by *not building the lists in the first place*. Which means
the instinct "compile it to machine code to go faster" aims at the wrong target
entirely: you could emit flawless native code for the traversal and still pay
400,000 allocations. The JIT was never the lever. This is the inverse of the
[arithmetic story where unboxed `i64`s let the VM beat CPython](/en/blog/bytecode-vm-faster-than-cpython/) —
there the values lived on the stack; here they live on the heap, and that one fact
flips the result.

## The fixes, ranked by payoff, and the punchline

There are three ways to beat CPython here, and the ordering by payoff-to-effort is
itself the lesson.

**1. Laziness / fusion — the real lever, and it needs no JIT.** Fuse `map` and
`fold` so no intermediate list is ever built: stream square-and-accumulate,
exactly the way CPython does. That deletes ~200,000 allocations outright; make
`range` lazy too and you delete the other ~200,000. The prelude already ships the
data-driven, capture-free version of this — `transduce` collapses a whole pipeline
into one pass, and `reduce-range` is the streaming analogue of CPython's lazy
`range`:

```lisp
;; Reduce `[lo hi)` with `rf` from `acc`, one integer at a time, no list built.
(def reduce-range
  (lambda (rf acc lo hi)
    (if (< lo hi)
        (reduce-range rf (rf acc lo) (+ lo 1) hi)
        acc)))
```

Nothing is allocated for the source; the integers exist only as loop variables.
This is a library and representation change — fused pipelines and lazy sequences —
not a compiler change, and it is the [single highest-leverage move on the whole
benchmark](/en/blog/fusing-map-filter-fold-into-one-pass/).

**2. A bump/arena allocator for cons cells.** If you want to keep eager lists with
their simple semantics, attack the allocation cost directly: region-allocate the
cells for the computation's lifetime instead of doing an individual allocation and
`Rc` per cell. CPython's `pymalloc` is good; a purpose-built arena for a
short-lived, list-heavy phase can be better. Smaller change, same bottleneck, no
new evaluator.

**3. The punchline — fusion makes the *existing* JIT win.** The reason the integer
JIT could not touch `map`/`fold` is that the lists forced boxed values and heap
traffic into the loop. Fuse the pipeline and the lists disappear — and what is left
is a self-contained integer loop: pull an `i64`, square it, add it to an `i64`
accumulator. That is *exactly* the shape the existing Cranelift JIT already
compiles to native code and already beats CPython 9–40× on. The prelude makes this
literal with a `sum-of` fusion macro that splices stage bodies inline so the loop
body is pure arithmetic over `i`/`acc` with no call out:

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

The emitted `def` plus call is exactly the JIT-eligible form proven to compile to
native code. You do not need a boxed-value JIT at all — you need to remove the
lists so the integer JIT you *already have* becomes applicable. Laziness and the
JIT are not competing answers; fusion is what unlocks the JIT.

## The generalizable lesson

The seductive wrong answer was "the JIT runs the VM, so just make the JIT compile
the prelude too." The JIT *does* run on the VM — it native-compiles the eligible
integer functions and leaves the rest as bytecode — and the list functions are
not, and cannot reasonably be made, eligible. Chasing that path means building a
second, enormous JIT to attack a bottleneck, allocation, that the JIT does not even
address.

The lesson generalizes well past risp: if you want to understand *why* each layer
is structured the way it is, [reading the risp source is a practical Rust
tutorial](/en/blog/learn-rust-by-reading-a-lisp-interpreter/) in its own right.
More broadly, **on data-structure-heavy code the dominant cost is allocation and
memory traffic, not interpreter dispatch.** That is why
CPython's lazy iterators beat a native-compiling Lisp here, and it is why the
highest-leverage optimization is almost always *doing less allocation* rather than
*executing the same allocations faster*. Codegen is the answer when values live in
registers. When they live on the heap, the answer is to stop putting them there —
and once you do, the 7-millisecond JIT that already owns `fib` quietly owns
`map`/`fold` too.
