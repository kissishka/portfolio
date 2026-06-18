// Full-site search — ⌘K / Ctrl+K full-text search over the blog.
//
// Served from /scripts/ so it's covered by `script-src 'self'` (no inline JS, no
// CSP hash). The button + <dialog> ship in SiteSearch.astro, hidden until
// `:root[data-js]`. On first open this lazy-fetches /<locale>/search.json (a
// same-origin fetch the CSP's `connect-src 'self'` allows), then filters it in
// the browser. The native <dialog> handles Esc, focus trapping, and inertness.
(() => {
  const dialog = document.querySelector("[data-search]");
  if (!dialog || typeof dialog.showModal !== "function") return;

  const openBtn = document.querySelector("[data-search-open]");
  const input = dialog.querySelector("[data-search-input]");
  const list = dialog.querySelector("[data-search-results]");
  const empty = dialog.querySelector("[data-search-empty]");
  const form = dialog.querySelector("form");
  const locale = dialog.dataset.locale === "uk" ? "uk" : "en";

  const MAX_RESULTS = 12;
  let entries = null; // lazy-loaded index, null until first open
  let rows = []; // currently rendered results: [{ url, el }]
  let active = -1; // index into rows of the highlighted result

  // The static hint reads "⌘K"; rewrite to "Ctrl K" off Apple platforms.
  // userAgentData.platform ("macOS") on Chromium; userAgent ("Macintosh"/"iPhone")
  // everywhere else — avoids the deprecated navigator.platform.
  const isMac = /Mac|iP(hone|ad|od)/.test(
    navigator.userAgentData?.platform || navigator.userAgent,
  );
  if (!isMac) {
    for (const kbd of document.querySelectorAll("[data-search-keyhint]")) {
      kbd.textContent = "Ctrl K";
    }
  }

  async function ensureIndex() {
    if (entries) return;
    try {
      const res = await fetch(`/${locale}/search.json`);
      entries = await res.json();
    } catch {
      entries = [];
    }
    // Precompute lowercased fields once so each keystroke is a cheap substring scan.
    for (const e of entries) {
      e._t = e.title.toLowerCase();
      e._tags = e.tags.join(" ").toLowerCase();
      e._d = e.description.toLowerCase();
      e._h = `${e._t} ${e._tags} ${e._d} ${e.text.toLowerCase()}`;
    }
  }

  const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const terms = (q) => q.toLowerCase().trim().split(/\s+/).filter(Boolean);

  // AND match: every term must appear somewhere. Score weights title > tags >
  // description > body, with a prefix boost when the title opens with the query.
  function score(e, ts) {
    let s = 0;
    for (const term of ts) {
      if (!e._h.includes(term)) return 0;
      if (e._t.includes(term)) s += 8;
      if (e._tags.includes(term)) s += 4;
      if (e._d.includes(term)) s += 2;
      s += 1;
    }
    if (e._t.startsWith(ts[0])) s += 5;
    return s;
  }

  // A window of body text around the first matched term, ellipsised at the edges.
  function snippet(text, term) {
    const i = term ? text.toLowerCase().indexOf(term) : -1;
    if (i < 0) return text.slice(0, 140) + (text.length > 140 ? "…" : "");
    const start = Math.max(0, i - 50);
    const end = Math.min(text.length, i + 90);
    return (
      (start > 0 ? "…" : "") +
      text.slice(start, end) +
      (end < text.length ? "…" : "")
    );
  }

  // Append `text` to `parent`, wrapping each term occurrence in <mark>. Built
  // with textContent (never innerHTML) so it's XSS-safe and CSP-clean.
  function highlight(parent, text, ts) {
    if (!ts.length) {
      parent.appendChild(document.createTextNode(text));
      return;
    }
    const re = new RegExp(`(${ts.map(escapeRe).join("|")})`, "ig");
    let last = 0;
    let m;
    while ((m = re.exec(text))) {
      if (m.index > last)
        parent.appendChild(document.createTextNode(text.slice(last, m.index)));
      const mark = document.createElement("mark");
      mark.textContent = m[0];
      parent.appendChild(mark);
      last = m.index + m[0].length;
      if (re.lastIndex === m.index) re.lastIndex++; // guard zero-width matches
    }
    if (last < text.length)
      parent.appendChild(document.createTextNode(text.slice(last)));
  }

  function setActive(i) {
    if (!rows.length) return;
    active = (i + rows.length) % rows.length;
    rows.forEach((r, j) =>
      r.el.setAttribute("aria-selected", String(j === active)),
    );
    const el = rows[active].el;
    el.scrollIntoView({ block: "nearest" });
    input.setAttribute("aria-activedescendant", el.id);
  }

  function render(hits, ts) {
    list.textContent = "";
    rows = [];
    active = -1;
    for (let i = 0; i < hits.length; i++) {
      const e = hits[i];
      const li = document.createElement("li");
      li.id = `search-opt-${i}`;
      li.setAttribute("role", "option");
      const a = document.createElement("a");
      a.className = "search__hit";
      a.href = e.url;
      a.tabIndex = -1;
      const title = document.createElement("span");
      title.className = "search__hit-title";
      highlight(title, e.title, ts);
      const snip = document.createElement("span");
      snip.className = "search__hit-snippet";
      highlight(snip, snippet(e.text, ts[0]), ts);
      a.append(title, snip);
      li.appendChild(a);
      list.appendChild(li);
      rows.push({ url: e.url, el: li });
    }
    empty.hidden = !(ts.length > 0 && hits.length === 0);
    input.setAttribute("aria-expanded", String(hits.length > 0));
    if (hits.length) setActive(0);
    else input.removeAttribute("aria-activedescendant");
  }

  function run(q) {
    const ts = terms(q);
    if (!entries || ts.length === 0) return render([], ts);
    const hits = entries
      .map((e) => ({ e, s: score(e, ts) }))
      .filter((x) => x.s > 0)
      .sort((a, b) => b.s - a.s)
      .slice(0, MAX_RESULTS)
      .map((x) => x.e);
    render(hits, ts);
  }

  async function open() {
    if (dialog.open) return;
    dialog.showModal();
    input.focus();
    input.select();
    await ensureIndex();
    if (input.value) run(input.value);
  }

  input.addEventListener("input", () => run(input.value));

  input.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive(active + 1);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive(active - 1);
    }
  });

  // Enter (form submit) follows the highlighted result instead of closing.
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    if (active >= 0 && rows[active]) window.location.href = rows[active].url;
  });

  // Click on the backdrop (the dialog element itself, outside the panel content).
  dialog.addEventListener("click", (e) => {
    if (e.target === dialog) dialog.close();
  });

  if (openBtn) openBtn.addEventListener("click", open);

  document.addEventListener("keydown", (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
      e.preventDefault();
      if (dialog.open) dialog.close();
      else open();
    }
  });
})();
