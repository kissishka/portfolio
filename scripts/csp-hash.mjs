#!/usr/bin/env node
// Recompute the SHA-256 hash for the inline JSON-LD payload and patch
// astro.config.mjs so the SCRIPT_HASHES constant matches. Astro's
// `security.csp.scriptDirective.hashes` consumes that array and emits the
// hash in the per-page CSP <meta http-equiv> tag.
//
// Run after any change to src/lib/jsonld.ts.
//
// Usage: npm run csp:hash

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..");
const jsonldPath = join(repoRoot, "src/lib/jsonld.ts");
const configPath = join(repoRoot, "astro.config.mjs");

const src = readFileSync(jsonldPath, "utf8");
const match = src.match(/PERSON_JSONLD = `([\s\S]*?)`;/);
if (!match) {
  console.error("[csp:hash] Could not extract PERSON_JSONLD from", jsonldPath);
  process.exit(1);
}
const payload = match[1];
const hash = createHash("sha256").update(payload).digest("base64");
const directive = `sha256-${hash}`;

const configBefore = readFileSync(configPath, "utf8");
const scriptHashesRe =
  /const SCRIPT_HASHES = \[\s*"sha256-[A-Za-z0-9+/=]+"\s*\];/;
if (!scriptHashesRe.test(configBefore)) {
  console.error(
    "[csp:hash] Could not find a SCRIPT_HASHES array in astro.config.mjs to patch.",
  );
  process.exit(1);
}
const replaced = configBefore.replace(
  scriptHashesRe,
  `const SCRIPT_HASHES = ["${directive}"];`,
);

if (replaced === configBefore) {
  console.log(`[csp:hash] astro.config.mjs already has "${directive}" — no change`);
  process.exit(0);
}

writeFileSync(configPath, replaced);
console.log(`[csp:hash] Updated astro.config.mjs with "${directive}"`);
console.log(`[csp:hash] Payload length: ${payload.length} bytes`);
