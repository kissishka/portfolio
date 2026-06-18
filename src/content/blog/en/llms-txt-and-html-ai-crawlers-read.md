---
title: "llms.txt, robots, and the HTML that AI crawlers actually read"
description: "An AI crawler can only cite what it can fetch and parse. This blog ships near-zero client JS, an open robots.txt, per-post sitemap lastmod, hreflang that never points at a 404, and an llms.txt map of the whole series."
pubDate: 2026-06-18
tags: ["geo", "seo", "astro"]
faq:
  - q: "What is an llms.txt file?"
    a: "llms.txt is a plain-Markdown file at the site root that gives AI systems a curated map of the most important pages with a one-line description of each. This site's llms.txt lists the full risp series, the source repository, and the contact and index pages, and states that the English pages are canonical."
  - q: "Do AI crawlers run JavaScript?"
    a: "Generally no. Most AI crawlers fetch raw HTML and do not reliably execute client-side JavaScript. This blog ships effectively zero client JS and renders every page to static HTML at build time, so a crawler sees the full content, navigation, and structured data on the first fetch."
  - q: "How should hreflang be configured on a bilingual site?"
    a: "Every hreflang alternate must resolve to a real page; a single 404 target or a missing return link invalidates the whole cluster. This site advertises only the locales a given page actually has, plus an x-default, so an untranslated post never points a search engine at a missing translation."
---

Citability and schema only matter if a crawler gets the bytes in the first
place. Most AI crawlers don't run JavaScript and don't come back twice — they
fetch once, parse the HTML, and move on. So the job is to make one plain fetch
return everything.

## Render to HTML; ship almost no JavaScript

Every page is static HTML at build time, with two tiny inline scripts (theme,
language) and nothing to hydrate. Even syntax highlighting is build-time —
`syntaxHighlight: "prism"` emits class names, not a client script — so a crawler
that ignores JS still sees the full post, the nav, and the JSON-LD. Nothing
important is behind a render.

## Open the door in robots.txt, then hand over a map

`robots.txt` allows everyone and points at an absolute sitemap URL — no AI
crawler is special-cased out:

```text
User-agent: *
Allow: /

Sitemap: https://roman-kocherezhchenko.com/sitemap-index.xml
```

Then `/llms.txt` does what a sitemap can't: it *curates*. A blockquote summary,
a "the English pages are canonical" note, and a hand-written one-liner for each
post tell a model what the site is about and which URLs are worth reading —
instead of making it reverse-engineer that from raw routes.

## Make hreflang and lastmod tell the truth

A bilingual site lives or dies on hreflang correctness: **one 404 alternate
invalidates the whole cluster.** So a page advertises only the locales it
actually has, computed per post, plus `x-default`:

```astro
const localeAlternates = [
  ...availableLocales.map((loc) => ({ hreflang: loc, href: `${origin}/${loc}/${suffix}` })),
  { hreflang: "x-default", href: `${origin}/${xDefaultLocale}/${suffix}` },
];
```

The sitemap is just as literal. The integration only sees URLs, so the build
reads each post's frontmatter and stamps a real `lastmod` from `updatedDate ??
pubDate` — and leaves index and tag pages bare rather than lie with a build
date:

```js
serialize(item) {
  const lastmod = BLOG_LASTMOD.get(new URL(item.url).pathname);
  if (lastmod) item.lastmod = lastmod;
  return item;
}
```

A crawler trusts what it can verify cheaply: serve the whole page in one fetch,
point it at the URLs that matter, and never advertise one that 404s.
