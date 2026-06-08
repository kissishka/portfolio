---
title: "Edge deploys on Cloudflare that just work"
description: "Headers, redirects, and caching belong at the edge — not in your application code. A look at the small config files that do the heavy lifting."
pubDate: 2026-05-26
tags: ["cloudflare", "performance"]
---

When a static site deploys to Cloudflare Pages, the most important files aren't
in your `src/` directory — they're two plain-text files in `public/` that the
edge reads directly.

## Redirect at the edge, not in the app

The root `/` should land on `/en/`. You *could* emit an Astro redirect page,
but that's a round trip to a static file before the browser bounces. A
`_redirects` rule terminates at the edge instead:

```text
/  /en/  302
```

## Set security headers once

Anything that can't live in a `<meta>` tag — HSTS, framing, MIME sniffing —
goes in `_headers`, applied to every response by the edge:

```text
/*
  Strict-Transport-Security: max-age=31536000; includeSubDomains; preload
  X-Content-Type-Options: nosniff
  X-Frame-Options: DENY

/fonts/*
  Cache-Control: public, max-age=31536000, immutable
```

Content-hashed assets get a long immutable cache; fonts, which aren't hashed,
get one explicitly.

## Pin your build config

The one deploy failure mode worth guarding against is a build that succeeds
locally but stalls remotely. Commit your `wrangler.jsonc` so the remote build
uses exactly the config you tested — don't let it infer one. A deploy you can't
reproduce is a deploy you don't control.

The pattern underneath all three: push configuration to the layer closest to
the user, and keep your application code about content.
