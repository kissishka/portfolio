---
title: "Hardening risp's HTTP stack: TLS behind a flag, try/catch as a 30-line builtin"
description: "How risp, a zero-dependency Rust Lisp, gained production HTTP: TLS behind a Cargo flag, try/catch as a 30-line builtin, and a quadratic read loop made linear."
pubDate: 2026-06-18
tags: ["rust", "lisp", "http"]
repo: "https://github.com/kissishka/risp"
faq:
  - q: "How do you add HTTPS to a zero-dependency interpreter without breaking the charter?"
    a: "A default cargo build still resolves zero external crates — rustls and webpki-roots only enter with --features tls, mirroring how the Cranelift JIT is gated behind --features jit. The feature flag is the only option that keeps both properties at once: the zero-dep default and a path to the HTTPS web."
  - q: "How do you add try/catch without rewriting an explicit-stack evaluator?"
    a: "Make it a builtin instead of a special form. risp's error-guard is a roughly 30-line function that re-enters the evaluator on a thunk and, on a raised error, calls a handler with the message string. It touches no continuation-machine invariants and works in both the tree-walker and the bytecode VM for free because builtins are shared across engines."
  - q: "Why did fixing the HTTP reader change an O(n-squared) loop to O(n)?"
    a: "The v1 risp read loop re-concatenated the entire accumulated buffer on every 4 KB chunk just to scan for the delimiter, which is quadratic for large bodies. Moving the read-until-delimiter loop into a Rust primitive, tcp-read-until, lets it scan only the newly arrived bytes by tracking a search-start offset, making the read linear in a single buffer."
---

