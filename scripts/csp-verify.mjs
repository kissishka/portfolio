#!/usr/bin/env node
// Postbuild CSP guard. For every built HTML page, re-hash each INLINE <script>
// and assert its sha256 appears in that page's CSP <meta>. Catches SCRIPT_HASHES
// drift — e.g. editing src/lib/jsonld.ts or src/lib/themeBoot.ts without rerunning
// `npm run csp:hash` — BEFORE it ships, turning a silent CSP break (FOUC + a
// blocked inline script) into a loud build failure.
//
// Wired as `postbuild`, so it runs automatically after `astro build` (locally
// and in the Cloudflare build). Usage: node scripts/csp-verify.mjs

import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative } from "node:path";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const distDir = join(repoRoot, "dist");

function htmlFiles(dir) {
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...htmlFiles(p));
    else if (e.name.endsWith(".html")) out.push(p);
  }
  return out;
}

// Inline scripts only (no src=); covers the JSON-LD and the theme-boot payloads.
const inlineScriptRe = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g;
const metaRe = /<meta\b[^>]*content-security-policy[^>]*>/i;
const contentRe = /content="([^"]*)"/i;

let failures = 0;
let checked = 0;
const files = htmlFiles(distDir);

for (const file of files) {
  const html = readFileSync(file, "utf8");
  const rel = relative(repoRoot, file);
  const inlineScripts = [...html.matchAll(inlineScriptRe)].map((m) => m[1]);
  if (inlineScripts.length === 0) continue;

  const metaTag = html.match(metaRe);
  const csp = metaTag && metaTag[0].match(contentRe)?.[1];
  if (!csp) {
    console.error(`[csp:verify] ${rel}: ${inlineScripts.length} inline script(s) but no CSP <meta> found`);
    failures++;
    continue;
  }

  for (const body of inlineScripts) {
    const hash = createHash("sha256").update(body).digest("base64");
    checked++;
    if (!csp.includes(`sha256-${hash}`)) {
      failures++;
      console.error(`[csp:verify] ${rel}: inline script hash sha256-${hash} (${body.length}B) NOT in CSP`);
      console.error(`             snippet: ${JSON.stringify(body.slice(0, 60))}`);
    }
  }
}

if (failures) {
  console.error(
    `\n[csp:verify] FAILED — ${failures} inline script(s) not covered by CSP. Run \`npm run csp:hash\` and rebuild.`,
  );
  process.exit(1);
}
console.log(
  `[csp:verify] OK — ${checked} inline script hash(es) across ${files.length} page(s) all present in CSP.`,
);
