import { defineCollection } from "astro:content";
import { glob } from "astro/loaders";
import { z } from "zod";

const services = defineCollection({
  loader: glob({ pattern: "**/*.md", base: "./src/content/services" }),
  schema: z.object({
    key: z.enum(["websites", "bots", "deploys"]),
    title: z.string(),
    scope: z.string(),
    deliverable: z.string(),
    startingPrice: z.string().optional(),
    order: z.number(),
  }),
});

const portfolio = defineCollection({
  loader: glob({ pattern: "**/*.md", base: "./src/content/portfolio" }),
  schema: ({ image }) =>
    z.object({
      title: z.string(),
      summary: z.string(),
      link: z.url().optional(),
      screenshot: image().optional(),
      order: z.number(),
      status: z.enum(["stub", "published"]),
    }),
});

const blog = defineCollection({
  loader: glob({ pattern: "**/*.md", base: "./src/content/blog" }),
  schema: z.object({
    title: z.string(),
    description: z.string(),
    pubDate: z.coerce.date(),
    updatedDate: z.coerce.date().optional(),
    // Tags must be lowercase, URL-safe slugs — each one becomes a
    // /<locale>/blog/tags/<tag>/ route, and the language switcher relies on the
    // same tag existing in both locales (translated posts share identical tags).
    tags: z.array(z.string().regex(/^[a-z0-9-]+$/)).default([]),
    draft: z.boolean().default(false),
    // Optional Q&A pairs. Rendered as a visible FAQ section AND emitted as
    // FAQPage JSON-LD for answer-engine / AI-search extraction. Keep answers
    // plain text (no markdown) so they serialize cleanly into structured data.
    faq: z.array(z.object({ q: z.string(), a: z.string() })).optional(),
  }),
});

export const collections = { services, portfolio, blog };
