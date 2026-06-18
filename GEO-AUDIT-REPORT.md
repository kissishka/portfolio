---
brand_name: Roman Kocherezhchenko
domain: roman-kocherezhchenko.com
geo_score: 59
date: 2026-06-18
audit_target: live URL (https://roman-kocherezhchenko.com)
baseline_score: 51
local_estimate: 62
---

# GEO Audit (live) — roman-kocherezhchenko.com

**Composite GEO Score: 59/100 — Fair** &nbsp;·&nbsp; baseline: 51 &nbsp;·&nbsp; local-build estimate: 62

| Category | Weight | Score | Weighted | Δ vs baseline |
|---|---|---|---|---|
| AI Citability & Visibility | 25% | 55 | 13.75 | +3 |
| Brand Authority Signals | 20% | 14 | 2.8 | +6 |
| Content Quality & E-E-A-T | 20% | 73 | 14.6 | +15 |
| Technical Foundations | 15% | 93 | 14.0 | +2 |
| Structured Data | 10% | 86 | 8.6 | +28 |
| Platform Optimization | 10% | 54 | 5.4 | +1 |
| **Total** | | | **59** | **+8** |

This is the live re-run the local audit asked for. It lands at **59, not the local-build estimate of 62** — the on-page work all verified, but the live searches show off-site Brand Authority is weaker than a local build could reveal. The local audit credited the published repo as an entity anchor; in reality it isn't indexed yet, and the project name **collides** with a well-known one.

## The finding the local audit couldn't see: a name collision

Searching `risp Lisp Rust` / `risp beat CPython` surfaces **Stepan Parunashvili's "Risp (in (Rust) (Lisp))"** (2019, multiple Hacker News front pages, Medium) plus several other `risp` repos — never `kissishka/risp`. An AI asked about "risp" today resolves to *those*, not this project. This caps discoverability no matter how good the on-page content is, and it reframes the #1 off-site task from "get mentions" to "**disambiguate first, then get mentions**."

Live entity searches returned **zero** footprint for this project: no result for `"Roman Kocherezhchenko" risp`, no Wikidata/Wikipedia, no surfaced LinkedIn, and `kissishka/risp` not indexed in search despite being **public (HTTP 200)** and linked from every post.

## Verified live (deployed state matches the build)

- **Schema served:** homepage JSON-LD returns `Person`, `WebSite`, and `sameAs` = Telegram + `github.com/kissishka` + LinkedIn. `FAQPage` + `isBasedOn` → `SoftwareSourceCode` on all 8 risp posts.
- **All 8 posts + both locales return 200**, SSR, valid hreflang, per-post `lastmod`, 301 root. Crawlers see everything; zero JS dependency.
- **`llms.txt` live** lists the full 8-post series.
- **Repo is public and linked**, so the anchor exists — it just hasn't propagated into any index or third-party page.

## Why each category moved (live vs local estimate)

- **Brand Authority 24 → 14.** The local audit over-credited "repo published." Live: public + linked earns a little over the 8 baseline, but no indexing, no mentions, and the name collision hold it down hard.
- **AI Visibility 58 → 55.** On-page citability is unchanged and strong; the *visibility* half is confirmed near-zero and actively suppressed by the collision.
- **Platform 60 → 54.** Off-site-gated engines (Perplexity, Gemini) are confirmed gated by the absent footprint.
- **Technical 93, Schema 86, E-E-A-T 73, on-page Citability** — all confirmed live, unchanged from the local audit.

## Prioritized action plan

### Off-site — where the remaining points are (not code)
1. **[CRITICAL] Disambiguate the project.** This is now ahead of "seed mentions," because mentions of "risp" reinforce the *other* project. Options: sub-brand consistently (e.g. "risp by Roman Kocherezhchenko", or a distinct name like `risp-rs`), and lead every title/H1/share with unique long-tail framing — "zero-dependency three-engine Lisp (tree-walker + bytecode VM + Cranelift JIT) in Rust, beats CPython 3.14." Own phrases the 2019 project can't.
2. **[CRITICAL] Then seed mentions** with that disambiguated framing + the repo link: Hacker News, Lobsters, r/rust, r/ProgrammingLanguages. Each mention must tie to `kissishka/risp` so the entity graph resolves to *this* risp.
3. **[HIGH] Wikidata item** for person + project, reconciled against the GitHub + LinkedIn `sameAs` anchors already live in the schema.
4. **[MEDIUM] Make the repo discoverable** — README with the definitional line + benchmark table + back-links to the posts, GitHub topics, so `kissishka/risp` starts indexing.

### On-site — small, cheap, remaining
5. **[HIGH] "What is risp?" homepage block** — the home URL is still ~22 citability (risp appears only in the meta description). One answer-style block, using the disambiguated framing, makes the canonical URL AI-quotable.
6. **[MEDIUM] Deepen the About page** (~184 words, no explicit credentials) to convert identity into E-E-A-T authoritativeness.
7. **[LOW] `/llms-full.txt`**, `Content-Signal:` in robots.txt, Bing Webmaster + IndexNow on Cloudflare.

## Per-category scores

| Category | Score | Headline |
|---|---|---|
| AI Visibility | 55 | On-page citability high across 8 posts; near-zero discovery + name collision are the cap |
| Brand Authority | 14 | Repo public + `sameAs`×3 live, but not indexed, no mentions, name collides with the 2019 "risp" |
| Content E-E-A-T | 73 | Content 80+, author layer live; thin About bio is the remaining drag |
| Technical | 93 | Confirmed live: 200s, SSR, schema served, 301 root, per-post lastmod |
| Schema | 86 | Live: `Person` + `WebSite` + `sameAs`×3 + `FAQPage`×8 + `isBasedOn` |
| Platform (avg) | 54 | AIO strongest; Perplexity/Gemini gated by the absent off-site footprint |

**Bottom line:** The site improved for real over the 51 baseline (+8 live), led by schema and the author layer — all confirmed serving in production. The live run corrects one optimistic call: the published repo isn't an entity anchor *yet*, because it isn't indexed and the name "risp" resolves to a different, well-known project. The path to "Good" (75) runs through **disambiguation first**, then mentions and Wikidata — none of it code.

---
<sub>Audit scope: live production URL (`https://roman-kocherezhchenko.com`), schema confirmed via direct HTML fetch (WebFetch's markdown view strips JSON-LD). Off-site signals checked via web search + GitHub/HN reachability on 2026-06-18; "no footprint" reflects what was indexed at audit time and should improve as the repo and posts propagate. Supersedes the local-build estimate of 62.</sub>
