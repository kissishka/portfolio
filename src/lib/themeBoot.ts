// Inline, render-blocking theme boot. Runs in <head> BEFORE first paint so a
// stored light/dark choice is applied with no flash of the wrong theme (FOUC).
//
// Injected verbatim via `<script is:inline set:html={THEME_BOOT}>`, so its exact
// bytes are covered by a CSP hash. Whitespace MATTERS — keep it on one line and
// rerun `npm run csp:hash` after any edit here (the build CSP <meta> must match).
//
// `data-js` lets CSS reveal the toggle button only when scripting is available;
// `data-theme` (light|dark) is the explicit override, absent = follow the OS.
export const THEME_BOOT = `document.documentElement.dataset.js="";try{var t=localStorage.getItem("theme");if(t==="light"||t==="dark")document.documentElement.dataset.theme=t}catch(e){}`;
