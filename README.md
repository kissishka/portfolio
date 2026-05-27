# Portfolio

Bilingual (English + Ukrainian) personal site for an engineer who sells
**websites, bots, and deploys**. Static, minimal-islands Astro build,
deployed on Cloudflare Pages. Release gate: **Lighthouse 100 / 100 / 100 / 100
on mobile**.

## Quick start

```bash
npm install
npm run dev        # http://localhost:4321/
npm run build      # produces dist/
npm run preview    # serves dist/ at http://localhost:4321/
```

`npm run check` runs `astro check` (TypeScript + content schema validation).

## Before you deploy

These are real blockers — the site is not ready for public traffic until they
are done.

### 1. Set your Telegram handle

Open `src/lib/contact.ts` and replace `your-telegram-handle` with your real
Telegram username. Without this, the primary CTA on every page is a dead link.

```ts
// src/lib/contact.ts
export const TELEGRAM_HANDLE = "your-telegram-handle"; // <-- replace
export const EMAIL = "romakoch2018@gmail.com";
```

Also update the same handle in `src/lib/jsonld.ts` (`sameAs` field), then run:

```bash
npm run csp:hash
```

That recomputes the SHA-256 of the JSON-LD payload and patches
`public/_headers` so the CSP `script-src` directive matches.

### 2. Set the production site URL

Open `astro.config.mjs` and replace `https://portfolio.example.com` with your
real domain. This affects canonical URLs, OpenGraph, hreflang, and the sitemap.

Then re-run `npm run csp:hash` (the JSON-LD `url` field references the site URL
and the hash needs to match).

### 3. Replace placeholder copy

- `src/content/services/{en,uk}/{websites,bots,deploys}.md` — service entries
- `src/content/portfolio/{en,uk}/project-*.md` — portfolio stubs (mark
  `status: published` once you've written real copy)
- `src/content/i18n/{en,uk}.json` — nav/hero/footer strings
- `src/lib/jsonld.ts` — `name`, `jobTitle`, and the per-service `name` /
  `description` fields

## Deploy to Cloudflare Pages

1. Push this repo to GitHub.
2. In Cloudflare dashboard → **Workers & Pages** → **Create application** →
   **Pages** → **Connect to Git**.
3. Select the repo. Build settings:
   - **Framework preset:** Astro
   - **Build command:** `npm run build`
   - **Build output directory:** `dist`
   - **Node version:** 20 (or whatever the repo's `.nvmrc` specifies)
4. Deploy. Cloudflare reads `public/_headers` and `public/_redirects`
   automatically — they apply at the edge, not from Astro.
5. Bind your real domain in Cloudflare Pages → **Custom domains**.

## Verify the Lighthouse 100 ×4 gate

Run against the **production URL** (the gate is for production behavior, not
local preview, because the CSP, redirects, and edge caching only apply at the
real deploy):

```bash
npx lighthouse https://<your-domain>/en/ \
  --emulated-form-factor=mobile \
  --throttling.cpuSlowdownMultiplier=4 \
  --output=json --output-path=./lh-en.json

jq '.categories | to_entries | map({(.key): .value.score})' lh-en.json
# expect: [{"performance":1},{"accessibility":1},{"best-practices":1},{"seo":1}]
```

Repeat for `/uk/`. **Both locales must score all four 100s.** If any audit
fails:

1. Open the JSON report and find the failing audit.
2. Fix at the root cause (do **not** add `'unsafe-inline'` to the CSP to make
   Best Practices pass — that defeats the point).
3. Re-deploy and re-run.

### Local Lighthouse run (directional, not the gate)

```bash
npm run preview        # serves http://localhost:4321/en/
npx lighthouse http://localhost:4321/en/ \
  --emulated-form-factor=mobile \
  --throttling.cpuSlowdownMultiplier=4
```

This is useful while iterating, but **does not exercise the CSP or
`_redirects`**, which only apply at the Cloudflare edge. Use it for catching
a11y / SEO / DOM-structure regressions early; use the production run for the
release gate.

## Headers and CSP

Two layers:

**Per-page `<meta http-equiv="content-security-policy">`** emitted by Astro
6's stable `security.csp` integration. Astro auto-generates SHA-256 hashes for
every bundled script and style on each page; `astro.config.mjs` appends the
remaining directives (`default-src`, `img-src`, `font-src`, `connect-src`,
`base-uri`, `form-action`) and feeds the JSON-LD payload hash via
`SCRIPT_HASHES`. No `'unsafe-inline'` is permitted.

**HTTP headers in `public/_headers`** (applied at the Cloudflare edge):

- `Strict-Transport-Security` with `preload`
- `Referrer-Policy: strict-origin-when-cross-origin`
- `X-Content-Type-Options: nosniff`
- `Permissions-Policy` denying camera/mic/geolocation/cohorts
- `X-Frame-Options: DENY` (clickjacking defense — `frame-ancestors` can't be
  set via `<meta>`, so we use `X-Frame-Options` instead)

`npm run csp:hash` recomputes the JSON-LD payload hash and patches the
`SCRIPT_HASHES` constant in `astro.config.mjs`. Rerun it any time you change
`src/lib/jsonld.ts`. CI should fail if the committed hash drifts from the
current JSON-LD content (TODO v1.1).

## Architecture decisions

- **Astro 6.x** with Content Layer collections (`loader: glob(...)`) + native i18n routing.
- **No Tailwind.** `src/styles/global.css` is hand-written (≤ 8 KB).
- **No client framework.** The only client-side JS is `public/scripts/lang-switcher.js` (≈ 500 bytes gzipped) and runs on page load.
- **Inline JSON-LD with hashed CSP.** External JSON-LD files don't work for
  Google's structured-data crawlers; we inline and hash instead.
- **Cloudflare Pages + edge `_redirects`** for the root `/` → `/en/`
  redirect (faster than an Astro-emitted 302 because it terminates at the
  edge, never reaches the static page).
- **System fonts + Inter subsets** with `font-display: optional` and
  `unicode-range`-scoped @font-face declarations. Latin and Cyrillic-Ukrainian
  subsets are preloaded per locale. CLS-safe.

## Out of scope (deferred to v1.1+)

- No blog, no contact form backend, no analytics.
- No dark/light theme toggle in v1.
- CI-driven Lighthouse automation deferred — gate is currently a manual run
  against production.
- CSP-hash-drift check in CI deferred.
