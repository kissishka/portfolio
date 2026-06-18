---
title: "Structured data that makes a blog AI-quotable"
description: "The JSON-LD that turns a static blog into an entity AI search can resolve: one Person + WebSite graph shared byte-for-byte across both locales, and a per-post BlogPosting carrying FAQPage, speakable, and a link to the source it describes."
pubDate: 2026-06-18
tags: ["geo", "seo", "schema"]
faq:
  - q: "What structured data should a blog use for AI search?"
    a: "At minimum a Person or Organization node with sameAs links to your verified profiles, a WebSite node, and a BlogPosting on every article. This site also emits FAQPage for answer extraction, speakable to mark the quotable passages, and isBasedOn to tie a post to the source code it describes."
  - q: "Does JSON-LD have to be identical on every page?"
    a: "No, but the identity graph can be. This site inlines a byte-identical Person + WebSite graph on every page in both languages, which lets a single Content-Security-Policy hash cover all of it. The per-post BlogPosting block is dynamic and, as an application/ld+json data block, is not governed by CSP script-src at all."
  - q: "What is the speakable property in schema.org?"
    a: "speakable lists the CSS selectors whose text is best suited to be read aloud or quoted by voice and answer engines. This blog points it at the h1, the lede paragraph, and the FAQ section, so an assistant extracts the self-contained core of a page rather than its navigation or boilerplate."
---

An AI search engine doesn't read a blog so much as scan it for machine-readable
claims: who published this, and what each page is. Where the markup is silent,
it guesses. This site states it outright in JSON-LD.

## One identity graph, shared across both locales

The site's whole identity is one `@graph`: a `Person` whose `sameAs` array is
the set of profiles that anchor the entity, plus a `WebSite`. It ships
byte-for-byte identical on every page, in English and Ukrainian alike:

```json
{ "@context": "https://schema.org", "@graph": [
  { "@type": "Person", "name": "Roman Kocherezhchenko",
    "jobTitle": "AI-Enabled Engineer",
    "url": "https://roman-kocherezhchenko.com",
    "sameAs": ["https://t.me/roman_kocherezhchenko",
               "https://github.com/kissishka",
               "https://www.linkedin.com/in/..."] },
  { "@type": "WebSite", "inLanguage": ["en", "uk"], "...": "..." } ] }
```

The `sameAs` links are the load-bearing part: they tell a model that the
Telegram, GitHub, and LinkedIn accounts are the *same* entity as the author of
every post. And because the graph is identical everywhere, a single
Content-Security-Policy hash covers it on all pages — the schema is content, not
per-page chrome.

## Every post is a BlogPosting that points at its evidence

Each article emits its own `BlogPosting`, and two fields do the AI-specific
work:

```js
speakable: { "@type": "SpeakableSpecification",
             cssSelector: ["h1", ".post__lede", ".faq"] },
isBasedOn: { "@type": "SoftwareSourceCode", name: "risp",
             codeRepository: input.repo, programmingLanguage: "Rust" },
```

`speakable` hands an answer engine the exact selectors holding the quotable
core. `isBasedOn` ties a post's claims to inspectable source — the
[risp performance posts](/en/blog/cranelift-jit-for-a-lisp-in-rust/) link their
repository this way, so a model can follow a benchmark number to the code that
produced it. (This post omits `isBasedOn` rather than mislabel its own source as
risp.)

## FAQPage, because answer engines extract Q&A

A short `faq:` block in the post's frontmatter renders as a visible FAQ *and*
serializes into a `FAQPage` node — each pair becoming a `Question` with an
`acceptedAnswer`. Answers are kept as plain text so they survive the trip into
structured data intact.

The pattern underneath all three: say, in machine-readable terms, the one thing
you want quoted — who you are, what this page claims, and where the proof lives.
Don't make the model infer what you could have declared.
