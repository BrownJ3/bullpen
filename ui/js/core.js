// Basics: token, DOM and icon helpers, navigation, the server connection, shared state.
// Plain scripts sharing one global scope, loaded in order by index.html (no build step).

"use strict";

// ---------- token ----------
// `npm run client -- ui` opens /#token=…; the fragment never reaches the server. Keep it for this tab only.
(function takeToken() {
  const m = location.hash.match(/token=([0-9a-f]+)/);
  if (m) {
    try { sessionStorage.setItem("bp-token", m[1]); } catch {}
    history.replaceState(null, "", location.pathname);
  }
})();
let TOKEN = "";
try { TOKEN = sessionStorage.getItem("bp-token") || ""; } catch {}

// ---------- tiny DOM helper ----------
function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === "class") el.className = v;
    else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? "" : v);
  }
  for (const c of children.flat()) if (c != null && c !== false) el.append(c instanceof Node ? c : String(c));
  return el;
}
const $ = (id) => document.getElementById(id);

// ---------- icons ----------
const ICONS = {
  inbox: '<polyline points="22 12 16 12 14 15 10 15 8 12 2 12"/><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/>',
  users: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  back: '<path d="m15 18-6-6 6-6"/>',
  forward: '<path d="m9 18 6-6-6-6"/>',
  chevdown: '<path d="m6 9 6 6 6-6"/>',
  chevright: '<path d="m9 18 6-6-6-6"/>',
  search: '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>',
  sidebar: '<rect width="18" height="18" x="3" y="3" rx="2"/><path d="M9 3v18"/>',
  folderplus: '<path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/><path d="M12 10v6M9 13h6"/>',
  files: '<path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/>',
  terminal: '<polyline points="4 17 10 11 4 5"/><line x1="12" x2="20" y1="19" y2="19"/>',
  globe: '<circle cx="12" cy="12" r="10"/><path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20"/><path d="M2 12h20"/>',
  stop: '<rect x="6" y="6" width="12" height="12" rx="2.5" fill="currentColor" stroke="none"/>',
  play: '<path d="M7 4.5v15a1 1 0 0 0 1.5.86l12-7.5a1 1 0 0 0 0-1.72l-12-7.5A1 1 0 0 0 7 4.5z"/>',
  pause: '<rect x="14" y="4" width="4" height="16" rx="1"/><rect x="6" y="4" width="4" height="16" rx="1"/>',
  edit: '<path d="M21.17 6.81a1 1 0 0 0-3.99-3.99L3.84 16.17a2 2 0 0 0-.5.83l-1.32 4.35a.5.5 0 0 0 .62.62l4.35-1.32a2 2 0 0 0 .83-.5z"/><path d="m15 5 4 4"/>',
  more: '<circle cx="12" cy="12" r="1.2"/><circle cx="19" cy="12" r="1.2"/><circle cx="5" cy="12" r="1.2"/>',
  reset: '<path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/>',
  refresh: '<path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/>',
  bulb: '<path d="M15 14c.2-1 .7-1.7 1.5-2.5 1-.9 1.5-2.2 1.5-3.5A6 6 0 0 0 6 8c0 1 .2 2.2 1.5 3.5.7.7 1.3 1.5 1.5 2.5"/><path d="M9 18h6"/><path d="M10 22h4"/>',
  clock: '<circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>',
  star: '<polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>',
  x: '<path d="M18 6 6 18M6 6l12 12"/>',
  send: '<path d="m5 12 7-7 7 7"/><path d="M12 19V5"/>',
  mic: '<path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" x2="12" y1="19" y2="22"/>',
  external: '<path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>',
  home: '<path d="m3 9 9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/>',
  power: '<path d="M12 2v10"/><path d="M18.4 6.6a9 9 0 1 1-12.77.04"/>',
  list: '<path d="M3 12h.01M3 18h.01M3 6h.01M8 12h13M8 18h13M8 6h13"/>',
  userplus: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><line x1="19" x2="19" y1="8" y2="14"/><line x1="22" x2="16" y1="11" y2="11"/>',
  message: '<path d="M7.9 20A9 9 0 1 0 4 16.1L2 22Z"/>',
  compose: '<path d="M12 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.375 2.625a1 1 0 0 1 3 3l-9.013 9.014a2 2 0 0 1-.853.505l-2.873.84a.5.5 0 0 1-.62-.62l.84-2.873a2 2 0 0 1 .506-.852z"/>',
  trash: '<path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/>',
  palette: '<circle cx="13.5" cy="6.5" r="1" fill="currentColor"/><circle cx="17.5" cy="10.5" r="1" fill="currentColor"/><circle cx="8.5" cy="7.5" r="1" fill="currentColor"/><circle cx="6.5" cy="12.5" r="1" fill="currentColor"/><path d="M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10c.93 0 1.65-.75 1.65-1.69 0-.44-.18-.84-.44-1.13-.29-.29-.44-.65-.44-1.13a1.64 1.64 0 0 1 1.67-1.67h2c3.05 0 5.55-2.5 5.55-5.55C21.97 6.01 17.46 2 12 2z"/>',
  keyboard: '<rect width="20" height="16" x="2" y="4" rx="2"/><path d="M6 8h.01M10 8h.01M14 8h.01M18 8h.01M8 12h.01M12 12h.01M16 12h.01M7 16h10"/>',
  bot: '<path d="M12 8V4H8"/><rect width="16" height="12" x="4" y="8" rx="2"/><path d="M2 14h2M20 14h2M15 13v2M9 13v2"/>',
  copy: '<rect width="14" height="14" x="8" y="8" rx="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  shield: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>',
  shieldcheck: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><path d="m9 12 2 2 4-4"/>',
  compass: '<circle cx="12" cy="12" r="9"/><path d="m15.5 8.5-2 5-5 2 2-5z"/>',
  target: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1"/>',
  layers: '<path d="m12 2 9 5-9 5-9-5z"/><path d="m3 12 9 5 9-5"/><path d="m3 17 9 5 9-5"/>',
  monitor: '<rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8M12 17v4"/>',
  phone: '<rect x="6" y="2" width="12" height="20" rx="2.5"/><path d="M11 18h2"/>',
  panels: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M15 4v16M3 14h12"/>',
  gear: '<path d="M12.2 2h-.4a2 2 0 0 0-2 2v.2a2 2 0 0 1-1 1.7l-.4.3a2 2 0 0 1-2 0l-.2-.1a2 2 0 0 0-2.7.7l-.2.4a2 2 0 0 0 .7 2.7l.2.1a2 2 0 0 1 1 1.7v.5a2 2 0 0 1-1 1.7l-.2.1a2 2 0 0 0-.7 2.7l.2.4a2 2 0 0 0 2.7.7l.2-.1a2 2 0 0 1 2 0l.4.3a2 2 0 0 1 1 1.7v.2a2 2 0 0 0 2 2h.4a2 2 0 0 0 2-2v-.2a2 2 0 0 1 1-1.7l.4-.3a2 2 0 0 1 2 0l.2.1a2 2 0 0 0 2.7-.7l.2-.4a2 2 0 0 0-.7-2.7l-.2-.1a2 2 0 0 1-1-1.7v-.5a2 2 0 0 1 1-1.7l.2-.1a2 2 0 0 0 .7-2.7l-.2-.4a2 2 0 0 0-2.7-.7l-.2.1a2 2 0 0 1-2 0l-.4-.3a2 2 0 0 1-1-1.7V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/>',
  server: '<rect x="3" y="4" width="18" height="7" rx="1.5"/><rect x="3" y="13" width="18" height="7" rx="1.5"/><path d="M7 7.5h.01M7 16.5h.01"/>',
  bug: '<rect x="8" y="7" width="8" height="13" rx="4"/><path d="M12 7V4M4 13h4M16 13h4M5 8l3 2M19 8l-3 2M5 19l3-2M19 19l-3-2"/>',
  flask: '<path d="M9 3h6"/><path d="M10 3v6l-5 9a2 2 0 0 0 1.7 3h10.6a2 2 0 0 0 1.7-3l-5-9V3"/><path d="M7.5 15h9"/>',
  cloud: '<path d="M17.5 19a4.5 4.5 0 1 0-1.3-8.8A6 6 0 0 0 4.5 12a3.5 3.5 0 0 0 .5 7z"/>',
  zap: '<path d="M13 2 4 14h7l-1 8 9-12h-7z"/>',
  branch: '<circle cx="6" cy="5" r="2"/><circle cx="6" cy="19" r="2"/><circle cx="18" cy="8" r="2"/><path d="M6 7v10"/><path d="M18 10c0 4-6 3-11 7"/>',
  searchcheck: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/><path d="m8.5 11 1.8 1.8 3.2-3.3"/>',
  checkcircle: '<circle cx="12" cy="12" r="9"/><path d="m8.5 12 2.5 2.5 4.5-5"/>',
  database: '<ellipse cx="12" cy="5" rx="8" ry="3"/><path d="M4 5v14c0 1.7 3.6 3 8 3s8-1.3 8-3V5"/><path d="M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3"/>',
  chart: '<path d="M3 3v18h18"/><path d="M7 15v3M12 10v8M17 6v12"/>',
  pen: '<path d="m12 19 7-7 3 3-7 7z"/><path d="m18 13-1.5-7.5L2 2l3.5 14.5L13 18z"/><circle cx="11" cy="11" r="2"/>',
  pointer: '<path d="m4 4 7 17 2.5-7.5L21 11z"/>',
  filetext: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/><path d="M9 13h6M9 17h4"/>',
  type: '<path d="M4 7V5h16v2"/><path d="M12 5v14"/><path d="M9 19h6"/>',
  megaphone: '<path d="M3 11v2a1 1 0 0 0 1 1h2l5 4V6L6 10H4a1 1 0 0 0-1 1z"/><path d="M15 9a4 4 0 0 1 0 6"/><path d="M18 6a8 8 0 0 1 0 12"/>',
  book: '<path d="M4 19V5a2 2 0 0 1 2-2h13v16H6a2 2 0 0 0-2 2z"/><path d="M4 19a2 2 0 0 0 2 2h13"/>',
  lock: '<rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>',
  enter: '<polyline points="9 10 4 15 9 20"/><path d="M20 4v7a4 4 0 0 1-4 4H4"/>',
};
function icon(name, size = 16) {
  const s = document.createElement("span");
  s.className = "ico";
  s.innerHTML = `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.85" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name] ?? ""}</svg>`;
  return s;
}
/** Icon button with a tooltip (label + shortcut). o: { on, kbd, cls, disabled, badge, label, pos, size, native } */
function ibtn(name, tip, onclick, o = {}) {
  const text = o.kbd ? `${tip}   ${o.kbd}` : tip;
  return h("button", {
    type: "button", class: "ibtn" + (o.on ? " on" : "") + (o.cls ? " " + o.cls : ""), "aria-label": tip,
    "data-tip": o.native ? null : text, title: o.native ? text : null, "data-tip-pos": o.pos, disabled: o.disabled,
    "aria-pressed": o.on == null ? null : String(!!o.on), onclick,
  }, icon(name, o.size ?? 16), o.label ? h("span", { class: "ilabel" }, o.label) : null, o.badge ? h("span", { class: "ibadge" }, String(o.badge)) : null);
}
const kbd = (k) => h("span", { class: "kbd" }, k);
function hydrateIcons(root = document) {
  for (const el of root.querySelectorAll("[data-icon]")) { el.replaceChildren(icon(el.dataset.icon, Number(el.dataset.size || 16))); el.removeAttribute("data-icon"); }
}

