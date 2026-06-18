---
title: "Lexical scope in a Rust Lisp: environments, closures, and a two-path drop"
description: "A deep dive into risp's scope model — an Rc<RefCell<Environment>> chain, iterative lookup and set!, closures that capture frames by reference, and a fast/slow Drop that frees a million-deep scope chain without recursing or allocating on the hot path."
pubDate: 2026-06-17
tags: ["rust", "lisp", "interpreters"]
repo: "https://github.com/kissishka/risp"
faq:
  - q: "How does a tree-walking interpreter represent variable scope?"
    a: "risp represents each lexical scope as a frame: a HashMap of bindings plus an optional parent pointer. An environment is an Rc<RefCell<Environment>>, so frames are shared and mutable. Lookup walks from the local frame up the parent chain to the global frame."
  - q: "How does a closure capture its environment in Rust?"
    a: "A risp closure stores env: Env, an Rc clone of the frame it was defined in. Cloning an Rc is a reference-count bump, not a copy, so the closure shares and keeps alive its defining scope. Captured variables stay live and mutable through that shared frame."
  - q: "How do you free a deep scope chain without overflowing the stack?"
    a: "risp's Environment Drop has two paths. The fast path, for a call frame that binds only atoms and shares its parent, lets ordinary field drop happen with no allocation. The slow path, when a frame owns a deep parent chain or a value graph, hands the links to an iterative teardown loop."
---

Every variable reference in a language has to resolve against *something*, and
that something is the environment. In
[risp](/en/blog/building-a-lisp-in-rust-with-claude-code/) the representation is
deliberately plain — a hash map per scope plus a parent pointer — but the two
decisions around it are not: how a closure captures scope, and how a deep scope
chain gets freed without blowing the stack. This post is about the backbone.

## A frame is a map plus a parent

A scope is one `Environment`: its own bindings, and an optional link to the frame
that encloses it. The handle is reference-counted and interior-mutable, because
closures alias frames and `set!` mutates them:

```rust
/// A shared, mutable handle to an Environment frame.
pub type Env = Rc<RefCell<Environment>>;

pub struct Environment {
    vars: HashMap<Rc<str>, Value>,
    parent: Option<Env>,
}
```

The global frame has no parent; every other frame is a `child` of the scope it
was created in:

```rust
pub fn new_global() -> Env {
    Rc::new(RefCell::new(Environment { vars: HashMap::new(), parent: None }))
}
pub fn child(parent: &Env) -> Env {
    Rc::new(RefCell::new(Environment { vars: HashMap::new(), parent: Some(parent.clone()) }))
}
```

That `parent.clone()` is an `Rc` bump, not a copy of the parent's bindings — a new
frame costs one allocation and one reference count, regardless of how much scope
sits above it. This is the data structure the whole evaluator threads through:
`def` and parameter binding write into the local frame, a call creates a child,
and lookup reads up the chain.

## Lookup walks the chain, iteratively

Reading a variable means searching the current frame, then its parent, then its
parent, up to the global. Like
[everything else that walks user-controlled depth](/en/blog/no-stack-overflow-lisp-interpreter-rust/),
that walk is a loop, never recursion — a scope chain thousands deep costs heap
iterations, not stack frames:

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

Defining and assigning split along the obvious line. `define` always writes the
*local* frame — that's what makes a `let` or a parameter shadow an outer binding.
`set!` instead walks the chain for the *nearest existing* binding and mutates it
in place, erroring with `UnboundSymbol` if there isn't one. The shadowing falls
straight out of "define is local, lookup is nearest-first": a child can bind `x`
to a new value while its parent's `x` is untouched, and a `set!` from the child
reaches up and rebinds the parent's.

## Closures capture the frame, not a copy

This is what the `Rc` is for. A closure is its parameters and body plus
the environment it was defined in:

```rust
pub struct Closure {
    pub name: Option<Rc<str>>,
    pub params: Vec<Rc<str>>,
    pub rest: Option<Rc<str>>,     // variadic tail
    pub body: Rc<Vec<Value>>,
    pub env: Env,                  // the captured defining scope
}
```

Capturing is just `env: env.clone()` — one reference-count bump. The closure now
co-owns its defining frame and keeps it alive for as long as the closure lives,
which is exactly lexical capture: a returned lambda that closed over a local can
still read and mutate it, because both point at the same `RefCell`. Applying the
closure doesn't reach back to where it was *called*; it makes a `child` of where
it was *defined*:

