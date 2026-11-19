// The sidebar: agents, jobs, projects and their chats, the project manager.
// Plain scripts sharing one global scope, loaded in order by index.html (no build step).

// ---------- sidebar ----------
function threadStatus(t) {
  const pending = (state.approvals.get(t.id)?.size ?? 0) + (t.team?.needsYou ?? 0);
  return h("span", { class: "status" },
    pending ? h("span", { class: "count attn", title: `${pending} waiting for you` }, pending) : null,
    !pending && (t.status === "running" || t.team?.active) ? h("span", { class: "sdot working", title: t.team?.active ? "a team is working" : "working" }) : null);
}
function renderSidebar() {
  const agents = [...state.agents.values()].sort((a, b) => a.name.localeCompare(b.name));
  $("agents").replaceChildren(...(agents.length ? agents.map((a) => {
    const home = state.threads.get(a.homeThreadId);
    // A div, not a button: it holds its own delete button.
    return h("div", { class: "row agent-row" + (state.threadId === a.homeThreadId ? " active" : ""), role: "button", tabindex: "0",
        onclick: () => openThread(a.homeThreadId), onkeydown: (ev) => { if (ev.key === "Enter" && ev.target === ev.currentTarget) openThread(a.homeThreadId); } },
      badge(agentLabel(a)),
      h("span", { class: "row-main" }, h("div", { class: "row-title" }, agentLabel(a)), h("div", { class: "row-sub" }, a.displayName ? "@" + a.name + (a.description ? " · " + a.description : "") : a.description || a.provider + (a.model ? " · " + a.model : ""))),
      home ? threadStatus(home) : null,
      h("span", { class: "hover" },
        h("button", { class: "icon-btn danger", title: `Delete ${agentLabel(a)}`, "aria-label": `Delete ${agentLabel(a)}`,
          onclick: (ev) => { ev.stopPropagation(); deleteAgent(a); } }, icon("trash", 13))));
  }) : [h("div", { class: "side-empty" }, "No agents yet. Create one, then @mention it anywhere.")]));

  renderJobs();
  renderProjects();
  const inboxN = inboxCount();
  $("inbox-count").replaceChildren(...(inboxN ? [h("span", { class: "count attn" }, String(inboxN))] : []));
  $("inbox-row").classList.toggle("active", !state.view && !state.threadId);
  const teamThreads = [...state.threads.values()].filter((t) => t.team?.active);
  const activeTeams = teamThreads.reduce((n, t) => n + t.team.active, 0);
  const teamsNeed = teamThreads.some((t) => t.team.needsYou);
  $("teams-count").replaceChildren(...(activeTeams ? [h("span", { class: "count" + (teamsNeed ? " attn" : ""), title: teamsNeed ? "A team needs you" : `${activeTeams} running` }, String(activeTeams))] : []));
  $("teams-row").classList.toggle("active", state.view === "teams" && !state.threadId);
  $("artifacts-row").classList.toggle("active", (state.view === "artifacts" || state.view === "artifact") && !state.threadId);
  const nArt = state.artifacts?.size ?? 0;
  $("artifacts-count").replaceChildren(...(nArt ? [h("span", { class: "count" }, String(nArt))] : []));
}

// ---------- jobs in the sidebar ----------
const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
function describeTrigger(t) {
  if (t.kind === "manual") return "When you run it";
  if (t.kind === "interval") return t.hours === 1 ? "Every hour" : `Every ${t.hours} hours`;
  if (t.kind === "commit") return `On commits to ${t.branch}`;
  const [hh, mm] = t.time.split(":").map(Number);
  const time = new Date(2000, 0, 1, hh, mm).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  if (!t.days?.length || t.days.length === 7) return `Daily ${time}`;
  if (t.days.join() === "1,2,3,4,5") return `Weekdays ${time}`;
  return `${t.days.map((d) => DAY_NAMES[d]).join(", ")} ${time}`;
}
function whenNext(iso) {
  if (!iso) return "";
  const d = new Date(iso), today = new Date();
  const time = d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  if (d.toDateString() === today.toDateString()) return `today ${time}`;
  const tomorrow = new Date(today); tomorrow.setDate(today.getDate() + 1);
  if (d.toDateString() === tomorrow.toDateString()) return `tomorrow ${time}`;
  return `${DAY_NAMES[d.getDay()]} ${time}`;
}
function renderJobs() {
  const jobs = [...state.jobs.values()].sort((a, b) => a.name.localeCompare(b.name));
  $("jobs").replaceChildren(...(jobs.length ? jobs.map((j) => {
    const agent = state.agents.get(j.agentId);
    const status = j.lastStatus === "running" ? "running" : j.lastStatus;
    const sub = !j.enabled ? "Paused" : j.lastStatus === "running" ? "Running now" : j.nextRunAt ? `Next ${whenNext(j.nextRunAt)}` : describeTrigger(j.trigger);
    return h("button", { class: "row" + (state.threadId === j.threadId ? " active" : ""), onclick: () => openThread(j.threadId), title: `${describeTrigger(j.trigger)} · ${agent ? agentLabel(agent) : "?"}` },
      h("span", { class: "job-ic" }, icon("clock", 15)),
      h("span", { class: "row-main" }, h("div", { class: "row-title" }, j.name), h("div", { class: "row-sub" }, `${agent ? agentLabel(agent) : "?"} · ${sub}`)),
      status ? h("span", { class: "dot " + status, title: status }) : null);
  }) : [h("div", { class: "side-empty" }, "No jobs yet. Give an agent something to do on its own.")]));
}
/** The one count of things waiting on you: the same list Home shows (approvals, teams, jobs, lessons). */
function inboxCount() {
  return homeData().needs.length;
}