// ---------- navigation: real back/forward history ----------
const nav = { i: 0, top: 0 };
try { nav.top = Number(sessionStorage.getItem("bp-nav-top") || 0); } catch {}
nav.i = history.state?.i ?? 0;
if (nav.top < nav.i) nav.top = nav.i;
history.replaceState({ i: nav.i }, "", location.hash || location.pathname);
/** Record where we are now: a new history entry, or replace the current one (same place, reconnects). */
function routeTo(hash, replace = false) {
  const here = location.hash || "";
  if (replace || here === hash) history.replaceState({ i: nav.i }, "", hash || location.pathname);
  else { nav.i++; nav.top = nav.i; history.pushState({ i: nav.i }, "", hash || location.pathname); }
  try { sessionStorage.setItem("bp-nav-top", String(nav.top)); } catch {}
  syncNavButtons();
}
function syncNavButtons() {
  for (const b of document.querySelectorAll(".nav-back")) b.disabled = nav.i <= 0;
  for (const b of document.querySelectorAll(".nav-fwd")) b.disabled = nav.i >= nav.top;
}
window.addEventListener("popstate", (ev) => {
  nav.i = ev.state?.i ?? 0;
  closeMenu?.(); closePalette();
  const m = location.hash.match(/^#\/t\/([\w-]+)/);
  if (m) openThread(m[1], false, true);
  else if (location.hash === "#/inbox") newThread(undefined, true);
  else if (location.hash === "#/teams") openTeams(true);
  else if (location.hash === "#/artifacts") openArtifacts(true);
  else if (location.hash.startsWith("#/a/")) openArtifact(location.hash.slice(4), true);
  else newThread(undefined, true);
  syncNavButtons();
});
let sideHidden = false;
try { sideHidden = localStorage.getItem("bp-side-hidden") === "1"; } catch {}
const isPhone = () => matchMedia("(max-width: 760px)").matches;
/** Engines this server can run: Claude, Codex, and any ACP agents installed (see ~/.bullpen/engines.json). */
let ENGINES = [{ id: "claude", name: "Claude" }, { id: "codex", name: "Codex" }];
const engineName = (id) => ENGINES.find((e) => e.id === id)?.name ?? id;
const engineOptions = () => ENGINES.map((e) => h("option", { value: e.id }, e.name));
function toggleSidebar() {
  // On a phone the sidebar slides over the page instead.
  if (isPhone()) { document.querySelector(".app").classList.toggle("side-open"); return; }
  sideHidden = !sideHidden;
  try { localStorage.setItem("bp-side-hidden", sideHidden ? "1" : ""); } catch {}
  document.querySelector(".app").classList.toggle("side-hidden", sideHidden);
  for (const b of document.querySelectorAll(".nav-side")) { b.setAttribute("data-tip", `${sideHidden ? "Show" : "Hide"} sidebar   ⌘\\`); b.setAttribute("aria-label", `${sideHidden ? "Show" : "Hide"} sidebar`); }
}
function navCluster() {
  return h("div", { class: "navc" },
    ibtn("sidebar", sideHidden ? "Show sidebar" : "Hide sidebar", toggleSidebar, { kbd: "⌘\\", cls: "nav-side", pos: "start" }),
    ibtn("back", "Back", () => history.back(), { kbd: "⌘[", cls: "nav-back", disabled: nav.i <= 0 }),
    ibtn("forward", "Forward", () => history.forward(), { kbd: "⌘]", cls: "nav-fwd", disabled: nav.i >= nav.top }));
}
/** A small dropdown under an element. items: {label, sub?, icon?|el?, run, danger?, active?, kbd?} | "-" | {header} */
function popMenu(anchor, items, align = "start") {
  closeMenu();
  const r = anchor.getBoundingClientRect();
  const m = h("div", { class: "menu", role: "menu", onclick: (ev) => ev.stopPropagation() }, ...items.map((it) =>
    it === "-" ? h("hr") : it.header ? h("div", { class: "mh" }, it.header) :
    h("button", { type: "button", role: "menuitem", disabled: Boolean(it.disabled), class: (it.danger ? "danger" : "") + (it.active ? " active" : "") + (it.disabled ? " info" : ""), onclick: () => { closeMenu(); it.run?.(); } },
      it.el ?? icon(it.icon ?? "chevright", 15),
      it.desc ? h("span", { class: "mt wrap" }, h("span", { class: "ml" }, it.label), h("span", { class: "md" }, it.desc)) : h("span", { class: "mt" }, it.label),
      it.sub ? h("span", { class: "ms" }, it.sub) : null, it.kbd ? kbd(it.kbd) : null)));
  document.body.append(m);
  const w = m.offsetWidth, hgt = m.offsetHeight;
  // No room below (a button at the bottom, like the message box toolbar): open upward instead of covering it.
  m.style.top = `${r.bottom + 6 + hgt > innerHeight - 8 && r.top - hgt - 6 >= 8 ? r.top - hgt - 6 : Math.min(r.bottom + 6, innerHeight - hgt - 8)}px`;
  m.style.left = `${align === "end" ? Math.max(8, r.right - w) : Math.max(8, Math.min(r.left, innerWidth - w - 8))}px`;
  m.style.maxHeight = `${innerHeight - 24}px`; m.style.overflowY = "auto";
  openMenu = m;
}
function crumb(content, onclick, tip) {
  return h("button", { type: "button", class: "crumb", onclick, "data-tip": tip, "data-tip-pos": "start" }, ...content, icon("chevdown", 13));
}
const crumbSep = () => h("span", { class: "crumb-sep" }, icon("chevright", 14));
function pageTopbar(iconName, title, sub, actions = []) {
  return h("div", { class: "topbar", id: "topbar" }, navCluster(),
    h("div", { class: "tb-title" }, h("div", { class: "crumbs-row" }, h("span", { class: "crumb-cur" }, icon(iconName, 16), h("span", { class: "tx" }, title))),
      sub ? h("div", { class: "tb-sub" }, sub) : null),
    h("span", { class: "spacer" }), ...actions.filter(Boolean));
}

function hue(name) { let x = 0; for (const ch of name) x = (x * 31 + ch.charCodeAt(0)) % 360; return x; }
/** Template id → [role icon, department]: an agent's tile shows what it does and which team it belongs to. */
const ROLES = {
  lead: ["compass", "lead"], product: ["target", "lead"], architect: ["layers", "lead"], planner: ["list", "lead"],
  frontend: ["monitor", "eng"], backend: ["server", "eng"], debugger: ["bug", "eng"], tester: ["flask", "eng"], refactorer: ["refresh", "eng"],
  devops: ["cloud", "eng"], performance: ["zap", "eng"], git: ["branch", "eng"],
  reviewer: ["searchcheck", "qa"], security: ["shield", "qa"], qa: ["checkcircle", "qa"],
  sql: ["database", "data"], analyst: ["chart", "data"],
  designer: ["pen", "design"], ux: ["pointer", "design"], brand: ["palette", "design"],
  docs: ["filetext", "content"], copywriter: ["type", "content"], marketing: ["megaphone", "content"], seo: ["search", "content"],
  researcher: ["book", "research"], "market-research": ["globe", "research"], finance: ["chart", "research"], privacy: ["lock", "research"],
};
function agentTile(agent, size = 22) {
  const role = agent?.templateId ? ROLES[agent.templateId] : null;
  const box = `width:${size}px;height:${size}px`;
  if (role) return h("span", { class: `atile d-${role[1]}`, style: box, "aria-hidden": "true" }, icon(role[0], Math.round(size * 0.6)));
  const name = String(agent?.displayName || agent?.name || "?").replace(/^@/, "");
  const init = name.split(/[\s_-]+/).filter(Boolean).slice(0, 2).map((w) => Array.from(w)[0]).join("").toUpperCase() || "?";
  return h("span", { class: "atile d-none", style: `${box};font-size:${Math.round(size * 0.42)}px`, "aria-hidden": "true" }, init);
}
function findAgent(label) {
  const n = String(label ?? "").replace(/^@/, "");
  return [...state.agents.values()].find((a) => a.name === n || a.displayName === label || a.displayName === n);
}
function badge(name) {
  return agentTile(findAgent(name) ?? { name: String(name ?? "?") });
}
function ago(iso) {
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}
function short(v, n = 140) {
  const s = typeof v === "string" ? v : JSON.stringify(v);
  return !s ? "" : s.length > n ? s.slice(0, n) + "…" : s;
}
function pretty(v) { return typeof v === "string" ? v : JSON.stringify(v, null, 2); }

/** Text with ``` fences and `inline code` rendered; everything else stays plain text. */
function richText(text) {
  const frag = document.createDocumentFragment();
  const parts = text.split(/```[^\n]*\n?/);
  parts.forEach((part, i) => {
    if (i % 2 === 1) { frag.append(h("pre", {}, h("code", {}, part.replace(/\n$/, "")))); return; }
    // Markdown-lite outside code blocks: `code`, **bold**, and "#" headings (rendered bold). Text only, no HTML.
    part.split(/(`[^`\n]+`)/).forEach((seg) => {
      if (/^`[^`]+`$/.test(seg)) { frag.append(h("code", {}, seg.slice(1, -1))); return; }
      seg = seg.replace(/^#{1,6}\s+(.+)$/gm, "**$1**");
      seg.split(/(\*\*[^*\n]+\*\*)/).forEach((bit) => {
        if (/^\*\*[^*]+\*\*$/.test(bit)) frag.append(h("strong", {}, bit.slice(2, -2)));
        else if (bit) frag.append(bit);
      });
    });
  });
  return frag;
}
/** User text with @mentions of known agents highlighted. */
function mentionText(text) {
  const frag = document.createDocumentFragment();
  text.split(/(@[a-z][a-z0-9-]{1,31})/).forEach((seg) => {
    if (seg.startsWith("@") && agentByName(seg.slice(1))) frag.append(h("span", { class: "mention" }, seg));
    else if (seg) frag.append(seg);
  });
  return frag;
}

function toast(text, opts = {}) {
  const el = h("div", { class: "toast" + (opts.error ? " err" : ""), onclick: () => { el.remove(); opts.onclick?.(); } }, text);
  $("toasts").append(el);
  setTimeout(() => el.remove(), opts.error ? 7000 : 5000);
}

// ---------- RPC over WebSocket ----------
let ws, nextId = 1, retry = 0;
const calls = new Map();
const subs = new Map(); // subscription -> handler
function call(method, params) {
  return new Promise((resolve, reject) => {
    if (!ws || ws.readyState !== 1) return reject(new Error("Not connected"));
    const id = nextId++;
    calls.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
}
const dispatch = (cmd) => call("dispatch", cmd);

function connect() {
  if (!TOKEN) { renderNoToken(); return; }
  ws = new WebSocket(`ws://${location.host}`, ["bullpen", `token.${TOKEN}`]);
  ws.onopen = async () => {
    retry = 0;
    $("conn").classList.add("on"); $("conn").title = "connected"; $("conn-text").textContent = "Server running";
    subs.clear();
    resetTerminalViews(); // their subscriptions died with the old connection
    try { ENGINES = await call("listEngines"); } catch {}
    checkForUpdate();
    await loadSidebar();
    checkProjectSuggestions(true);
    if (state.threadId) openThread(state.threadId, true);
    else if (state.view === "teams") renderTeams();
    else if (state.view === "artifacts") renderArtifacts();
    else if (state.view === "artifact") renderArtifact();
    else renderMain();
  };
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if ("subscription" in msg) return subs.get(msg.subscription)?.("items" in msg ? msg.items : msg);
    const c = calls.get(msg.id); if (!c) return;
    calls.delete(msg.id);
    "error" in msg ? c.reject(new Error(msg.error)) : c.resolve(msg.result);
  };
  ws.onclose = (ev) => {
    $("conn").classList.remove("on"); $("conn").title = "disconnected"; $("conn-text").textContent = "Not connected";
    if (state.stopping) return renderStopped();
    for (const c of calls.values()) c.reject(new Error("Disconnected"));
    calls.clear();
    if (ev.code === 1006 && retry > 3 && !state.everConnected) return renderNoToken();
    setTimeout(connect, Math.min(5000, 300 * 2 ** retry++));
  };
}

// ---------- state ----------
const state = {
  threads: new Map(),
  agents: new Map(),
  projects: new Map(),
  jobs: new Map(),
  jobRuns: new Map(), // recent runs seen live (for toasts and inbox counts)
  lessons: new Map(),
  settings: { briefingTime: "08:00", briefingEnabled: true, notifications: true },
  view: null, // "inbox" when the Inbox page is open
  projectFilter: "",
  showArchived: (() => { try { return !!localStorage.getItem("bp-show-archived"); } catch { return false; } })(),
  showAll: new Set(),
  approvals: new Map(), // threadId -> Map(requestId -> item)
  threadId: null,
  sub: null,
  thread: null,
  runs: new Map(),
  items: new Map(),
  order: [],
  seq: 0,
  everConnected: false,
};
const agentByName = (name) => [...state.agents.values()].find((a) => a.name === name);

function trackApproval(item) {
  let m = state.approvals.get(item.threadId);
  if (!m) state.approvals.set(item.threadId, (m = new Map()));
  if (item.status === "pending") m.set(item.requestId, item); else m.delete(item.requestId);
}

async function loadSidebar() {
  const snap = await call("subscribeSidebar");
  state.everConnected = true;
  state.threads = new Map(snap.threads.map((t) => [t.id, t]));
  state.agents = new Map(snap.agents.map((a) => [a.id, a]));
  state.projects = new Map(snap.projects.map((p) => [p.id, p]));
  state.jobs = new Map(snap.jobs.map((j) => [j.id, j]));
  state.lessons = new Map(snap.lessons.map((l) => [l.id, l]));
  state.artifacts = new Map((snap.artifacts ?? []).map((a) => [a.id, a]));
  state.settings = snap.settings;
  state.approvals = new Map();
  snap.pendingApprovals.forEach(trackApproval);
  subs.set(snap.subscription, (events) => {
    for (const { event: e } of events) {
      if (e.type === "thread.upserted") {
        const before = state.threads.get(e.thread.id);
        state.threads.set(e.thread.id, e.thread);
        if ((e.thread.team?.needsYou ?? 0) > (before?.team?.needsYou ?? 0) && e.thread.id !== state.threadId) {
          toast(`A team in “${e.thread.title}” needs you`, { onclick: () => openThread(e.thread.id) });
        }
      }
      else if (e.type === "agent.upserted") state.agents.set(e.agent.id, e.agent);
      else if (e.type === "agent.deleted") state.agents.delete(e.agentId);
      else if (e.type === "project.upserted") state.projects.set(e.project.id, e.project);
      else if (e.type === "project.removed") state.projects.delete(e.projectId);
      else if (e.type === "job.upserted") state.jobs.set(e.job.id, e.job);
      else if (e.type === "job.deleted") state.jobs.delete(e.jobId);
      else if (e.type === "jobrun.upserted") {
        state.jobRuns.set(e.run.id, e.run);
        if (e.run.status === "needs-you" && e.run.endedAt) toast(`${state.jobs.get(e.run.jobId)?.name ?? "A job"} needs you`, { onclick: () => openInbox() });
      } else if (e.type === "lesson.upserted") {
        const isNew = !state.lessons.has(e.lesson.id);
        if (e.lesson.status === "rejected") state.lessons.delete(e.lesson.id); else state.lessons.set(e.lesson.id, e.lesson);
        if (isNew && e.lesson.status === "proposed") {
          const a = e.lesson.agentId ? state.agents.get(e.lesson.agentId) : null;
          toast(`${a ? agentLabel(a) : "An agent"} suggested a lesson: “${e.lesson.text}”`, { onclick: () => openInbox() });
        }
      } else if (e.type === "lesson.deleted") state.lessons.delete(e.lessonId);
      else if (e.type === "artifact.upserted") state.artifacts.set(e.artifact.id, e.artifact);
      else if (e.type === "artifact.deleted") state.artifacts.delete(e.artifactId);
      else if (e.type === "setting.upserted") {
        const map = { "briefing.time": "briefingTime", "briefing.enabled": "briefingEnabled", "notifications": "notifications", "artifacts.claude": "claudeArtifacts", "artifacts.lastSync": "artifactsLastSync" };
        if (map[e.key]) state.settings[map[e.key]] = e.value;
      }
      else if (e.type === "turn-item.upserted" && e.item.kind === "approval_request") {
        const wasPending = state.approvals.get(e.item.threadId)?.has(e.item.requestId);
        trackApproval(e.item);
        // A reply card in the open chat may be waiting on this approval: redraw it.
        for (const it of state.items.values()) if (it.kind === "agent_reply" && it.status === "running" && (it.runThreadId ?? state.agents.get(it.agentId)?.homeThreadId) === e.item.threadId) upsertItemEl(it);
        if (e.item.status === "pending" && !wasPending && e.item.threadId !== state.threadId) {
          const t = state.threads.get(e.item.threadId);
          toast(`${t?.title ?? "A chat"} needs approval for ${e.item.tool}`, { onclick: () => openThread(e.item.threadId) });
        }
      } else if (e.type === "turn-item.upserted" && e.item.kind === "agent_reply" && e.item.status !== "running" && e.item.threadId !== state.threadId) {
        toast(`@${e.item.agentName} answered in ${state.threads.get(e.item.threadId)?.title ?? "a thread"}`, { onclick: () => openThread(e.item.threadId) });
      }
    }
    renderSidebar();
    if (state.threadId) { state.thread = state.threads.get(state.threadId) ?? state.thread; renderTopbar(); }
    else if (state.view === "teams") renderTeams();
    else if (state.view === "artifacts") renderArtifacts();
    else if (state.view === "artifact") renderArtifact(false);
    else refreshHome();
  });
  renderSidebar();
}

