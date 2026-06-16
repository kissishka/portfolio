import { getCollection, type CollectionEntry } from "astro:content";
import type { Locale } from "./t";

export type BlogPost = CollectionEntry<"blog">;

const WORDS_PER_MINUTE = 200;

// Intl locale tags for date formatting. Node 20+ ships full ICU, so uk-UA
// resolves to real Ukrainian month names at build time.
const DATE_LOCALE: Record<Locale, string> = { en: "en-US", uk: "uk-UA" };

/**
 * The glob loader ids look like "en/my-post". Split off the leading locale
 * segment to recover the URL slug (which may itself contain slashes).
 */
export function postSlug(id: string): string {
  return id.split("/").slice(1).join("/");
}

/**
 * Published posts for one locale, newest first. Drafts are hidden in a
 * production build but kept visible during `astro dev` so they can be previewed.
 */
export async function getPosts(locale: Locale): Promise<BlogPost[]> {
  const posts = await getCollection("blog", (entry) => {
    const inLocale = entry.id.startsWith(`${locale}/`);
    const visible = import.meta.env.PROD ? entry.data.draft !== true : true;
    return inLocale && visible;
  });
  return posts.sort(
    (a, b) => b.data.pubDate.getTime() - a.data.pubDate.getTime(),
  );
}

/** Estimated reading time in whole minutes (minimum 1) from the raw markdown. */
export function readingMinutes(body: string | undefined): number {
  const words = (body ?? "").trim().split(/\s+/).filter(Boolean).length;
  return Math.max(1, Math.round(words / WORDS_PER_MINUTE));
}

/** Distinct tags across a locale's published posts, alphabetically sorted. */
export async function getTags(locale: Locale): Promise<string[]> {
  const posts = await getPosts(locale);
  const seen = new Set<string>();
  for (const post of posts) {
    for (const tag of post.data.tags) seen.add(tag);
  }
  return [...seen].sort((a, b) => a.localeCompare(b));
}

/** Human-readable publication date in the post's locale. */
export function formatDate(date: Date, locale: Locale): string {
  return new Intl.DateTimeFormat(DATE_LOCALE[locale], {
    year: "numeric",
    month: "long",
    day: "numeric",
  }).format(date);
}

/**
 * Up to `limit` other published posts in the same locale that share at least one
 * tag with `post`, ranked by shared-tag count (then newest first). Build-time
 * internal linking for the post footer — no client JS.
 */
export async function getRelatedPosts(
  post: BlogPost,
  locale: Locale,
  limit = 3,
): Promise<BlogPost[]> {
  const tags = new Set(post.data.tags);
  if (tags.size === 0) return [];
  const posts = await getPosts(locale);
  return posts
    .filter((p) => p.id !== post.id)
    .map((p) => ({ p, shared: p.data.tags.filter((t) => tags.has(t)).length }))
    .filter((x) => x.shared > 0)
    .sort(
      (a, b) =>
        b.shared - a.shared ||
        b.p.data.pubDate.getTime() - a.p.data.pubDate.getTime(),
    )
    .slice(0, limit)
    .map((x) => x.p);
}
