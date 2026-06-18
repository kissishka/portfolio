---
title: "The on-page ceiling: GEO is mostly off your site"
description: "This blog scores 93 on technical foundations and 86 on structured data but only 59 overall — because the project name collides with a famous one, and entity authority is earned off-site, not in your own markup."
pubDate: 2026-06-18
tags: ["geo", "seo"]
faq:
  - q: "Why is my GEO score low even with strong on-page SEO?"
    a: "On-page work has a ceiling. This site scores 93 on technical foundations and 86 on structured data but only 59 overall, because the largest remaining factor is off-site entity authority — third-party mentions, an indexed repository, and a knowledge-graph entry — none of which live in your own markup."
  - q: "What is an entity name collision in SEO?"
    a: "A name collision is when your project or brand name already resolves to a different, better-known entity. Here, 'risp' surfaces Stepan Parunashvili's 2019 'Risp (in (Rust) (Lisp))' instead of this project, so an AI asked about 'risp' answers about the older one. The fix is to disambiguate with unique long-tail framing before chasing mentions."
  - q: "How do you build off-site authority for AI search?"
    a: "Disambiguate the name first, then earn mentions that tie back to your canonical entity, then reconcile a Wikidata item against your verified sameAs profiles. Order matters: seeding mentions of an ambiguous name reinforces the entity you collide with rather than your own."
---

After the schema, the citable writing, and the crawler plumbing were all done
and verified live, this site re-ran its GEO audit. The most useful number the
effort produced is the one that refuses to go up.

## A 93 and an 86 that still net 59

The on-page categories are nearly maxed. Technical foundations scored **93**,
structured data **86** — both confirmed serving in production. And the composite
landed at **59**. The gap isn't a bug to fix in the markup; it's the shape of
GEO. Two categories you *can't* edit in your own repo dominate the rest:

| Category | Score |
|---|---|
| Technical foundations | 93 |
| Structured data | 86 |
| Content / E-E-A-T | 73 |
| AI visibility | 55 |
| **Brand authority** | **14** |

Brand authority at **14** is the whole story. The `sameAs` anchors are live, the
repository is public and linked from every post — but it isn't indexed yet, and
there are no third-party mentions. On-page work *qualifies* you to be cited; it
can't *make* you cited.

## The finding the on-page work couldn't see: a name collision

Searching `risp Lisp Rust` doesn't surface this project. It surfaces **Stepan
Parunashvili's "Risp (in (Rust) (Lisp))"** from 2019 — multiple Hacker News
front pages, indexed for years. An AI asked about "risp" today answers about
*that* one. No amount of [perfect schema](/en/blog/structured-data-that-makes-a-blog-ai-quotable/)
or [citable prose](/en/blog/writing-so-an-ai-will-cite-you/) outranks an entity
the model already knows. This reframes the top priority from "get mentions" to
**"disambiguate first, then get mentions."**

## The remaining points aren't code

The path from 59 to "good" runs entirely off the site, in order:

1. **Disambiguate** — lead every title and share with unique long-tail framing
   ("zero-dependency three-engine Lisp in Rust, beats CPython 3.14") that the
   2019 project can't claim.
2. **Seed mentions** that each link back to the canonical repo, so the entity
   graph resolves to *this* risp — not the other one.
3. **A Wikidata item**, reconciled against the GitHub and LinkedIn `sameAs`
   already in the schema.

The markup is the easy half — you can finish it in a weekend, and this site did.
Authority is earned off your own domain, it takes longer, and no
`<script type="application/ld+json">` shortcuts it.