// ---------- projects in the sidebar (T3 "folder" mode) ----------
const collapsed = {
  get() { try { return new Set(JSON.parse(localStorage.getItem("bp-collapsed") || "[]")); } catch { return new Set(); } },
  toggle(id) { const s = collapsed.get(); s.has(id) ? s.delete(id) : s.add(id); try { localStorage.setItem("bp-collapsed", JSON.stringify([...s])); } catch {} },
};
/** T3's monogram: first letter, plus a digit or the last word's first letter or the last letter. */
function monogram(name) {
  const words = name.replace(/([a-z])([A-Z])/g, "$1 $2").split(/[\s\-_.]+/).filter(Boolean);
  const first = (words[0] || name || "?")[0];
  const digit = name.match(/\d/)?.[0];
  const second = digit ?? (words.length > 1 ? words[words.length - 1][0] : (name.length > 1 ? name[name.length - 1] : ""));
  const hueN = hue(name);
  return h("span", { class: "monogram", style: `background:hsl(${hueN} 70% 50% / 0.16);color:hsl(${hueN} 75% 62%)` }, (first + second).toUpperCase());
}
function projectIcon(p) {
  const mono = monogram(p.title);
  const img = h("img", { class: "proj-icon", src: `/project-icon/${p.id}`, alt: "", loading: "lazy" });
  img.addEventListener("error", () => img.replaceWith(mono));
  return img;
}
const activity = (t) => t.updatedAt || t.createdAt;
/** When you last worked in a project: its newest thread, or its last Claude Code session, or when it was added. */
const lastWork = ({ p, threads }) => [threads[0] ? activity(threads[0]) : "", p.lastUsedAt || ""].sort().pop();
/** The most urgent thing in a set of threads: needs you > working > failed. */
function urgency(threads) {
  if (threads.some((t) => state.approvals.get(t.id)?.size || t.team?.needsYou)) return "attention";
  if (threads.some((t) => t.status === "running" || t.team?.active)) return "working";
  return null;
}
function renderProjects() {
  const homes = new Set([...state.agents.values()].map((a) => a.homeThreadId));
  const threads = [...state.threads.values()].filter((t) => !homes.has(t.id) && !(t.jobId && state.jobs.has(t.jobId)));
  const byPath = new Map();
  for (const t of threads) { if (!byPath.has(t.cwd)) byPath.set(t.cwd, []); byPath.get(t.cwd).push(t); }
  for (const list of byPath.values()) list.sort((a, b) => activity(b).localeCompare(activity(a)));
  const q = state.projectFilter.trim().toLowerCase();
  const showArchived = state.showArchived;
  const archivedCount = [...state.projects.values()].filter((p) => p.archivedAt).length;
  const projects = [...state.projects.values()]
    .filter((p) => !p.archivedAt || showArchived)
    .map((p) => ({ p, threads: byPath.get(p.path) ?? [] }))
    .filter(({ p }) => !q || p.title.toLowerCase().includes(q) || p.path.toLowerCase().includes(q))
    .sort((a, b) =>
      (a.p.archivedAt ? 1 : 0) - (b.p.archivedAt ? 1 : 0) ||
      (b.p.pinnedAt ? 1 : 0) - (a.p.pinnedAt ? 1 : 0) ||
      (a.p.pinnedAt && b.p.pinnedAt ? a.p.pinnedAt.localeCompare(b.p.pinnedAt) : 0) ||
      lastWork(b).localeCompare(lastWork(a)));
  const closed = collapsed.get();
  const children = [];
  if (state.projects.size > 8) {
    const filter = h("input", { class: "proj-filter", type: "search", placeholder: "Filter projects", value: state.projectFilter });
    filter.addEventListener("input", () => { state.projectFilter = filter.value; renderProjects(); const f = $("threads").querySelector(".proj-filter"); f?.focus(); f?.setSelectionRange(f.value.length, f.value.length); });
    children.push(filter);
  }
  let prev = null;
  for (const { p, threads: list } of projects) {
    // A line under the pinned projects, and above the archived ones.
    if (prev && ((prev.pinnedAt && !p.pinnedAt) || (!prev.archivedAt && p.archivedAt))) children.push(h("div", { class: "proj-divider" }));
    prev = p;
    const isClosed = closed.has(p.id);
    const hasActive = list.some((t) => t.id === state.threadId);
    const u = urgency(list);
    const shown = state.showAll.has(p.id) ? list : list.slice(0, 5);
    const empty = !list.length;
    const folder = h("div", { class: "folder" + ((isClosed && !hasActive) || empty ? " collapsed" : "") + (p.archivedAt ? " archived" : "") },
      h("div", { class: "folder-head" + (empty ? " no-threads" : ""), role: "button", tabindex: "0",
          title: empty ? `${p.path}\nClick to start working here` : p.path,
          onclick: () => { if (empty) newThread(p.path); else { collapsed.toggle(p.id); renderProjects(); } },
          oncontextmenu: (ev) => { ev.preventDefault(); projectMenu(p, ev.clientX, ev.clientY); } },
        h("span", { class: "chev" }, icon("chevdown", 12)),
        projectIcon(p),
        h("span", { class: "title" }, p.title),
        h("span", { class: "meta" }, ...[isClosed && u ? h("span", { class: "sdot " + u }) : null, isClosed && list.length ? String(list.length) : null, p.pinnedAt ? h("span", { class: "pin-mark", title: "Pinned" }, icon("star", 11)) : null].filter(Boolean)),
        h("span", { class: "hover" },
          h("button", { class: "icon-btn" + (p.pinnedAt ? " on" : ""), title: p.pinnedAt ? "Unpin" : "Pin to top",
            onclick: (ev) => { ev.stopPropagation(); dispatch({ type: "project.update", projectId: p.id, pinned: !p.pinnedAt }).catch(fail); } }, icon("star", 13)),
          h("button", { class: "icon-btn", title: `New chat in ${p.title}`,
            onclick: (ev) => { ev.stopPropagation(); newThread(p.path); } }, icon("plus", 14)),
          h("button", { class: "icon-btn", title: "More", "aria-label": "More actions",
            onclick: (ev) => { ev.stopPropagation(); const r = ev.currentTarget.getBoundingClientRect(); projectMenu(p, r.left, r.bottom + 4); } }, icon("more", 14)))),
      h("div", { class: "folder-body" },
        ...shown.map((t) => {
          const st = state.approvals.get(t.id)?.size || t.team?.needsYou ? "attention" : t.status === "running" || t.team?.active ? "working" : null;
          return h("button", { class: "trow" + (state.threadId === t.id ? " active" : ""), onclick: () => openThread(t.id), title: t.title },
            st ? h("span", { class: "sdot " + st }) : null,
            h("span", { class: "t" }, t.title),
            h("span", { class: "when" }, ago(activity(t)).replace(" ago", "")));
        }),
        list.length > shown.length ? h("button", { class: "more-link", onclick: () => { state.showAll.add(p.id); renderProjects(); } }, `Show ${list.length - shown.length} more`) : null));
    children.push(folder);
  }
  if (!state.projects.size) {
    children.push(h("div", { class: "side-empty" }, "No projects yet. ",
      h("button", { class: "link", onclick: () => newProject(true) }, "Create one"), ", or ", h("button", { class: "link", onclick: openImport }, "pick from this Mac"), "."));
  } else if (!projects.length) {
    children.push(h("div", { class: "side-empty" }, q ? "No matching projects." : "Every project is archived. ",
      q ? null : h("button", { class: "link", onclick: openImport }, "Choose projects")));
  }
  if (archivedCount && !q) {
    children.push(h("button", { class: "archived-toggle", onclick: () => { state.showArchived = !state.showArchived; try { localStorage.setItem("bp-show-archived", state.showArchived ? "1" : ""); } catch {} renderProjects(); } },
      state.showArchived ? `Hide archived (${archivedCount})` : `Archived (${archivedCount})`));
  }
  $("threads").replaceChildren(...children);
}
let openMenu = null;
function closeMenu() { openMenu?.remove(); openMenu = null; }
document.addEventListener("click", closeMenu);
document.addEventListener("keydown", (ev) => { if (ev.key === "Escape") closeMenu(); });
function projectMenu(p, x, y) {
  closeMenu();
  const act = (fn) => (ev) => { ev.stopPropagation(); closeMenu(); fn(); };
  const update = (patch) => dispatch({ type: "project.update", projectId: p.id, ...patch }).catch(fail);
  const menu = h("div", { class: "menu", role: "menu" },
    h("button", { onclick: act(() => newThread(p.path)) }, "New chat here"),
    h("button", { onclick: act(() => update({ pinned: !p.pinnedAt })) }, p.pinnedAt ? "Unpin" : "Pin to top"),
    h("button", { onclick: act(() => update({ archived: !p.archivedAt })) }, p.archivedAt ? "Unarchive" : "Archive (hide)"),
    h("button", { onclick: act(() => navigator.clipboard?.writeText(p.path).then(() => toast("Path copied."))) }, "Copy path"),
    h("hr"),
    h("div", { class: "mh" }, "Agents working here"),
    ...Object.entries(MODE_INFO).map(([m, info]) => h("button", { class: (p.runtimeMode ?? "approval-required") === m ? "active" : "", onclick: act(() => setProjectMode(p, m)) },
      icon((p.runtimeMode ?? "approval-required") === m ? "check" : info.icon, 15), h("span", { class: "mt" }, info.label))),
    h("div", { class: "mh" }, "Branches"),
    h("button", { onclick: act(() => dispatch({ type: "project.update", projectId: p.id, isolateTasks: p.isolateTasks === false }).then(() =>
        toast(p.isolateTasks === false ? "Team tasks each get their own worktree, merged in when accepted." : "Team tasks share the project folder.")).catch(fail)) },
      icon(p.isolateTasks === false ? "layers" : "check", 15), h("span", { class: "mt" }, "Team tasks in their own worktrees")),
    h("button", { onclick: act(() => {
        const v = prompt("Run this in every new worktree before agents start (e.g. npm install). node_modules and .env files are linked/copied automatically.", p.worktreeSetup ?? "");
        if (v !== null) dispatch({ type: "project.update", projectId: p.id, worktreeSetup: v }).then(() => toast(v.trim() ? "Setup command saved." : "No setup command.")).catch(fail);
      }) }, icon("terminal", 15), h("span", { class: "mt" }, p.worktreeSetup ? "Worktree setup: " + p.worktreeSetup.slice(0, 24) : "Worktree setup command…")),
    h("hr"),
    h("button", { class: "danger", onclick: act(() => removeProject(p)) }, "Remove from Bullpen…"));
  document.body.append(menu);
  const r = menu.getBoundingClientRect();
  menu.style.left = Math.min(x, innerWidth - r.width - 8) + "px";
  menu.style.top = Math.min(y, innerHeight - r.height - 8) + "px";
  openMenu = menu;
}
async function removeProject(p) {
  if (!confirm(`Remove ${p.title} from the sidebar? Its chats and files are kept; it comes back if you start a chat there.`)) return;
  try { await dispatch({ type: "project.remove", projectId: p.id }); } catch (err) { fail(err); }
}

