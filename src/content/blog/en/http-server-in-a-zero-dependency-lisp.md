---
title: "An HTTP/1.1 client and server in risp, a zero-dependency Lisp in Rust"
description: "risp — a zero-dependency Lisp in Rust, not the 2019 tutorial — gains a full HTTP/1.1 client and server written almost entirely in Lisp, with zero external crates."
pubDate: 2026-06-18
tags: ["rust", "lisp", "http"]
repo: "https://github.com/kissishka/risp"
faq:
  - q: "Can you write an HTTP server without any dependencies?"
    a: "Yes. risp's HTTP/1.1 client and server are written almost entirely in Lisp, on top of only a Bytes value type and roughly 20 socket and string builtins added to its Rust core. Because std::net is part of Rust's standard library, a default cargo build still resolves zero external crates."
  - q: "How much Rust did risp need to add to support HTTP?"
    a: "Two Value enum variants (Bytes and Tcp) touching exactly four sites in value.rs, plus about 20 plain fn(&[Value]) -> RispResult builtins: six TCP sockets, a handful of bytes operations, and the string operations a parser needs. All the protocol logic — request framing, header parsing, chunked decoding — lives in http.lisp, not Rust."
  - q: "Is the risp HTTP server concurrent?"
    a: "No. The server is single-threaded and serves exactly one connection at a time, sending Connection: close on every response with no keep-alive. That is a hard ceiling of the single-threaded interpreter, acknowledged as a design choice rather than an oversight."
---

