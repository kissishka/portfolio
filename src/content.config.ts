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

export const collections = { services, portfolio };
