// Client-side enhancement for the language switcher.
// Served from /scripts/ (covered by `script-src 'self'` in the CSP).
// The <a href> in LangSwitcher.astro is the no-JS baseline; this script only
// rewrites the href to the "twin" route in the target locale when one exists,
// falling back to the target locale's home otherwise.
(() => {
  const LOCALE_PREFIX = /^\/(en|uk)(\/|$)/;
  const links = document.querySelectorAll("[data-lang-switcher]");
  for (const link of links) {
    const target = link.dataset.targetLocale;
    if (target !== "en" && target !== "uk") continue;
    const path = window.location.pathname;
    const twin = LOCALE_PREFIX.test(path)
      ? path.replace(LOCALE_PREFIX, `/${target}$2`)
      : `/${target}/`;
    link.href = twin;
  }
})();
