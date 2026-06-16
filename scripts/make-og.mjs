#!/usr/bin/env node
// Generate Open Graph / Twitter card images (1200x630) from inline SVG, rasterized
// with sharp (already a dependency). Produces:
//   public/og-default.png          — the site-wide default (homepage, etc.)
//   public/og/<locale>/<slug>.png  — one per blog post, stamped with its title
// BaseLayout.astro references og-default.png; [locale]/blog/[slug].astro points
// each post at its per-post card (falling back to the default if it's missing).
//
// Run after adding/retitling posts or changing the brand copy:
//   npm run og:gen
import sharp from "sharp";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { readFileSync, readdirSync, mkdirSync, existsSync } from "node:fs";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..");
const publicDir = join(repoRoot, "public");

// Brand tokens mirror the dark palette in src/styles/global.css.
const BG = "#0b0d10";
const BG2 = "#15191e";
const ACCENT = "#7cc4ff";
const FG = "#e8eaed";
const FONT =
  "-apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif";

const xmlEscape = (s) =>
  s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

function frame(inner) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">
  <defs>
    <linearGradient id="bg" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="${BG}"/>
      <stop offset="100%" stop-color="${BG2}"/>
    </linearGradient>
    <radialGradient id="glow" cx="85%" cy="18%" r="55%">
      <stop offset="0%" stop-color="${ACCENT}" stop-opacity="0.16"/>
      <stop offset="100%" stop-color="${ACCENT}" stop-opacity="0"/>
    </radialGradient>
  </defs>
  <rect width="1200" height="630" fill="url(#bg)"/>
  <rect width="1200" height="630" fill="url(#glow)"/>
  <rect x="0" y="0" width="14" height="630" fill="${ACCENT}"/>
  <g font-family="${FONT}">
    ${inner}
  </g>
</svg>`;
}

async function write(svg, outPath) {
  mkdirSync(dirname(outPath), { recursive: true });
  await sharp(Buffer.from(svg)).png().toFile(outPath);
  console.log(`[og:gen] wrote ${outPath}`);
}

// --- default card ---------------------------------------------------------
const defaultInner = `
    <text x="96" y="300" fill="${ACCENT}" font-size="30" font-weight="600" letter-spacing="7">AI-ENABLED ENGINEER</text>
    <text x="92" y="398" fill="${FG}" font-size="76" font-weight="700">Roman Kocherezhchenko</text>
    <text x="96" y="566" fill="${ACCENT}" font-size="30" font-weight="500">roman-kocherezhchenko.com</text>`;
await write(frame(defaultInner), join(publicDir, "og-default.png"));

// --- per-post cards -------------------------------------------------------
// Greedy word-wrap a title into at most `maxLines` lines of ~`maxChars` chars.
function wrap(title, maxChars = 30, maxLines = 4) {
  const words = title.split(/\s+/);
  const lines = [];
  let line = "";
  for (const w of words) {
    const candidate = line ? `${line} ${w}` : w;
    if (candidate.length > maxChars && line) {
      lines.push(line);
      line = w;
      if (lines.length === maxLines) break;
    } else {
      line = candidate;
    }
  }
  if (line && lines.length < maxLines) lines.push(line);
  // Truncate with an ellipsis if the title didn't fully fit.
  if (lines.join(" ").length < title.length) {
    lines[lines.length - 1] = `${lines[lines.length - 1]}…`;
  }
  return lines;
}

function postCard(title) {
  const lines = wrap(title);
  const size = lines.length > 3 ? 56 : 64;
  const lh = lines.length > 3 ? 74 : 84;
  // Vertically center the title block around y≈330.
  let y = 330 - ((lines.length - 1) * lh) / 2;
  const spans = lines
    .map((l) => {
      const span = `<text x="92" y="${Math.round(y)}" fill="${FG}" font-size="${size}" font-weight="700">${xmlEscape(l)}</text>`;
      y += lh;
      return span;
    })
    .join("\n    ");
  return `
    <text x="96" y="150" fill="${ACCENT}" font-size="28" font-weight="600" letter-spacing="6">ROMAN KOCHEREZHCHENKO · BLOG</text>
    ${spans}
    <text x="96" y="566" fill="${ACCENT}" font-size="28" font-weight="500">roman-kocherezhchenko.com</text>`;
}

const blogBase = join(repoRoot, "src", "content", "blog");
// The first `title:` line in a post's frontmatter (optionally quoted).
const titleRe = /^title:\s*["']?(.+?)["']?\s*$/m;
let postCount = 0;
for (const locale of ["en", "uk"]) {
  const dir = join(blogBase, locale);
  if (!existsSync(dir)) continue;
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".md"))) {
    const src = readFileSync(join(dir, file), "utf8");
    const m = src.match(titleRe);
    const title = m ? m[1] : file.replace(/\.md$/, "");
    const slug = file.replace(/\.md$/, "");
    await write(frame(postCard(title)), join(publicDir, "og", locale, `${slug}.png`));
    postCount++;
  }
}

console.log(`[og:gen] done — 1 default + ${postCount} per-post card(s)`);