```rust
Value::Closure(c) => {
    let frame = child(&c.env);     // extend the DEFINING scope, not the call site
    bind_params(&c, &args, &frame)?;
    // ... evaluate the body in `frame`
}
```

That one line — `child(&c.env)` and not `child(&caller_env)` — is the whole
difference between lexical and dynamic scope. The captured `env` is the answer to
"what did the free variables in this lambda mean?", fixed at definition time.

## The hazard: freeing a scope chain

Sharing frames by `Rc` creates the same trap that
[long cons lists](/en/blog/no-stack-overflow-lisp-interpreter-rust/) do. A
closure captures a frame; that frame's parent is another frame; freeing the last
owner of the outermost closure can trigger a chain of `Drop`s that recurses one
Rust frame per scope level. A thousand nested `let`s captured by a closure would,
on the naïve derived `Drop`, recurse a thousand frames deep on teardown.

But making *every* environment drop go through an iterative teardown would tax the
common case — a function call that binds two integer parameters and returns —
with an allocation it never needs. So the `Drop` has two paths.

## A two-path drop

The fast path is a pure check: if this frame is **not** its parent's last owner
(someone else still holds the parent, so dropping won't cascade up the chain) and
none of its bound values can hold a deep `Rc` graph, then ordinary field drop
recurses nowhere. Let it happen, allocate nothing:

```rust
impl Drop for Environment {
    fn drop(&mut self) {
        let parent_unique = self.parent.as_ref()
            .is_some_and(|p| Rc::strong_count(p) == 1);
        let has_deep_value = self.vars.values()
            .any(|v| matches!(v, Value::Pair(_) | Value::Closure(_) | Value::Macro(_)));
        if !parent_unique && !has_deep_value {
            return;   // the hot path: a call frame of atoms, sharing its parent
        }

        // Slow path: we own a (possibly deep) parent chain or a value graph.
        let (parent, vals) = self.take_children();
        let mut seed: Vec<Teardown> = Vec::with_capacity(vals.len() + 1);
        if let Some(p) = parent { seed.push(Teardown::Env(p)); }
        seed.extend(vals.into_iter().map(Teardown::Val));
        dismantle(seed);
    }
}
```

The slow path moves the frame's onward links — its parent and its bound values —
onto the heap work-stack that the
[shared `dismantle` loop](/en/blog/no-stack-overflow-lisp-interpreter-rust/)
drains. `take_children` empties the frame first, so by the time its fields drop
they're already `None`/empty and recurse nowhere. The `Teardown` enum is what lets
one loop free both hazards at once: a long `Value` chain *and* a deep `Env` chain
go on the same stack, so freeing a closure that captured a thousand `let` frames
is as flat as freeing a thousand-element list.

The guard conditions carry the logic. `parent_unique` asks "am I about to
trigger a cascade?" — if the parent has other owners, dropping me stops here and
the chain is someone else's problem later. `has_deep_value` asks "could my own
bindings recurse?" — atoms can't, but a captured closure or a list can. Only when
one of those is true do we pay for the iterative path. The overwhelmingly common
frame — a call that binds a couple of numbers and shares the global as its
parent — takes the early `return` and costs nothing.

## The cost the VM erases

This model has one real price: every variable read is a string hash and a
`HashMap` probe, repeated up the chain. For a tree-walker that's a fine trade —
simple, correct, and stack-safe. But it's also the largest gap between a
naïve interpreter and a fast one, which is why risp's
[bytecode VM](/en/blog/bytecode-vm-faster-than-cpython/) resolves every variable
to a fixed slot index at compile time and reads it as a single `stack[base + i]`
array access — no map, no hashing, no chain walk. The environment chain described
here is what the compiler exists to flatten. The tree-walker keeps it because the
chain is the simplest thing that's obviously correct, and "obviously correct" is
the reference the faster engines are
[differentially tested against](/en/blog/building-a-lisp-in-rust-with-claude-code/).

The representation is the plainest
thing that works — a map and a pointer — and the cleverness is confined to two
spots: a one-line `child(&c.env)` that fixes lexical capture, and a two-path drop
that keeps the common case free while still freeing a pathological chain without
recursion. Get the backbone simple and stack-safe, and the optimizing engines
have something trustworthy to flatten.
