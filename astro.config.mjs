// @ts-check
import { defineConfig } from "astro/config";
import sitemap from "@astrojs/sitemap";

// CSP STRATEGY:
// Astro 6's stable `security.csp` emits a <meta http-equiv="content-security-policy">
// per page with auto-generated hashes for all bundled scripts and styles. We feed
// the manual JSON-LD payload hash via `scriptDirective.hashes` and append the
// remaining directives via `directives`. No `'unsafe-inline'` anywhere.
//
// `_headers` keeps everything that doesn't belong in (or can't live in) a meta tag:
// HSTS, X-Frame-Options (clickjacking defense — frame-ancestors doesn't work in meta),
// X-Content-Type-Options, Referrer-Policy, Permissions-Policy.
//
// `npm run csp:hash` recomputes the JSON-LD payload hash in src/lib/jsonld.ts
// and patches the `SCRIPT_HASHES` const below. Rerun after every JSON-LD edit.
/** @type {`sha256-${string}`[]} */
const SCRIPT_HASHES = ["sha256-z3yqRaJgLeAWQXL94tkZemS72w48wQ6CIkrJCFC3178="];

export default defineConfig({
  site: "https://roman-kocherezhchenko.com",
  trailingSlash: "always",
  build: {
    inlineStylesheets: "never",
    format: "directory",
  },
  i18n: {
    defaultLocale: "en",
    locales: ["en", "uk"],
    routing: {
      prefixDefaultLocale: true,
      // Cloudflare `public/_redirects` handles "/" -> "/en/" at the edge,
      // which is faster than an Astro-emitted redirect. The static
      // src/pages/index.astro file is a meta-refresh fallback if
      // _redirects ever fails to deploy.
      redirectToDefaultLocale: false,
    },
  },
  integrations: [sitemap()],
  image: {
    service: { entrypoint: "astro/assets/services/sharp" },
  },
  security: {
    csp: {
      algorithm: "SHA-256",
      scriptDirective: {
        hashes: SCRIPT_HASHES,
      },
      directives: [
        "default-src 'self'",
        "img-src 'self' data:",
        "font-src 'self'",
        "connect-src 'self'",
        "base-uri 'self'",
        "form-action 'self'",
      ],
    },
  },
});
