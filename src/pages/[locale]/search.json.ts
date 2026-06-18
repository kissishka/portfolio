import type { APIRoute } from "astro";
import { locales, type Locale } from "../../lib/t";
import { getPosts, postSlug } from "../../lib/blog";

// Static per-locale search index, emitted to /en/search.json and /uk/search.json
// at build time. The client (public/scripts/search.js) lazy-fetches the file for
// the active locale on first ⌘K and filters it in the browser — no server, no
// search dependency, and a same-origin fetch the strict CSP already allows
// (connect-src 'self'). Drafts are excluded in prod by getPosts().
export function getStaticPaths() {
  return locales.map((locale) => ({ params: { locale } }));
}

// Strip markdown down to searchable prose. Fenced code blocks are dropped (large
// and punctuation-heavy — the posts explain their key symbols in prose anyway);
// links collapse to their visible text. Keep this cheap: it runs per post at
// build time only.
// ponytail: light regex strip; if code-symbol search is ever wanted, keep the
// fenced blocks instead of dropping them.
function toPlainText(md: string): string {
  return md
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/[*_`~>]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

export const GET: APIRoute = async ({ params }) => {
  const locale = params.locale as Locale;
  const posts = await getPosts(locale);
  const index = posts.map((post) => ({
    title: post.data.title,
    description: post.data.description,
    tags: post.data.tags,
    url: `/${locale}/blog/${postSlug(post.id)}/`,
    text: toPlainText(post.body ?? ""),
  }));
  return new Response(JSON.stringify(index), {
    headers: { "content-type": "application/json; charset=utf-8" },
  });
};
