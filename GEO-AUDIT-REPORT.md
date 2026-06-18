---
brand_name: Roman Kocherezhchenko
domain: roman-kocherezhchenko.com
geo_score: 62
date: 2026-06-18
audit_target: local build (dist/) + existing report
previous_score: 51
---

# GEO Audit — roman-kocherezhchenko.com

**Composite GEO Score: 62/100 — Fair (upper end)** &nbsp;·&nbsp; previous audit: 51/100

| Category | Weight | Score | Weighted | Δ vs prev |
|---|---|---|---|---|
| AI Citability & Visibility | 25% | 58 | 14.5 | +6 |
| Brand Authority Signals | 20% | 24 | 4.8 | +16 |
| Content Quality & E-E-A-T | 20% | 73 | 14.6 | +15 |
| Technical Foundations | 15% | 93 | 14.0 | +2 |
| Structured Data | 10% | 86 | 8.6 | +28 |
| Platform Optimization | 10% | 60 | 6.0 | +7 |
| **Total** | | | **62** | **+11** |

## The one-line diagnosis

The previous audit's on-site action list is **done** — repo published and linked, entity graph expanded, author layer shipped, schema gaps closed — and the risp series grew 5 → 8 deep-dive posts. The score rose 51 → 62 almost entirely on in-repo work. What's left is off the domain: the entity still has **no Wikidata item and no third-party mentions**, which caps Brand Authority and the off-site-gated platforms. Content and schema are now solid; the remaining gap is off-domain visibility.

## What changed since the last audit (verified in the build)

- **Source repo is now an entity anchor.** Every post emits `isBasedOn` → `SoftwareSourceCode` pointing at `github.com/kissishka/risp`, and the repo is a real, indexable, AI-citable artifact. This was the #1 lever last time; it's now live.
- **`sameAs` 1 → 3.** Telegram + **GitHub** + **LinkedIn** (`src/lib/jsonld.ts`). Feeds ChatGPT/Gemini/Bing/Perplexity entity resolution at once.
- **Author identity shipped.** `/en/about` + `/uk/about` exist, and a visible **byline renders** on every post (was schema-only before). Person schema on home and About.
- **Schema gaps closed.** `WebSite` schema present, `speakable` present, `FAQPage` on **all 8** risp posts, BreadcrumbList intact. The two named Schema gaps from last time are gone — this is the biggest single jump (+28).
- **Series depth.** 3 new deep-dives — the **reader** (`writing-a-lisp-reader-in-rust`), **lexical scope** (`lexical-scope-in-a-rust-lisp`), and the **self-hosted prelude** (`risp-standard-library-in-lisp-not-rust`) — each bilingual, FAQ-backed, repo-linked, and listed in `llms.txt`.
- **Minor nits fixed.** Homepage meta description now ~155 chars (was ~47); root `/` → `/en/` is now **301** (was 302).

## What's still excellent (don't touch)

- **Technical: 93/100.** Full SSR, security headers, valid hreflang, per-post sitemap `lastmod`, 301 root, low CWV risk. Crawlers see everything; zero JS dependency.
- **AI crawler access: 100/100.** Blanket `Allow: /` — every AI bot permitted; `llms.txt` curates the series for them.
- **Blog citability ~84.** Answer-style intros, dense benchmark tables, on-page FAQ mirrored into `FAQPage` JSON-LD, source repo tied to every claim. Eight of these now, heavily cross-linked.
- **Content craft.** Original benchmarks, named regressions, honest limits ("the one shape it couldn't win"). Genuine practitioner writing, verifiable against linked source.

## Prioritized action plan

### Off-site — where the remaining ~25 points live (not code)
1. **[CRITICAL] Seed community mentions.** Submit "beat CPython 3.14" + the Cranelift-JIT post to Hacker News, Lobsters, r/rust, r/ProgrammingLanguages. Now that the repo is public this is the largest unrealized lever: it moves Brand Authority 24 → 45+ and lifts Perplexity/Gemini/Bing together.
2. **[HIGH] Create a Wikidata item** for the person + project. Most direct path into Google's Knowledge Graph and cross-model entity recognition. The GitHub + LinkedIn `sameAs` anchors are now in place to reconcile against.
3. **[MEDIUM] Make the GitHub repo itself GEO-grade** — a README with a definitional opening line, the benchmark table, and links back to the posts. The repo is now cited *by* the site; make it cite back.

### On-site — small, cheap, remaining
4. **[HIGH] Add a "What is risp?" definitional block to the homepage.** The home URL is still ~22 citability (risp appears only in the meta description, not an extractable on-page Q&A). One answer-style block makes the canonical URL itself AI-quotable.
5. **[MEDIUM] Deepen the About page.** It exists but is ~184 words with no explicit credentials. A short "experience / what I've built / how to verify" section converts identity into E-E-A-T authoritativeness (the sub-score still dragging Content).
6. **[LOW] Generate `/llms-full.txt`** (full-text companion to `llms.txt`), add `Content-Signal:` to robots.txt, and confirm Bing Webmaster + IndexNow on Cloudflare for instant recrawl on deploy.

## Per-category scores

| Category | Score | Headline |
|---|---|---|
| AI Visibility | 58 | On-page citability high across 8 posts; homepage block + off-site mentions are the cap |
| Brand Authority | 24 | Repo + 2 new `sameAs` anchors raise it from baseline; no Wikidata / mentions yet |
| Content E-E-A-T | 73 | Content 80+, author layer now real; thin About bio is the remaining drag |
| Technical | 93 | No critical issues; 301 + per-post lastmod tidy the last nits |
| Schema | 86 | `WebSite` + `speakable` + `sameAs`×3 + `FAQPage`×8 + `isBasedOn` — gaps closed |
| Platform (avg) | 60 | AIO strongest; Perplexity/Gemini still gated by off-site footprint |

**Bottom line:** The in-repo build is now in good shape — schema, author identity, and content all moved up, and the source repo is wired through everything. The score is capped, as before, by what isn't on the domain: get the posts cited somewhere AI models read (HN/Reddit/Lobsters) and stand up a Wikidata item, and 62 → 75 (Good) is reachable without touching the code. The only on-site points left are the homepage definitional block and a deeper About bio.

---
<sub>Audit scope: local production build in `dist/` (the 3 new posts are not yet deployed) plus the prior report. Brand-authority off-site signals (Wikidata, HN/Reddit/Lobsters mentions) are assessed as unchanged from baseline — they can't be verified from a local build; only the in-build GitHub anchor is confirmed present. Re-run against the live URL after deploy to validate off-site movement.</sub>