// ---------- project manager: choose what shows in the sidebar ----------
let importRows = [];
async function openImport() {
  $("import-filter").value = "";
  $("import-list").replaceChildren(h("div", { class: "picker-empty" }, "Scanning your folders…"));
  $("import-dialog").showModal();
  try { importRows = await call("importCandidates"); } catch (err) { $("import-dialog").close(); return fail(err); }
  for (const r of importRows) { r.show = r.added && !r.archived; r.pin = r.pinned; }
  renderImport();
}
function renderImport() {
  const q = $("import-filter").value.trim().toLowerCase();
  const match = (r) => !q || r.name.toLowerCase().includes(q) || r.where.toLowerCase().includes(q);
  const groups = [
    ["In Documents", (r) => r.location === "documents"],
    ["In your home folder", (r) => r.location === "home"],
    ["Elsewhere", (r) => r.location === "elsewhere"],
  ];
  const children = [];
  for (const [title, inGroup] of groups) {
    const rows = importRows.filter((r) => inGroup(r) && match(r));
    if (!rows.length) continue;
    children.push(h("div", { class: "import-group" }, `${title} (${rows.length})`));
    for (const r of rows) {
      const box = h("input", { type: "checkbox", checked: r.show });
      box.addEventListener("change", () => { r.show = box.checked; if (!r.show) r.pin = false; renderImport(); });
      const pin = h("button", { type: "button", class: "pin" + (r.pin ? " on" : ""), title: r.pin ? "Unpin" : "Pin to top", disabled: !r.show },
        r.pin ? "★" : "☆");
      pin.addEventListener("click", (ev) => { ev.preventDefault(); r.pin = !r.pin; renderImport(); });
      const info = [r.where, r.sessions ? `${r.sessions} Claude session${r.sessions === 1 ? "" : "s"}` : null, r.lastUsedAt ? `used ${ago(r.lastUsedAt)}` : null, r.archived ? "archived" : null].filter(Boolean).join(" · ");
      children.push(h("label", { class: "import-row" }, box, monogram(r.name),
        h("span", { class: "row-main", style: "flex:1" }, h("div", { class: "row-title" }, r.name), h("div", { class: "faint" }, info)), pin));
    }
  }
  if (!children.length) children.push(h("div", { class: "picker-empty" }, q ? "No matching folders." : "Nothing found."));
  $("import-list").replaceChildren(...children);
  updateImportCount();
}
function importChanges() {
  return {
    add: importRows.filter((r) => r.show && !r.added),
    archive: importRows.filter((r) => !r.show && r.added && !r.archived),
    unarchive: importRows.filter((r) => r.show && r.archived),
    pin: importRows.filter((r) => r.added && r.pin !== r.pinned),
    newPins: importRows.filter((r) => !r.added && r.show && r.pin),
  };
}
function updateImportCount() {
  const shown = importRows.filter((r) => r.show).length;
  const c = importChanges();
  const changes = c.add.length + c.archive.length + c.unarchive.length + c.pin.length + c.newPins.length;
  $("import-count").textContent = `${shown} shown`;
  $("import-go").textContent = changes ? `Save ${changes} change${changes === 1 ? "" : "s"}` : "Save";
  $("import-go").disabled = !changes;
}
const setImport = (fn) => {
  const q = $("import-filter").value.trim().toLowerCase();
  for (const r of importRows) if (!q || r.name.toLowerCase().includes(q) || r.where.toLowerCase().includes(q)) { r.show = fn(r); if (!r.show) r.pin = false; }
  renderImport();
};
$("import-all").addEventListener("click", () => setImport(() => true));
$("import-none").addEventListener("click", () => setImport(() => false));
$("import-filter").addEventListener("input", renderImport);
$("import-add-folder").addEventListener("click", async () => {
  const path = await pickFolder();
  if (!path) return;
  try {
    await dispatch({ type: "project.add", path });
    importRows = await call("importCandidates");
    for (const r of importRows) { r.show = r.added && !r.archived; r.pin = r.pinned; }
    renderImport();
    toast(`Added ${folderName(path)}.`);
  } catch (err) { fail(err); }
});
$("import-form").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const c = importChanges();
  try {
    if (c.add.length) await dispatch({ type: "project.import", projects: c.add.map((r) => ({ path: r.path, lastUsedAt: r.lastUsedAt })) });
    if (c.archive.length || c.unarchive.length) {
      await dispatch({ type: "project.bulk", archive: c.archive.map((r) => r.projectId), unarchive: c.unarchive.map((r) => r.projectId) });
    }
    for (const r of c.pin) await dispatch({ type: "project.update", projectId: r.projectId, pinned: r.pin });
    if (c.newPins.length) {
      // Freshly added projects: look up their ids, then pin.
      const fresh = await call("importCandidates");
      for (const r of c.newPins) {
        const id = fresh.find((f) => f.path === r.path)?.projectId;
        if (id) await dispatch({ type: "project.update", projectId: id, pinned: true });
      }
    }
    $("import-dialog").close();
    const parts = [c.add.length && `${c.add.length} added`, c.archive.length && `${c.archive.length} archived`, c.unarchive.length && `${c.unarchive.length} restored`, (c.pin.length + c.newPins.length) && "pins updated"].filter(Boolean);
    toast(parts.join(", ") + ".");
  } catch (err) { fail(err); }
});


