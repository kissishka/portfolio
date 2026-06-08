#!/usr/bin/env node
// Generate the static Open Graph / Twitter card image at public/og-default.png
// (1200x630) from an inline SVG, rasterized with sharp (already a dependency).
// BaseLayout.astro references this file as the default og:image / twitter:image.
//
// Re-run after changing the brand colors or the copy below:
//   npm run og:gen
import sharp from "sharp";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const outPath = join(here, "..", "public", "og-default.png");

// Brand tokens mirror the dark palette in src/styles/global.css.
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">
  <defs>
    <linearGradient id="bg" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#0b0d10"/>
      <stop offset="100%" stop-color="#15191e"/>
    </linearGradient>
    <radialGradient id="glow" cx="85%" cy="18%" r="55%">
      <stop offset="0%" stop-color="#7cc4ff" stop-opacity="0.16"/>
      <stop offset="100%" stop-color="#7cc4ff" stop-opacity="0"/>
    </radialGradient>
  </defs>
  <rect width="1200" height="630" fill="url(#bg)"/>
  <rect width="1200" height="630" fill="url(#glow)"/>
  <rect x="0" y="0" width="14" height="630" fill="#7cc4ff"/>
  <g font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif">
    <text x="96" y="300" fill="#7cc4ff" font-size="30" font-weight="600" letter-spacing="7">AI-ENABLED ENGINEER</text>
    <text x="92" y="398" fill="#e8eaed" font-size="76" font-weight="700">Roman Kocherezhchenko</text>
    <text x="96" y="566" fill="#7cc4ff" font-size="30" font-weight="500">roman-kocherezhchenko.com</text>
  </g>
</svg>`;

await sharp(Buffer.from(svg)).png().toFile(outPath);

console.log(`[og:gen] wrote ${outPath} (1200x630)`);