To be clear about which Lisp this is: [risp](/en/blog/building-a-lisp-in-rust-with-claude-code/)
is a small, homoiconic, std-only Lisp interpreter written in Rust — not the 2019
toy "Risp" blog-post calculator, and not a Common Lisp anything. It has a single
`Value` enum that is both AST and runtime value, three execution engines, and a
charter that a default `cargo build` resolves *zero* external crates ([source on GitHub](https://github.com/kissishka/risp)). This post is
about the week it learned to speak HTTP: a real HTTP/1.1 client and server, with
chunked decoding and a router, written almost entirely *in risp itself* — and the
small, deliberate amount of Rust that made it possible without breaking the
zero-dependency promise.

## Two walls: no transport, no text

The honest first answer to "could you build HTTP in this Lisp?" was *no*, and not
for one reason but two. risp's entire connection to the outside world was three
builtins — `print`, `display`, `newline`. No file I/O, no `read-line`, no sockets,
no FFI to bind a C library, no process-spawn to shell out to `curl`. The
interpreter could compute beautifully and tell you the answer, but it could not
*reach* anything. That's wall one: no transport. You can't speak HTTP if you can't
open a TCP connection, and there was no primitive and no escape hatch to open one.

Wall two was subtler. Suppose bytes did start arriving. risp's strings were
`Rc<str>` — immutable and *opaque*: you could print one or compare two for
equality, and that was the entire API. No `substring`, no `string-index`, no way
to turn a string into bytes or back, and no byte-buffer type at all. So even handed
a populated socket you couldn't assemble a request line or take a response apart.
Two walls, each sufficient on its own to block HTTP. The feature wasn't missing —
the *substrate* was.

## The lazy strategy: smallest Rust surface, protocol in Lisp

The move that made HTTP tractable is the same instinct that puts
[map and filter in a risp prelude rather than in Rust](/en/blog/risp-standard-library-in-lisp-not-rust/):
add the smallest possible native surface, then write everything above it in the
language itself. The new substrate was two `Value` variants — `Bytes(Rc<[u8]>)`
and `Tcp` — plus about twenty plain `fn(&[Value]) -> RispResult` builtins: six
sockets (`tcp-connect`, `tcp-read`, `tcp-write`, `tcp-close`, `tcp-listen`,
`tcp-accept`), a handful of bytes operations (`bytes-ref`, `subbytes`,
`bytes-concat`, `bytes-index`, `bytes->string`, `string->bytes`), and the string
operations a parser actually needs (`substring`, `string-index`, `string->number`,
`string-downcase`).

The byte buffer is the foundation, and `Rc<[u8]>` is chosen for the same reason
every other payload sits behind an `Rc`: one indirection and an O(1) clone.

```rust
pub enum Value {
    // ... Nil, Bool, Int, Float, Str, Symbol, Pair, Builtin, Closure, Macro, Compiled ...

    /// An immutable byte buffer (`Rc<[u8]>` gives one indirection and O(1) clone).
    Bytes(Rc<[u8]>),
    /// A TCP socket handle (stream or listener), opaque and self-evaluating.
    Tcp(Rc<TcpKind>),
}

pub enum TcpKind {
    Stream(std::net::TcpStream),
    Listener(std::net::TcpListener),
}
```

The whole charter rides on one fact: `std::net` is part of `std`. Sockets cost
*zero* dependencies — the same offline `cargo build` that resolved no crates before
still resolves none after. (TLS is the one capability that genuinely *can't* be
std-only, since there is no `std::tls`; it lives behind a `--features tls` flag,
exactly mirroring how risp's Cranelift JIT is quarantined, so the default artifact
stays pure. That story — and the broader hardening work the HTTP stack needed — is
covered in [hardening a hobby interpreter's HTTP stack](/en/blog/hardening-a-hobby-interpreters-http-stack/).)

## Adding a Value variant is a finite, compiler-checked edit

Adding a variant to the central `Value` enum *sounds* terrifying across three
engines — a tree-walker, a [register-cached bytecode VM](/en/blog/no-stack-overflow-lisp-interpreter-rust/),
and an optional JIT. In practice it's a disciplined, bounded edit. There are
exactly **four** sites in `value.rs` you must touch by hand: the enum itself,
`type_name`, the shallow-equality function `risp_eq`, and `write_atom` (the
printer).

```rust
fn type_name(&self) -> &'static str {
    match self {
        // ...
        Value::Bytes(_) => "bytes",
        Value::Tcp(_) => "tcp",
    }
}
```

Everything else is the compiler's problem. This is the underrated joy of exhaustive
`match` in Rust: you don't have to *remember* where a new variant needs handling.
You add it to the enum, run `cargo build`, and the exhaustiveness checker hands you
a punch-list of every site across the tree-walker, the VM, the bytecode layer, and
the JIT that now needs a decision. "Build to green" stops being a hope and becomes
a hard correctness gate. The iterative `Drop` that risp uses to reclaim
million-deep structures needed *no* change at all, because `Bytes` and `Tcp` hold
no nested `Value`s — the existing catch-all reclaims them as leaves.

## All the protocol lives in http.lisp

With the substrate in place, the genuinely fiddly part — request framing,
status-line parsing, header alists, Content-Length and chunked decoding — was
written *in risp*, in a file called `http.lisp` that's `include_str!`'d and
evaluated at interpreter startup right after `prelude.lisp`:

```rust
const PRELUDE: &str = include_str!("prelude.lisp");
self.run_source(PRELUDE).expect("prelude.lisp must evaluate cleanly");
const HTTP: &str = include_str!("http.lisp");
self.run_source(HTTP).expect("http.lisp must evaluate cleanly");
```

The order matters: the prelude installs [`fold`/`map`/`filter`](/en/blog/fusing-map-filter-fold-into-one-pass/), and `http.lisp` is
built on top of them. The payoff of this split is that the Rust side stays tiny and
auditable while the protocol logic lives in a high-level language where it's easy
to read and, crucially, to *change* — and [faster than a native-compiling Lisp](/en/blog/why-cpython-beats-a-native-compiling-lisp/) in some real measurements. Every line of protocol kept out of Rust is a
line that doesn't need a recompile to fix. URL parsing, case-folded header lookup,
the read-until-delimiter loop — all of it is readable Lisp.

A GET request, satisfyingly, is just string concatenation written through
`string-append`, then a socket write of the bytes. Here is the real
request-builder from `http.lisp`:

```lisp
(def http--build-request
  (lambda (method path host extra body)
    (let ((header-lines
            (map (lambda (kv) (string-append (car kv) ": " (cdr kv) "\r\n")) extra)))
      (let ((clen (if (> (string-length body) 0)
                      (string-append "Content-Length: "
                                     (number->string (bytes-length (string->bytes body)))
                                     "\r\n")
                      "")))
        (string-append
          method " " path " HTTP/1.1\r\n"
          "Host: " host "\r\n"
          "Connection: close\r\n"
          (http--apply-concat header-lines)
          clen
          "\r\n"
          body)))))
```

That string then goes out as `(tcp-write sock (string->bytes req))`. Notice the
`\r\n`s. HTTP is a CRLF-framed protocol, and getting those carriage returns onto
the wire turned out to be the project's one genuine war story — the lexer didn't
recognize `\r` as a string escape and silently lexed `"\r"` to a literal `r`, a
dormant bug that no test had ever exercised because, until you're speaking a
CRLF protocol, who types `\r` into a string? A round-trip integration test caught
in seconds what years of unit tests never thought to assert.

## A response is an alist; chunked decoding is a Lisp loop

On the way back, a response is parsed into an **alist** and read with five
accessors — `http-status`, `http-reason`, `http-body`, `http-header`, and
`http-final-url`:

```lisp
(def resp (http-get "http://example.com/"))
(http-status resp)                   ; => 200
(http-reason resp)                   ; => "OK"
(http-body resp)                     ; => "<!doctype html>…"
(http-header resp "content-type")    ; => "text/html; charset=UTF-8"  (case-insensitive)
```

The interesting framing case is `Transfer-Encoding: chunked`. Each chunk is a
hex size line, then that many data bytes, then a CRLF, repeated until a zero-size
chunk ends the body. `http--decode-chunked` parses the sizes with `parse-hex` and
assembles the body over the O(n) socket primitives, ignoring trailers after the
final chunk:

```lisp
(def http--decode-chunked
  (lambda (sock buf max out total)
    (let ((b (http--ensure-crlf sock buf)))
      (let ((nl (bytes-index b "\r\n")))
        (if (< nl 0)
            (error "malformed chunked body: no size line") ; truncated
            (let ((size (parse-hex (bytes->string (subbytes b 0 nl)))))
              (if (= size 0)
                  (bytes-concat (reverse out)) ; last chunk; done
                  ;; ... read `size` data bytes + CRLF, recurse with a bigger `out`
                  )))))))
```

Two things make this safe rather than naïve. The size-line parse leans on
`parse-hex`, which stops at the first non-hex character, so a chunk-size line
carrying a `;ext` parameter or a trailing `\r` still parses correctly. And the
decoder threads a running `total` against `max`, raising
`"response body exceeded max-body"` the moment a hostile server's chunk sizes
would push the assembled body past the cap. The header scans are deliberately
naïve O(n·m) string searches — but they only ever run over header-sized data; the
*body* framing is the part that has to be O(n), and it is, because the actual
read loops (`tcp-read-until`, `tcp-read-exact`) live in Rust where they scan only
newly-arrived bytes instead of re-concatenating the whole buffer per chunk.

## The server is single-threaded by the interpreter's nature

The server side — `http-serve`, `http-serve-once`, and `make-router` — is shaped
entirely by the fact that risp is single-threaded. There is no thread pool to hand
a connection to, so the accept loop serves exactly one connection at a time and
every response carries `Connection: close`; there is no keep-alive. This is a hard
ceiling of the single-threaded interpreter, and the docs name it as a design
choice rather than an oversight. `http-serve` is literally a bind, then a
tail-recursive accept-and-serve loop:

```lisp
(def http-serve
  (lambda (port handler)
    (let ((listener (tcp-listen "127.0.0.1" port)))
      (def loop
        (lambda ()
          (let ((sock (tcp-accept listener)))
            (http--serve-connection sock handler)
            (loop))))
      (loop))))
```

Routing is just as small. `make-router` takes a list of `(method path handler)`
triples and returns a handler that matches on method **plus the exact path**, with
an automatic 404 for anything that doesn't match:

```lisp
(def make-router
  (lambda (routes)
    (lambda (req)
      (let ((method (http--get req 'method ""))
            (path (http--get req 'path "/")))
        (let ((route (http--match-route routes method path)))
          (if (null? route)
              (list (cons 'status 404)
                    (cons 'headers (list (cons "Content-Type" "text/plain")))
                    (cons 'body "Not Found"))
              ;; route is (method path handler); call the handler with the req.
              ((car (cdr (cdr route))) req)))))))
```

Exact-match only — no `/users/:id` params, no wildcards, no trailing-slash
normalization in v1. A handler returns either a plain string (which becomes a
`200 text/plain`) or a full response alist with `status`, `headers`, and `body`
for any status code. The whole per-connection path is wrapped in `error-guard`, so
a malformed client yields a best-effort 400 or 500 instead of throwing out of the
accept loop and killing the server.

## Testing without the network

If the interpreter internals are new to you, [learn Rust by reading a Lisp interpreter](/en/blog/learn-rust-by-reading-a-lisp-interpreter/) is a good primer on how the engine is structured before diving into the networking layer.

A networking library you can only test against the live internet is a flaky one,
so the tests are **hermetic** — no external hosts, deterministic, safe in CI. For
the client that's easy: spin up a canned server on a background `std::thread` bound
to `127.0.0.1:0` (so the OS hands you a free port), have it accept one connection
and write a fixed `HTTP/1.1 200 OK\r\nContent-Length: 5\r\n\r\nhello`, then drive
risp's `http-get` against it and assert on the parsed status and body.

The server is the harder direction, because it runs straight into the
single-threaded limit: you can't have risp's `http-serve-once` block on `accept`
while *also* driving a client from the same interpreter. The trick is to pick a
free port by binding a probe listener and immediately dropping it, spawn a
Rust-thread client that connects **with retry** — looping briefly until the connect
succeeds — and let risp bind that same port and serve. The retry-connect loop
closes the tiny race between dropping the probe and risp re-binding. It keeps the
whole thing single-interpreter and deterministic.
