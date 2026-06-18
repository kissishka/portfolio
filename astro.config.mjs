// @ts-check
import { readFileSync, readdirSync } from "node:fs";
import { defineConfig } from "astro/config";
import sitemap from "@astrojs/sitemap";
import { rehypeHeadingIds } from "@astrojs/markdown-remark";

// Build-time rehype plugin: append a decorative permalink anchor to every h2/h3
// Astro has assigned an id. The visible "#" glyph comes from CSS (::before), so
// the anchor has no text content and never leaks into the table-of-contents
// heading text. No client JS and no new dependency — keeps the zero-runtime-JS /
// strict-CSP posture intact.
function rehypeHeadingAnchors() {
  return (tree) => {
    const visit = (node) => {
      if (
        node.type === "element" &&
        (node.tagName === "h2" || node.tagName === "h3") &&
        node.properties &&
        node.properties.id
      ) {
        node.children.push({
          type: "element",
          tagName: "a",
          properties: {
            className: ["heading-anchor"],
            href: `#${node.properties.id}`,
            ariaHidden: "true",
            tabIndex: -1,
          },
          children: [],
        });
      }
      if (node.children) {
        for (const child of node.children) visit(child);
      }
    };
    visit(tree);
  };
}

// CSP STRATEGY:
// Astro 6's stable `security.csp` emits a <meta http-equiv="content-security-policy">
// per page with auto-generated hashes for all bundled scripts and styles. We feed
// the manual inline-script payload hashes via `scriptDirective.hashes` and append
// the remaining directives via `directives`. No `'unsafe-inline'` anywhere.
//
// `_headers` keeps everything that doesn't belong in (or can't live in) a meta tag:
// HSTS, X-Frame-Options (clickjacking defense — frame-ancestors doesn't work in meta),
// X-Content-Type-Options, Referrer-Policy, Permissions-Policy.
//
// `npm run csp:hash` recomputes the inline JSON-LD (src/lib/jsonld.ts) and
// theme-boot (src/lib/themeBoot.ts) payload hashes and patches the
// `SCRIPT_HASHES` const below. Rerun after editing either file. The `postbuild`
// csp-verify guard fails the build if any inline script hash is missing here.
/** @type {`sha256-${string}`[]} */
const SCRIPT_HASHES = ["sha256-gVXDeYnhFIMjrrZccWUk3Va1INMnDo7pE64oFEmkEuo=", "sha256-vCjPtM7wROwtuzNZfQnx90sgST6SziuhGtU7vyXTF0o="];

// Per-post <lastmod> for the sitemap. The sitemap integration only sees URLs,
// not collection data, so we read blog frontmatter here at build time and map
// each post path to its updatedDate (falling back to pubDate). Only posts get a
// lastmod — they're the pages that actually change; index/tag/home are left bare
// rather than stamped with a meaningless build date.
// ponytail: regex frontmatter parse over our own controlled content; swap for a
// real YAML parser only if posts ever grow exotic date formatting.
const BLOG_LASTMOD = new Map();
for (const locale of ["en", "uk"]) {
  const dir = new URL(`./src/content/blog/${locale}/`, import.meta.url);
  for (const file of readdirSync(dir)) {
    if (!file.endsWith(".md")) continue;
    const fm = readFileSync(new URL(file, dir), "utf8").split("\n---", 1)[0];
    const raw = (fm.match(/^updatedDate:\s*(.+)$/m) ?? fm.match(/^pubDate:\s*(.+)$/m))?.[1]
      ?.trim()
      .replace(/^["']|["']$/g, "");
    if (raw) {
      const slug = file.replace(/\.md$/, "");
      BLOG_LASTMOD.set(`/${locale}/blog/${slug}/`, new Date(raw).toISOString());
    }
  }
}

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
  markdown: {
    // Class-based highlighting (Prism), NOT the default Shiki. Shiki emits an
    // inline `style="color:…"` attribute on every token; the strict CSP here
    // has no 'unsafe-inline' in style-src, so the browser would block those —
    // breaking the Lighthouse Best-Practices gate. Prism emits class names
    // instead; the token colors live in global.css (external, covered by
    // 'self'). Highlighting is build-time only, so no client JS ships either.
    syntaxHighlight: "prism",
    // Clickable "#" permalinks on h2/h3 (build-time, no client JS). rehypeHeadingIds
    // must run first so the anchor plugin sees the ids — Astro applies its own id
    // plugin AFTER user plugins, so we include it explicitly to control ordering.
    rehypePlugins: [rehypeHeadingIds, rehypeHeadingAnchors],
  },
  integrations: [
    sitemap({
      // RSS endpoints are feeds, not indexable pages — keep them out of the sitemap.
      filter: (page) => !page.includes("/blog/rss.xml"),
      serialize(item) {
        const lastmod = BLOG_LASTMOD.get(new URL(item.url).pathname);
        if (lastmod) item.lastmod = lastmod;
        return item;
      },
    }),
  ],
  image: {
    service: { entrypoint: "astro/assets/services/sharp" },
  },
  security: {
    csp: {
      algorithm: "SHA-256",
      scriptDirective: {
        hashes: SCRIPT_HASHES,
        // Cloudflare Pages injects the Web Analytics beacon
        // (static.cloudflareinsights.com/beacon.min.js) at the edge — it's not in
        // our build output, so it only shows up against the deployed site.
        // NOTE: `resources` REPLACES Astro's default script-src sources, so 'self'
        // MUST be listed here to keep our own bundled scripts loading. The
        // auto-generated SCRIPT_HASHES are still appended on top of this list.
        resources: ["'self'", "https://static.cloudflareinsights.com"],
      },
      directives: [
        "default-src 'self'",
        "img-src 'self' data:",
        "font-src 'self'",
        // Cloudflare Web Analytics beacon POSTs RUM data to cloudflareinsights.com.
        "connect-src 'self' https://cloudflareinsights.com",
        "base-uri 'self'",
        "form-action 'self'",
      ],
    },
  },
});
