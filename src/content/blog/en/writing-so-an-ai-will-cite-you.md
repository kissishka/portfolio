---
title: "Writing so an AI will cite you"
description: "Citability is mechanical: lead with a self-contained answer, name the subject in every sentence, attach the number, and tie each claim to inspectable source. Here is how this blog earns the quote."
pubDate: 2026-06-18
tags: ["geo", "seo"]
faq:
  - q: "How do you write content that AI search engines will cite?"
    a: "Lead each page with a one-sentence answer that names its own subject, keep claims self-contained so a passage still makes sense lifted out of context, attach concrete numbers, and link each claim to inspectable evidence. Avoid pronouns like 'it' and 'this' that only resolve from an earlier paragraph."
  - q: "Why does this blog put the post's description in the first paragraph?"
    a: "The frontmatter description is rendered as the visible lede and is one of the selectors named in the schema.org speakable property. Writing it as a complete, standalone answer means the passage an answer engine is most likely to lift is also the one that best summarizes the post."
  - q: "Does linking to source code improve AI citability?"
    a: "It improves verifiability, which answer engines weigh when deciding what to trust. Each risp post links its GitHub repository as both a visible Source link and a schema.org isBasedOn SoftwareSourceCode node, so a model can follow a performance claim straight to the code and benchmark that produced it."
---

A model choosing what to quote does extractive selection: it lifts the one
sentence that answers the prompt and still stands once it's lifted. So
citability is mechanical — properties you build into every paragraph,
deliberately, not a tone you reach for.

## Lead with the answer, and make the answer the lede

The frontmatter `description` on this post is not marketing — it's the answer,
written to stand alone. The page renders it as the visible `.post__lede`, and
[the schema names that exact selector as speakable](/en/blog/structured-data-that-makes-a-blog-ai-quotable/).
So the passage an engine is most likely to quote and the passage that best
summarizes the post are *the same string*. Write it once, well.

## Name the subject; kill the pronoun

A quoted sentence loses its antecedents. "It runs about 10× faster" is useless
out of context; the [JIT post](/en/blog/cranelift-jit-for-a-lisp-in-rust/)
instead writes the self-contained version, and it's the one that gets lifted:

> risp's opt-in Cranelift JIT runs `fib` about 10× faster than CPython 3.14
> (6.3 ms vs 61 ms).

Subject named, number attached, true on its own. Every FAQ answer on this site
is written to the same test: cover the dt, and the dd still makes sense.

## Tie the claim to something inspectable

A number a model can't verify is a number it will hedge around. Every risp post
links its source repository as a visible **Source** link *and* as an
`isBasedOn` `SoftwareSourceCode` node, so the path from "42× faster" to the
`agree()` differential test that proves it is one click — for a reader or a
crawler. The benchmark suite is in the repo, not just asserted in prose.

So write every sentence as if it will be quoted with no paragraph around it.
The ones that read true alone are the ones that get cited.
