#!/usr/bin/env node
// Recompute the SHA-256 hashes for every inline script payload and patch
// astro.config.mjs so the SCRIPT_HASHES constant matches. Astro's
// `security.csp.scriptDirective.hashes` consumes that array and emits the
// hashes in the per-page CSP <meta http-equiv> tag.
//
// Two inline payloads are hashed:
//   1. PERSON_JSONLD  in src/lib/jsonld.ts   (set:html JSON-LD)
//   2. THEME_BOOT     in src/lib/themeBoot.ts (anti-FOUC boot script)
//
// Run after any change to either file.
//
// Usage: npm run csp:hash

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..");
const configPath = join(repoRoot, "astro.config.mjs");

// Each payload is a single template-literal export; extract, hash, prefix.
const payloads = [
  { file: "src/lib/jsonld.ts", re: /PERSON_JSONLD = `([\s\S]*?)`;/, name: "PERSON_JSONLD" },
  { file: "src/lib/themeBoot.ts", re: /THEME_BOOT = `([\s\S]*?)`;/, name: "THEME_BOOT" },
];

const directives = payloads.map(({ file, re, name }) => {
  const src = readFileSync(join(repoRoot, file), "utf8");
  const match = src.match(re);
  if (!match) {
    console.error(`[csp:hash] Could not extract ${name} from ${file}`);
    process.exit(1);
  }
  const payload = match[1];
  // The extractor stops at the first backtick; a payload containing one would be
  // silently truncated and mis-hashed. Fail loudly instead.
  if (payload.includes("`")) {
    console.error(`[csp:hash] ${name} contains a backtick — keep hashed payloads backtick-free.`);
    process.exit(1);
  }
  const hash = createHash("sha256").update(payload).digest("base64");
  console.log(`[csp:hash] ${name}: ${payload.length} bytes -> sha256-${hash}`);
  return `sha256-${hash}`;
});

const arrayLiteral = `const SCRIPT_HASHES = [${directives
  .map((d) => `"${d}"`)
  .join(", ")}];`;

const configBefore = readFileSync(configPath, "utf8");
const scriptHashesRe = /const SCRIPT_HASHES = \[[\s\S]*?\];/;
if (!scriptHashesRe.test(configBefore)) {
  console.error(
    "[csp:hash] Could not find a SCRIPT_HASHES array in astro.config.mjs to patch.",
  );
  process.exit(1);
}
const replaced = configBefore.replace(scriptHashesRe, arrayLiteral);

if (replaced === configBefore) {
  console.log("[csp:hash] astro.config.mjs already up to date — no change");
  process.exit(0);
}

writeFileSync(configPath, replaced);
console.log(`[csp:hash] Updated astro.config.mjs SCRIPT_HASHES (${directives.length} hashes)`);
