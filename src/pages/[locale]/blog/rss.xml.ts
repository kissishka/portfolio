import rss from "@astrojs/rss";
import type { APIContext } from "astro";
import { locales, isLocale, t } from "../../../lib/t";
import { getPosts, postSlug } from "../../../lib/blog";

export function getStaticPaths() {
  return locales.map((locale) => ({ params: { locale } }));
}

export async function GET(context: APIContext) {
  const localeParam = context.params.locale;
  if (!localeParam || !isLocale(localeParam)) {
    return new Response("Not found", { status: 404 });
  }
  const locale = localeParam;
  const posts = await getPosts(locale);

  return rss({
    title: t("blog.feedTitle", locale),
    description: t("blog.feedDescription", locale),
    site: context.site ?? "https://roman-kocherezhchenko.com",
    items: posts.map((post) => ({
      title: post.data.title,
      description: post.data.description,
      pubDate: post.data.pubDate,
      link: `/${locale}/blog/${postSlug(post.id)}/`,
      categories: post.data.tags,
    })),
    customData: `<language>${locale === "uk" ? "uk-ua" : "en-us"}</language>`,
  });
}
