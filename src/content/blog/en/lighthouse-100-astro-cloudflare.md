---
title: "How this site scores Lighthouse 100 on mobile"
description: "A static Astro build, zero client framework, and a strict CSP — the three decisions that keep all four Lighthouse categories pinned at 100."
pubDate: 2026-05-12
updatedDate: 2026-05-30
tags: ["astro", "performance"]
---

The release gate for this site is blunt: **Lighthouse 100 / 100 / 100 / 100 on
mobile**, run against production. Here is what actually keeps it there.

## Ship almost no JavaScript

The fastest script is the one you never send. This whole site ships two tiny
inline boot scripts and two small same-origin modules — the theme toggle and the
language switcher. Everything else is static HTML and one hand-written
stylesheet. There is no client framework to hydrate, so Total Blocking Time
stays at zero.

## Make the strict CSP a build-time invariant

Best Practices drops the moment the console logs a Content-Security-Policy
violation. Rather than hope, the build *fails* if any inline script isn't
covered by a hash:

```js
// astro.config.mjs
security: {
  csp: {
    algorithm: "SHA-256",
    scriptDirective: { hashes: SCRIPT_HASHES },
  },
}
```

A `postbuild` step re-hashes every inline script in `dist/` and asserts the
hash is present in that page's CSP `<meta>`. Drift becomes a red build, not a
silent regression in the field.

## Reserve space for everything

Cumulative Layout Shift is mostly about fonts and images. Fonts load with
`font-display: optional` and `unicode-range`-scoped subsets, so a glyph swap
never reflows the page. Images carry explicit dimensions. The hero — the LCP
element — is never animated.

None of this is exotic. It is the same handful of decisions applied
consistently, and verified on every build instead of trusted.
