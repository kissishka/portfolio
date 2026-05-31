// Manual light/dark toggle with a circular-reveal View Transition.
//
// The inline boot script (src/lib/themeBoot.ts) applies the stored theme before
// first paint; this module wires the header button(s), persists the choice,
// keeps the theme-color <meta> in sync, and follows the OS when no explicit
// choice is set. Served from /scripts/ so it's covered by `script-src 'self'`
// in the CSP — no inline JS, no hash needed.
(() => {
  const root = document.documentElement;
  const KEY = "theme";
  const darkMQ = matchMedia("(prefers-color-scheme: dark)");
  const reduceMQ = matchMedia("(prefers-reduced-motion: reduce)");

  // Resolved theme: explicit override if set, otherwise the OS preference.
  const active = () => root.dataset.theme || (darkMQ.matches ? "dark" : "light");

  // Set every theme-color meta to the active background so the mobile browser
  // chrome matches even when the choice differs from the OS preference.
  const syncMeta = (theme) => {
    const color = theme === "dark" ? "#0b0d10" : "#fafafa";
    for (const m of document.querySelectorAll('meta[name="theme-color"]')) {
      m.setAttribute("content", color);
    }
  };

  const buttons = document.querySelectorAll("[data-theme-toggle]");

  // Expose the binary state to assistive tech (announced on activation).
  const setPressed = (theme) => {
    for (const b of buttons) b.setAttribute("aria-pressed", String(theme === "dark"));
  };

  const apply = (theme) => {
    root.dataset.theme = theme;
    try {
      localStorage.setItem(KEY, theme);
    } catch (e) {}
    syncMeta(theme);
    setPressed(theme);
  };

  const toggle = (event) => {
    const next = active() === "dark" ? "light" : "dark";

    // No View Transitions / reduced motion -> switch instantly.
    if (reduceMQ.matches || !document.startViewTransition) {
      apply(next);
      return;
    }

    // Expanding circle originating from the click point. +4px over-covers the
    // farthest corner so no antialiased seam shows on fractional-DPR displays.
    const x = event && event.clientX ? event.clientX : innerWidth;
    const y = event && event.clientY ? event.clientY : 0;
    const r = Math.hypot(Math.max(x, innerWidth - x), Math.max(y, innerHeight - y)) + 4;
    root.style.setProperty("--tt-x", x + "px");
    root.style.setProperty("--tt-y", y + "px");
    root.style.setProperty("--tt-r", r + "px");
    // A skipped/interrupted transition (rapid re-clicks, hidden tab) rejects
    // .finished — the DOM is already updated, so just quiet the console.
    document.startViewTransition(() => apply(next)).finished.catch(() => {});
  };

  for (const btn of buttons) btn.addEventListener("click", toggle);

  // No explicit choice: follow later OS changes (CSS already reacts via the
  // media query; this only realigns the theme-color meta).
  darkMQ.addEventListener("change", () => {
    if (!root.dataset.theme) syncMeta(darkMQ.matches ? "dark" : "light");
  });

  // Initial sync: reflect the active theme in aria-pressed, and realign the meta
  // if the boot script restored an explicit choice.
  setPressed(active());
  if (root.dataset.theme) syncMeta(root.dataset.theme);
})();
