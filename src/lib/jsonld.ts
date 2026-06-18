// Canonical JSON-LD payload. Identical across locales so that one CSP hash
// covers every page. If you change this content, rerun `npm run csp:hash`.
//
// Note: this string is what we inline verbatim. Whitespace MATTERS for the
// CSP hash — keep it exactly as exported.
export const PERSON_JSONLD = `{"@context":"https://schema.org","@graph":[{"@type":"Person","name":"Roman Kocherezhchenko","jobTitle":"AI-Enabled Engineer","url":"https://roman-kocherezhchenko.com","sameAs":["https://t.me/roman_kocherezhchenko","https://github.com/kissishka","https://www.linkedin.com/in/roman-kocherezhchenko-is-the-best-developer/"]},{"@type":"WebSite","name":"Roman Kocherezhchenko","alternateName":"Roman Kocherezhchenko — AI-Enabled Engineer","url":"https://roman-kocherezhchenko.com","inLanguage":["en","uk"],"publisher":{"@type":"Person","name":"Roman Kocherezhchenko","url":"https://roman-kocherezhchenko.com"}}]}`;

export interface BlogPostingInput {
  title: string;
  description: string;
  url: string;
  /** Absolute URL of the post's OG/social image (used as the BlogPosting image). */
  image?: string;
  datePublished: string;
  dateModified?: string;
  tags: string[];
  locale: "en" | "uk";
  origin: string;
  blogUrl: string;
  homeName: string;
  blogName: string;
  /** Optional Q&A pairs, emitted as a FAQPage node in the same @graph. */
  faq?: Array<{ q: string; a: string }>;
}

/**
 * Per-post BlogPosting + BreadcrumbList JSON-LD, as a compact string for inlining
 * in a <script type="application/ld+json">. `<` is escaped so the payload can
 * never break out of the script element.
 *
 * NOTE: unlike PERSON_JSONLD this is dynamic per page and intentionally NOT
 * CSP-hashed — an `application/ld+json` block is a data block, not script-like,
 * so CSP `script-src` does not govern it (see scripts/csp-verify.mjs).
 */
export function blogPostingJsonLd(input: BlogPostingInput): string {
  const author = {
    "@type": "Person",
    name: "Roman Kocherezhchenko",
    url: input.origin,
    sameAs: [
      "https://t.me/roman_kocherezhchenko",
      "https://github.com/kissishka",
      "https://www.linkedin.com/in/roman-kocherezhchenko-is-the-best-developer/",
    ],
  };
  const nodes: Record<string, unknown>[] = [
    {
      "@type": "BlogPosting",
      headline: input.title,
      description: input.description,
      url: input.url,
      ...(input.image ? { image: [input.image] } : {}),
      mainEntityOfPage: { "@type": "WebPage", "@id": input.url },
      datePublished: input.datePublished,
      dateModified: input.dateModified ?? input.datePublished,
      inLanguage: input.locale === "uk" ? "uk-UA" : "en",
      keywords: input.tags.join(", "),
      speakable: {
        "@type": "SpeakableSpecification",
        cssSelector: ["h1", ".post__lede", ".faq"],
      },
      author,
      publisher: author,
    },
    {
      "@type": "BreadcrumbList",
      itemListElement: [
        {
          "@type": "ListItem",
          position: 1,
          name: input.homeName,
          item: `${input.origin}/${input.locale}/`,
        },
        {
          "@type": "ListItem",
          position: 2,
          name: input.blogName,
          item: input.blogUrl,
        },
        { "@type": "ListItem", position: 3, name: input.title, item: input.url },
      ],
    },
  ];

  if (input.faq && input.faq.length > 0) {
    nodes.push({
      "@type": "FAQPage",
      mainEntity: input.faq.map((f) => ({
        "@type": "Question",
        name: f.q,
        acceptedAnswer: { "@type": "Answer", text: f.a },
      })),
    });
  }

  const graph = { "@context": "https://schema.org", "@graph": nodes };
  return JSON.stringify(graph).replace(/</g, "\\u003c");
}
