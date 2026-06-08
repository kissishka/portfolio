// Canonical JSON-LD payload. Identical across locales so that one CSP hash
// covers every page. If you change this content, rerun `npm run csp:hash`.
//
// Note: this string is what we inline verbatim. Whitespace MATTERS for the
// CSP hash — keep it exactly as exported.
export const PERSON_JSONLD = `{"@context":"https://schema.org","@type":"Person","name":"Roman Kocherezhchenko","jobTitle":"AI-Enabled Engineer","url":"https://roman-kocherezhchenko.com","sameAs":["https://t.me/roman_kocherezhchenko"]}`;