The [risp](https://github.com/kissishka/risp) this post is about is my own from-scratch Lisp interpreter in Rust — a
[std-only Lisp I built with Claude Code](/en/blog/building-a-lisp-in-rust-with-claude-code/),
not the 2019 toy calculator of the same name that floats around tutorial blogs.
This risp has a [bytecode VM, an explicit-stack CEK evaluator that never overflows](/en/blog/no-stack-overflow-lisp-interpreter-rust/),
and — the subject here — an HTTP/1.1 client and server [written in Lisp on top of a
handful of socket builtins](/en/blog/http-server-in-a-zero-dependency-lisp/). The
bar for this pass was specific: move that HTTP layer from "works against a friendly
localhost" to "talks to the real, hostile, HTTPS-only web" without surrendering the
one property that makes the project interesting — a default `cargo build` that
resolves **zero external crates**. Every decision below falls out of that tension.

## TLS is a crate, and the charter says no crates

Production HTTP means HTTPS, and HTTPS means TLS — and TLS is not in Rust's
standard library. There is no `std::tls`. The moment you want to handshake with
`example.com:443` you need a crypto crate, which collides head-on with the
zero-dependency charter. The naive resolutions are both wrong: making rustls an
always-on dependency breaks "zero deps" outright, and staying plaintext-only
forever means the interpreter can never reach the modern web at all.

The resolution was already in the tree. The [Cranelift JIT that beats CPython by
10× to 42×](/en/blog/cranelift-jit-for-a-lisp-in-rust/) — context on [why CPython still wins on cold workloads](/en/blog/why-cpython-beats-a-native-compiling-lisp/) — is gated behind
`--features jit`, so a default build doesn't pull Cranelift. TLS gets the same
treatment: rustls lives behind `--features tls`. A default `cargo build` is
std-only and plaintext-only; `cargo build --features tls` opts into HTTPS. This
isn't bending the charter — it's *preserving* it, by precedent. The feature flag is
the only option that keeps both properties at once: the zero-dep default and a path
to the HTTPS web.

That choice ripples down to one socket handle type. rustls's `StreamOwned` needs
`&mut self` for I/O, where a plain `TcpStream` is happy through a shared `&`. To
carry both behind one uniform `Value::Tcp`, the handle moved from `Rc<TcpKind>` to
`Rc<RefCell<TcpKind>>`, and the TLS variant is `#[cfg]`-gated so the non-tls build
literally doesn't contain it — matches stay exhaustive with no dead `Tls` arm:

```rust
pub enum TcpKind {
    Stream(std::net::TcpStream),
    Listener(std::net::TcpListener),
    #[cfg(feature = "tls")]
    Tls(Box<rustls::StreamOwned<rustls::ClientConnection, std::net::TcpStream>>),
}
```

The variant is boxed so it doesn't bloat `Value` for the case nobody on the default
build ever constructs.

## Why ring, not aws-lc-rs

The dependency itself is `rustls` 0.23, pulled with `default-features = false` and
the feature set `["ring", "std", "tls12", "logging"]`. Turning the defaults off is
the whole point: rustls 0.23 defaults to the **aws-lc-rs** crypto provider, which
drags in a C/cmake build toolchain. For a project whose entire identity is "clones
and `cargo build` with nothing else installed," requiring a working C compiler and
cmake on the `--features tls` path would be a quiet betrayal of the same spirit the
flag exists to protect. The **ring** provider is portable and toolchain-light — no
cmake — so `cargo build --features tls` stays a plain Rust build.

Trust roots are the other place a TLS stack usually reaches into the host: most
clients load the OS certificate store. I used **webpki-roots** 0.26 instead, which
bundles the Mozilla root set directly into the binary. No `rustls-native-certs`, no
dependency on whatever cert store the deploying machine happens to have. The client
trusts the same roots everywhere it runs.

There was one predicted hazard — the rustls builder API has churned across versions
— and it bit exactly where expected. The shape that actually compiles against 0.23:
`builder_with_provider(...)` returns the builder **directly** (no `?`), only
`with_safe_default_protocol_versions()` returns a `Result`, and there's **no**
`CryptoProvider::install_default()` call needed. Older snippets all over the web get this wrong.

## tls-connect exists even when TLS doesn't

Here's a small decision with an outsized payoff: `tls-connect` is registered as a
builtin **even when the `tls` feature is off**. In that build it doesn't connect —
it returns a clean, catchable runtime error:

> `tls-connect: TLS not enabled — rebuild with --features tls`

Why bother registering a function that can't work? Because the HTTP library routes
every `https://` URL to `tls-connect`. If the symbol simply didn't exist on a
default build, an `https://` request would blow up with an *unbound symbol* error —
a confusing crash that points at risp's internals rather than at the fix. Registered
but disabled, it fails with a message that tells you precisely what to do. You can
see the routing in `http--open`, which doesn't know or care whether TLS is compiled
in; it just dispatches on scheme and lets the error propagate as a value:

```lisp
(def http--open
  (lambda (parsed timeout)
    (let ((scheme (http--get parsed 'scheme "http"))
          (host (http--get parsed 'host ""))
          (port (http--get parsed 'port 80)))
      (let ((sock (if (equal? scheme "https")
                      (tls-connect host port)
                      (tcp-connect host port))))
        (tcp-set-timeout sock timeout)
        sock))))
```

## try/catch as a builtin, not a special form

risp had no error handling at all: a raised error aborted the whole program.
Production HTTP can't allow that — a single network blip mid-request would kill the
host. The textbook move is a new special form, `try`/`catch`. But a special form
means surgery on the [explicit-stack CEK evaluator](/en/blog/no-stack-overflow-lisp-interpreter-rust/):
teaching the continuation machine how to unwind a partial computation, preserve its
invariants, and — because the engine has two backends — doing all of that *twice*,
once for the tree-walker and once for the bytecode VM. Real work, real blast radius.

It turns out none of that is necessary. Error-catching drops out of an ordinary
builtin that re-enters the evaluator and inspects the `Result`:

```rust
// (error-guard thunk handler): run (thunk); on a raised error, call (handler msg).
match eval::apply(&thunk, &[]) {
    Ok(v)  => Ok(v),
    Err(e) => eval::apply(&handler, &[Value::Str(e.to_string().into())]),
}
```

That's the core of a roughly 30-line function. It changes **zero** evaluator code —
no new keyword, no continuation surgery, no CEK invariants to preserve — and because
builtins are shared across engines, both the tree-walker and the VM get recoverable
errors for free from one definition. It's the same instinct that put the entire HTTP
protocol in `http.lisp` rather than Rust: add the *smallest* primitive, then express
everything else on top of it. The whole HTTP layer now wraps risky operations in
`error-guard` to turn raised network failures into ordinary values — a result alist
instead of an aborted process — without the language ever growing exceptions.

The server's accept path leans on this hard. Each connection's handling is wrapped
so a malformed client yields a best-effort error response instead of throwing out of
the loop, with a nested guard around even the 500 fallback:

```lisp
(def http--serve-connection
  (lambda (sock handler)
    (error-guard
      (lambda ()
        (tcp-set-timeout sock http--server-timeout)
        ;; ... parse request, call handler, write response, close ...
        )
      ;; On ANY failure (parse/handler/socket), try a 500 then swallow.
      (lambda (m)
        (error-guard (lambda () (http--send-error sock 500))
                     (lambda (m2) ()))))))
```

## The O(n²) read loop, fixed in Rust

The v1 risp HTTP reader had a quadratic bug hiding in plain sight. To find the
`\r\n\r\n` that ends the header block, it read 4 KB at a time and, on every chunk,
**re-concatenated the entire accumulated buffer** and rescanned it from the start.
For a large response that's O(n²): each of the *n*-byte buffer's growth steps
recopies everything read so far.

The fix was to move the read-until-delimiter loop into a Rust primitive,
`tcp-read-until`, which scans only the **newly arrived** region each iteration — the same single-allocation, one-pass discipline explored in [fusing map, filter, and fold](/en/blog/fusing-map-filter-fold-into-one-pass/). It
tracks a search-start offset and, crucially, backs that offset up by `delim.len()-1`
before each new read, so a delimiter that straddles a read boundary is still found.
The whole thing accumulates into a single `Vec<u8>` — linear, no re-concat. Its
counterpart `tcp-read-exact` fills to an exact byte count for the body, again with
no rescanning. From Lisp, the header read is now one call that the builtin keeps
linear, with an oversize cap baked in:

```lisp
;; Read the head up to the blank line; oversize -> the builtin raises.
(let ((raw (tcp-read-until sock "\r\n\r\n" max-header)))
  (let ((sep (bytes-index raw "\r\n\r\n")))
    ;; ...
    ))
```

This connects to a representation decision I deliberately did **not** revisit.
risp's bytes stay an immutable `Rc<[u8]>` rather than a mutable growable buffer.
The one reason you'd reach for mutability is exactly this O(n) accumulation — but
introducing a mutable heap object would make bytes the lone mutable value in an
otherwise all-immutable value system, breaking the language's consistency. The
performance you'd want mutability for was instead recovered *inside* the Rust
primitives: `tcp-read-until` and `tcp-read-exact` do their accumulation in one
private `Vec<u8>` and hand back an immutable result. Immutability costs nothing in
throughput and keeps the language honest.

## Timeouts close the #1 production gap

The single biggest gap between "works" and "production" wasn't TLS — it was
timeouts. A blocking `connect` to a black-hole IP hangs for minutes; a read against
a slow or malicious server that sends one byte an hour wedges a *single-threaded*
interpreter forever. So `tcp-connect` now resolves the host via `ToSocketAddrs` and
dials with `connect_timeout(30s)` over the resolved addresses, and `tcp-set-timeout`
sets the read **and** write deadlines (with `0` meaning none) so neither half of a
stalled exchange can pin the process. The client wires a 30-second default through
every request; the server applies a tighter 10-second per-connection read timeout as
a slowloris guard:

```lisp
;; Default option values, overridable via the per-call opts alist.
(def http--default-timeout 30000)
(def http--default-max-redirects 5)
(def http--default-max-body 33554432)   ; 32 MiB
(def http--default-max-header 65536)    ; 64 KiB
```

I want to be honest about the ceiling these timeouts sit under: risp is
single-threaded, so the server handles exactly one connection at a time. That's a
hard limit of the interpreter, not something this pass pretends to fix — the client
is the realistic production artifact, and the server is "real, but serial." Keep-
alive is likewise a deliberate non-goal here; every request and response carries
`Connection: close`, which is correct, just not optimal. These two "no"s in the
production matrix are design choices, written down rather than hidden.

## Verified green, both configs

The pass is done and was independently verified on 2026-06-18, on both build
configurations:

- **Zero-dep default intact.** `cargo tree` on a default build shows `risp v0.1.0`
  standing alone — no external crates — and `cargo build`, `--features tls`, and
  `--features jit` all finish. The aws-lc-rs/cmake toolchain never crept in; the
  ring provider kept the TLS build portable.
- **Tests green.** On the default build: lib **48**, integration **75** (up from
  the prior **61**, i.e. +14 production tests covering redirects, size caps, chunked
  decode, POST echo, and the server handlers), vm **14**, doctest **1** — zero
  failures. Under `--features tls`: lib **49** (the hermetic
  `tls_read_write_dispatch_hermetic` test passes by pushing bytes through the real
  `tcp-write`/`tcp-read` builtins over the Tls variant, no network), integration
  **75**, vm **14** — zero failures.
- **Real HTTPS works.** The live check `(http-status (http-get "https://example.com/"))`
  returns **200** under `--features tls`, exercising a genuine handshake against
  `example.com:443` through the ring provider and bundled webpki roots.
- **clippy clean on both configs** — zero warnings on default and on `--features tls`.
