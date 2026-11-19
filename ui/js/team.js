// Teams: the team card, the live team panel, the Teams page.
// Plain scripts sharing one global scope, loaded in order by index.html (no build step).

// ---------- team card ----------
const teamUi = new Map(); // goalId -> { board: bool, open: Set(taskId) }
const GOAL_LABEL = { planning: "Planning", working: "Working", paused: "Paused", stuck: "Stuck", done: "Done", cancelled: "Stopped", failed: "Failed" };
const TASK_LABEL = { queued: "Up next", waiting: "Waiting", working: "Working", submitted: "Being checked", changes: "Fixing after review", accepted: "Done", parked: "Stuck", paused: "Paused", cancelled: "Cancelled" };
/** Who has to act for a task to move: shown next to its status. */
function taskNext(t) {
  if (t.approvals.length) return "your OK";
  if (t.status === "parked") return "your call";
  if (t.status === "submitted") return "the lead";
  if (t.status === "paused") return "resumes on its own";
  return "";
}
function since(iso) {
  if (!iso) return "";
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  return s < 60 ? `${Math.floor(s)}s` : s < 3600 ? `${Math.floor(s / 60)}m` : `${Math.floor(s / 3600)}h${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}`;
}
function elapsed(task) {
  const end = task.endedAt ? new Date(task.endedAt).getTime() : Date.now();
  return task.startedAt ? since(new Date(Date.now() - (end - new Date(task.startedAt).getTime())).toISOString()) : "";
}
function taskPill(t) {
  const label = t.status === "waiting" && t.dependsOn.length ? `After ${t.dependsOn.join(", ")}` : TASK_LABEL[t.status];
  const next = taskNext(t);
  return h("span", { class: "pill " + t.status, title: next ? `Waiting on ${next}` : "" }, t.status === "working" ? h("span", { class: "pulse" }) : null,
    label + (t.status === "changes" && t.conflicts?.length ? " (clash)" : "") + (next && next !== "the lead" ? ` · waiting on ${next}` : ""));
}
/** " · 2 of 4 at once · ~6 min each": how fast the team is going. */
function speedText(g) {
  if (!g.speed) return "";
  return [g.speed.working ? ` · ${g.speed.working} of ${g.speed.max} at once` : "", g.speed.avgTaskMin ? ` · ~${g.speed.avgTaskMin} min each` : ""].join("");
}
function teamCard(g, redraw, opts = {}) {
  const u = teamUi.get(g.goalId) ?? { board: false, open: new Set() };
  teamUi.set(g.goalId, u);
  const rerender = redraw ?? (() => upsertItemEl(state.items.get(`team:${g.goalId}`)));
  const accepted = g.tasks.filter((t) => t.status === "accepted").length;
  const counted = g.tasks.filter((t) => t.status !== "cancelled").length || 1;
  const open = ["planning", "working", "paused", "stuck"].includes(g.status);
  const lead = state.agents.get(g.leadAgentId);
  const needs = g.tasks.reduce((n, t) => n + t.approvals.length + (t.status === "parked" ? 1 : 0), 0) + (g.status === "stuck" ? 1 : 0);
  const head = h("div", { class: "team-head" },
    badge(g.leadName),
    h("div", { class: "t-title" }, h("b", {}, g.title), h("span", {}, `${g.leadName} is leading · ${g.tasks.length} task${g.tasks.length === 1 ? "" : "s"} · ${accepted} done${speedText(g)}`)),
    h("span", { class: "pill " + (needs && open ? "needs" : g.status) }, open && g.status === "working" ? h("span", { class: "pulse" }) : null,
      (needs && open ? `Needs you (${needs})` : GOAL_LABEL[g.status]) + (open ? ` · ${since(g.startedAt)}` : "")),
    h("span", { class: "seg-mini" },
      h("button", { class: u.board ? "" : "on", onclick: () => { u.board = false; rerender(); } }, "List"),
      h("button", { class: u.board ? "on" : "", onclick: () => { u.board = true; rerender(); } }, "Board")),
    open ? h("button", { class: "btn danger", onclick: () => { if (confirm("Stop this team? Running tasks are interrupted; finished work stays.")) dispatch({ type: "goal.cancel", goalId: g.goalId }).catch(fail); } }, "Stop") : null);
  const note = g.note && open ? h("div", { class: "team-note" }, g.note) : null;
  const rounds = g.rounds ? h("details", { class: "team-rounds" },
    h("summary", {}, h("b", {}, `Pass ${g.rounds.round} of ${g.rounds.max}`), h("span", {}, " · keeps improving until done"), g.rounds.reports.length ? h("span", { class: "faint" }, ` · ${g.rounds.reports.length} pass report${g.rounds.reports.length === 1 ? "" : "s"}`) : null),
    h("div", { class: "lbl" }, "Done means"), h("div", { class: "sum" }, richText(g.rounds.criteria ?? "")),
    ...g.rounds.reports.map((r, i) => h("div", {}, h("div", { class: "lbl" }, `Pass ${i + 1}`), h("div", { class: "sum" }, richText(r))))) : null;
  const leadLine = open && g.lead?.busy && g.lead.activity
    ? h("div", { class: "lead-live" }, badge(g.leadName),
        activityLine(g.lead.activity, { label: g.tasks.length ? `${g.leadName} is reviewing` : `${g.leadName} is planning`, compact: true }),
        g.lead.threadId ? h("button", { class: "link", onclick: () => openThread(g.lead.threadId) }, "Watch") : null)
    : null;
  const progress = h("div", { class: "team-progress" }, h("i", { style: `width:${Math.round((accepted / counted) * 100)}%` }));
  const body = u.board ? teamBoard(g, u, rerender) : teamList(g, u, rerender, opts);
  const log = state.order.map((id) => state.items.get(id)).filter((i) => i?.kind === "note" && i.team && i.runId === `team:${g.goalId}`);
  const logBox = log.length ? h("details", { class: "team-log", open: u.log || undefined, ontoggle: (ev) => { u.log = ev.currentTarget.open; } },
    h("summary", {}, `What happened (${log.length})`),
    h("div", { class: "team-log-list" }, ...log.slice(-60).map((i) => {
      const a = i.agentId ? state.agents.get(i.agentId) : null;
      return h("div", { class: "team-ev" + (i.progress ? " progress" : "") }, a ? agentTile(a, 16) : icon("users", 13), h("span", {}, i.text));
    }))) : null;
  const access = state.thread ? projectAt(state.thread.cwd)?.runtimeMode : undefined;
  const foot = h("div", { class: "team-foot" },
    access === "full-access"
      ? "Agents work in parallel, each in its own copy, and run anything without asking (this project has full access)."
      : "Agents work in parallel, each in its own copy; edits and tests run without asking, anything else waits for you here.",
    h("span", { class: "spacer" }),
    lead ? h("button", { class: "link", onclick: () => openThread(g.lead?.threadId ?? lead.homeThreadId) }, "Watch the lead") : null);
  return h("div", { class: "team" }, head, note, rounds, progress, leadLine, body, logBox, open ? foot : null);
}
function approvalBox(t) {
  return t.approvals.map((a) => {
    const answer = (decision) => dispatch({ type: "runtime-request.respond", threadId: a.threadId, requestId: a.requestId, decision }).catch(fail);
    const l = toolLabel(a.tool, a.input);
    return h("div", { class: "needs" },
      h("div", { class: "needs-t" }, `${t.agentName} wants to ${l.ask}`),
      h("pre", { class: "mono" }, l.code),
      h("div", { class: "approval-actions" },
        h("button", { class: "btn sm", onclick: () => answer("decline") }, "Deny"),
        h("button", { class: "btn sm", onclick: () => answer("acceptForSession") }, "Always allow"),
        h("button", { class: "btn sm primary", onclick: () => answer("accept") }, "Allow")));
  });
}
function taskDetail(t) {
  return h("div", { class: "trow2-detail" },
    t.error ? h("div", { class: "error-item" }, t.error) : null,
    t.reviewNotes ? h("div", {}, h("div", { class: "lbl" }, "Sent back with"), h("div", { class: "sum" }, t.reviewNotes)) : null,
    t.summary ? h("div", {}, h("div", { class: "lbl" }, "Submission"), h("div", { class: "sum" }, richText(t.summary))) : null,
    t.filesTouched?.length ? h("div", {}, h("div", { class: "lbl" }, "Files touched"), h("div", { class: "files" }, t.filesTouched.join("  ·  "))) : null,
    h("div", { class: "acts" },
      t.runThreadId ? h("button", { class: "btn", onclick: () => openThread(t.runThreadId) }, `Watch ${t.agentName}`) : null,
      ["parked", "paused"].includes(t.status) ? h("button", { class: "btn primary", onclick: () => dispatch({ type: "task.retry", taskId: t.id }).catch(fail) }, "Retry") : null));
}
function teamList(g, u, rerender, opts = {}) {
  return h("div", { class: "trows" }, ...g.tasks.map((t) => {
    const isOpen = u.open.has(t.id);
    return h("div", { class: "trow2" },
      h("button", { class: "trow2-main", onclick: () => { isOpen ? u.open.delete(t.id) : u.open.add(t.id); rerender(); } },
        h("span", { class: "ref" }, t.ref),
        h("span", { class: "who" }, badge(t.agentName), h("span", {}, t.agentName)),
        h("span", { class: "what" }, t.title, t.partial ? h("small", { title: "Submitted at its time budget: see what's left in the submission" }, "ran out of time") : null, t.round ? h("small", {}, "fixed after review") : null, t.autoAccept ? h("small", { title: "Accepted when submitted, without a review by the lead" }, "not checked") : null),
        taskPill(t),
        h("span", { class: "el", "data-since": t.status === "working" ? t.startedAt : "" }, elapsed(t))),
      t.status === "working" && t.activity ? h("div", { class: "trow2-live" },
        activityLine(t.activity, { label: t.wrapping ? "Out of time, wrapping up" : "Working", compact: true }),
        t.budgetMs ? h("div", { class: "budget", title: `Time budget: ${Math.round(t.budgetMs / 60000)} minutes, then it submits what it has` },
          h("i", { "data-budget": `${t.activity.startedAt}|${t.budgetMs}` })) : null) : null,
      ...(opts.approvalsAbove ? [] : approvalBox(t)), // in the Team panel they're in the "needs you" list above
      isOpen ? taskDetail(t) : null);
  }), g.tasks.length ? null : h("div", { class: "files-note" }, "The lead is planning…"));
}
function teamBoard(g, u, rerender) {
  const cols = [
    ["To do", ["queued", "waiting", "paused", "parked"]],
    ["Working", ["working", "changes"]],
    ["In review", ["submitted"]],
    ["Done", ["accepted", "cancelled"]],
  ];
  return h("div", { class: "board" }, ...cols.map(([title, sts]) => {
    const list = g.tasks.filter((t) => sts.includes(t.status));
    return h("div", { class: "bcol" }, h("h5", {}, title, h("span", {}, String(list.length))),
      ...list.map((t) => h("div", { class: "bcard", onclick: () => { u.board = false; u.open.add(t.id); rerender(); } },
        h("div", { class: "b-top" }, h("span", { class: "mono" }, t.ref), badge(t.agentName), h("span", {}, t.agentName)),
        h("div", {}, t.title),
        h("div", { class: "badge" }, taskPill(t)))));
  }));
}
// Keep every live timer fresh without re-rendering: "3m 12s", budget bars.
const clock = (iso) => {
  const s = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
  return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s` : `${Math.floor(s / 3600)}h ${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}m`;
};
setInterval(() => {
  for (const el of document.querySelectorAll(".trow2 .el[data-since]")) {
    const iso = el.getAttribute("data-since");
    if (iso) el.textContent = since(iso);
  }
  for (const el of document.querySelectorAll("[data-clock]")) el.textContent = clock(el.getAttribute("data-clock"));
  for (const el of document.querySelectorAll("[data-budget]")) {
    const [start, ms] = el.getAttribute("data-budget").split("|");
    const used = (Date.now() - new Date(start).getTime()) / Number(ms);
    el.style.width = `${Math.min(100, Math.round(used * 100))}%`;
    el.classList.toggle("late", used > 0.8);
  }
}, 1000);
/** "Asks first" / "Builds automatically" for a running turn; click for what decided it. */
function accessChip(access) {
  if (!access) return null;
  const text = MODE_SHORT[access.mode] + (access.team && access.mode !== "full-access" ? " + team rules" : "");
  return h("button", { type: "button", class: "access-chip " + access.mode, title: "What it may do without asking. Click for why.",
    onclick: (ev) => { ev.stopPropagation(); popMenu(ev.currentTarget, [{ header: "Why it has this access" }, ...access.reasons.map((r) => ({ icon: "shield", label: r, disabled: true }))]); } },
    icon(MODE_INFO[access.mode]?.icon ?? "shield", 11), text);
}
/** "Working · 2m 14s · 18 steps · Editing src/app.ts" plus the latest progress note: live while an agent works. */
function activityLine(a, opts = {}) {
  if (!a) return null;
  const step = a.last ? toolLabel(a.last.tool, a.last.input) : null;
  return h("div", { class: "act-line" + (opts.compact ? " compact" : "") },
    h("span", { class: "act-spin" }),
    h("span", { class: "act-what" }, opts.label ?? "Working", " · ", h("span", { "data-clock": a.startedAt }, clock(a.startedAt)),
      a.steps ? ` · ${a.steps} step${a.steps === 1 ? "" : "s"}` : ""),
    accessChip(a.access),
    step ? h("span", { class: "act-now" }, icon(step.icon, 12), h("span", {}, `${step.verb} ${step.detail}`.trim())) : null,
    a.note ? h("div", { class: "act-note" }, icon("message", 12), h("span", {}, a.note)) : null);
}

// ---------- artifacts: pages agents made here, and your claude.ai artifacts ----------
const artFilter = { source: "all", q: "" };
function leaveThread() {
  if (state.sub) call("unsubscribe", { subscription: state.sub }).catch(() => {});
  state.sub = null; state.threadId = null; state.thread = null;
}
function openArtifacts(fromHistory = false) {
  leaveThread(); state.view = "artifacts";
  if (!fromHistory) routeTo("#/artifacts");
  renderSidebar(); renderArtifacts(true);
}
function openArtifact(id, fromHistory = false) {
  leaveThread(); state.view = "artifact"; state.artifactId = id; state.artifactVersion = null;
  if (!fromHistory) routeTo(`#/a/${id}`);
  renderSidebar(); renderArtifact(true);
}
$("artifacts-row").addEventListener("click", () => openArtifacts());
const artAuthor = (a) => {
  if (a.source === "claude") return { el: h("span", { class: "src-claude" }, "claude.ai"), text: a.owner === "shared" ? "Shared with you on claude.ai" : "Your claude.ai artifact" };
  const agent = a.agentId ? state.agents.get(a.agentId) : null;
  return { el: agent ? agentTile(agent, 18) : icon("bot", 14), text: agent ? agentLabel(agent) : "Made in Bullpen" };
};
function syncArtifacts(btn) {
  if (btn) { btn.disabled = true; btn.lastChild.textContent = "Syncing…"; }
  toast("Asking Claude Code for your claude.ai artifacts…");
  dispatch({ type: "artifacts.sync" })
    .then((r) => toast(r.added ? `Pulled in ${r.added} new artifact${r.added === 1 ? "" : "s"} from claude.ai.` : `Up to date with claude.ai (${r.total}).`))
    .catch(fail)
    .finally(() => { if (btn?.isConnected) { btn.disabled = false; btn.lastChild.textContent = "Sync with claude.ai"; } });
}
function renderArtifacts(force = false) {
  if (state.view !== "artifacts") return;
  if (!force && $("art-grid")) { drawArtGrid(); return; } // live updates: just the cards, so scroll and typing aren't lost
  const on = state.settings?.claudeArtifacts === true;
  const last = state.settings?.artifactsLastSync;
  const importBtn = h("button", { class: "btn primary sm", onclick: () => openArtifactImport() }, icon("plus", 13), "Import");
  // Syncing only works when Claude Code runs inside the Claude desktop app; it stays tucked away in the menu.
  const more = ibtn("more", "More", (ev) => { ev.stopPropagation(); popMenu(ev.currentTarget, [
    { icon: "refresh", label: "Try syncing from claude.ai", desc: "Works only where Claude Code can read your claude.ai artifacts", run: () => syncArtifacts() },
    { icon: "gear", label: "Auto-sync settings…", run: () => openSettings() },
  ], "end"); }, { pos: "end" });
  const search = h("input", { id: "art-search", type: "search", placeholder: "Search artifacts", value: artFilter.q, oninput: (ev) => { artFilter.q = ev.target.value; drawArtGrid(); } });
  const chips = h("div", { class: "chips" }, ...[["all", "All"], ["bullpen", "Made here"], ["claude", "claude.ai"]].map(([k, label]) =>
    h("button", { class: "chip" + (artFilter.source === k ? " on" : ""), onclick: () => { artFilter.source = k; renderArtifacts(true); } }, label)));
  $("main").replaceChildren(
    pageTopbar("layers", "Artifacts", last?.ok && last.at ? `claude.ai last synced ${ago(last.at)}` : "Pages, reports and diagrams", [importBtn, more]),
    h("div", { class: "page" }, h("div", { class: "column wide" },
      h("div", { class: "art-tools" }, chips, search),
      h("div", { class: "art-hint" }, "From claude.ai: open the artifact there, copy its code or download it, then ", h("button", { class: "link", onclick: () => openArtifactImport() }, "Import"),
        " (or drop the file here). Add its link to keep the two connected."),
      h("div", { id: "art-grid", class: "art-grid" }))));
  drawArtGrid();
}
function drawArtGrid() {
  const grid = $("art-grid"); if (!grid) return;
  const q = artFilter.q.trim().toLowerCase();
  const list = [...(state.artifacts?.values() ?? [])]
    .filter((a) => artFilter.source === "all" || a.source === artFilter.source)
    .filter((a) => !q || a.title.toLowerCase().includes(q) || (a.description ?? "").toLowerCase().includes(q))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  if (!state.artifacts) { grid.replaceChildren(h("div", { class: "faint" }, "Loading…")); return; }
  if (!list.length) {
    grid.replaceChildren(h("div", { class: "box-empty" }, state.artifacts?.size
      ? "Nothing matches."
      : "No artifacts yet. Ask any agent to “make an artifact” (a report, a dashboard, a diagram) and it shows up here. Your claude.ai artifacts appear here too once they sync."));
    return;
  }
  grid.replaceChildren(...list.map((a) => {
    const who = artAuthor(a);
    return h("button", { class: "art-card", onclick: () => openArtifact(a.id) },
      h("div", { class: "art-thumb " + (a.kind === "link" ? "link" : a.kind) }, icon(a.kind === "markdown" ? "filetext" : a.kind === "link" ? "external" : "layers", 22)),
      h("div", { class: "art-title" }, a.title),
      h("div", { class: "art-meta" }, who.el, h("span", {}, who.text), a.updatedAt > "2001" ? h("span", { class: "faint" }, "· " + ago(a.updatedAt)) : null),
      a.description ? h("div", { class: "art-desc" }, a.description) : null);
  }));
}
async function renderArtifact(force = true) {
  if (state.view !== "artifact") return;
  const a = state.artifacts?.get(state.artifactId);
  if (!a) {
    if (!state.artifacts) return; // still connecting
    $("main").replaceChildren(pageTopbar("layers", "Artifact", null), h("div", { class: "page" }, h("div", { class: "column" }, h("div", { class: "box-empty" }, "That artifact was deleted."))));
    return;
  }
  // Server events redraw the sidebar constantly; only redraw this page if the artifact itself changed.
  const sig = JSON.stringify([a.id, a.version, a.title, a.kind, state.artifactVersion]);
  if (!force && $("main").dataset.sig === sig) return;
  $("main").dataset.sig = sig;
  const v = state.artifactVersion ?? a.version;
  const who = artAuthor(a);
  const actions = [];
  if (a.version > 1) {
    const sel = h("select", { class: "qsel", "aria-label": "Version", onchange: (ev) => { state.artifactVersion = Number(ev.target.value); renderArtifact(); } },
      ...Array.from({ length: a.version }, (_, i) => a.version - i).map((n) => h("option", { value: n }, n === a.version ? `Version ${n} (latest)` : `Version ${n}`)));
    sel.value = String(v);
    actions.push(sel);
  }
  if (a.source === "claude") actions.push(h("button", { class: "btn sm", onclick: () => window.open(a.url, "_blank", "noopener") }, icon("external", 13), "Open on claude.ai"));
  if (a.source === "claude") actions.push(h("button", { class: "btn sm", onclick: () => openArtifactImport({ url: a.url, title: a.title }) }, icon("refresh", 13), a.version ? "Import a newer copy" : "Import its page"));
  if (a.kind === "html" && a.version) actions.push(ibtn("external", "Open in a new tab", () => window.open(`/av/${a.key}/${v}`, "_blank", "noopener")));
  if (a.threadId && state.threads.has(a.threadId)) actions.push(ibtn("message", "Go to the chat it came from", () => openThread(a.threadId)));
  actions.push(ibtn("trash", a.source === "claude" ? "Remove from Bullpen (stays on claude.ai)" : "Delete", async () => {
    if (!confirm(a.source === "claude" ? `Remove “${a.title}” from Bullpen? It stays on claude.ai and comes back on the next sync.` : `Delete “${a.title}” and all its versions?`)) return;
    try { await dispatch({ type: "artifact.delete", artifactId: a.id }); openArtifacts(); } catch (err) { fail(err); }
  }));
  const top = pageTopbar("layers", a.title, `${who.text}${a.updatedAt > "2001" ? ` · ${ago(a.updatedAt)}` : ""}${a.version > 1 ? ` · ${a.version} versions` : ""}`, actions);
  let body;
  if (!a.version) {
    body = h("div", { class: "page" }, h("div", { class: "column" }, h("div", { class: "art-link" },
      h("p", {}, "This artifact lives on claude.ai. Open it there, copy its code (or download it), and import it to see it here and let agents read and build on it."),
      h("div", { class: "row-actions" },
        h("button", { class: "btn primary", onclick: () => openArtifactImport({ url: a.url, title: a.title }) }, "Import its page"),
        h("button", { class: "btn", onclick: () => window.open(a.url, "_blank", "noopener") }, "Open on claude.ai")),
      a.owner === "shared" ? h("p", { class: "muted" }, "Shared artifacts usually can't be copied, only ones you own.") : null)));
  } else if (a.kind === "html") {
    body = h("div", { class: "art-frame" }, h("iframe", { src: `/av/${a.key}/${v}`, title: a.title, sandbox: "allow-scripts allow-forms allow-popups allow-modals allow-downloads", referrerpolicy: "no-referrer" }),
      a.source === "claude" ? h("div", { class: "art-note" }, "Copied from claude.ai. Features that need claude.ai (saved data, sign-in) won't work here.") : null);
  } else {
    body = h("div", { class: "page" }, h("div", { class: "column art-md" }, h("div", { class: "faint" }, "Loading…")));
    call("artifact.content", { artifactId: a.id, version: v }).then((r) => {
      const box = document.querySelector(".art-md"); if (box) box.replaceChildren(richText(r.content));
    }).catch((err) => { const box = document.querySelector(".art-md"); if (box) box.textContent = err.message; });
  }
  $("main").replaceChildren(top, body);
}
/** Import dialog: paste a page, or choose/drop a file; a claude.ai link keeps it tied to that artifact. */
function openArtifactImport(prefill = {}, file = null) {
  const title = h("input", { type: "text", placeholder: "Title (taken from the page if empty)", value: prefill.title ?? "" });
  const url = h("input", { type: "url", placeholder: "claude.ai link (optional): https://claude.ai/artifact/…", value: prefill.url ?? "" });
  const body = h("textarea", { class: "mono", rows: 10, placeholder: "Paste the page's HTML, or Markdown", spellcheck: "false" });
  const err = h("div", { class: "form-error" });
  const picked = h("span", { class: "faint" });
  const fileIn = h("input", { type: "file", accept: ".html,.htm,.md,.markdown,.txt,.svg,text/html,text/markdown", hidden: true });
  let kind;
  const load = async (f) => {
    if (!f) return;
    if (f.size > 8 * 1024 * 1024) { err.textContent = "That file is over 8 MB."; return; }
    body.value = await f.text();
    kind = /\.(md|markdown|txt)$/i.test(f.name) ? "markdown" : "html";
    picked.textContent = f.name;
    if (!title.value) title.value = f.name.replace(/\.[^.]+$/, "");
  };
  fileIn.addEventListener("change", () => load(fileIn.files[0]));
  const go = h("button", { class: "btn primary", type: "button" }, "Import");
  const dlg = h("dialog", { class: "import-dlg" },
    h("div", { class: "dlg-head" }, h("h3", {}, "Import an artifact"), h("button", { class: "icon-btn", "aria-label": "Close", onclick: () => dlg.close() }, icon("x", 15))),
    h("p", { class: "muted" }, "On claude.ai, open the artifact and copy its code or download it. Paste it here, or choose or drop the file."),
    h("label", {}, "Page", body),
    h("div", { class: "file-row" }, h("button", { class: "btn sm", type: "button", onclick: () => fileIn.click() }, icon("files", 13), "Choose file…"), picked, fileIn),
    h("label", {}, "Title", title),
    h("label", {}, "Link", url),
    err,
    h("div", { class: "dialog-actions" }, h("button", { class: "btn", type: "button", onclick: () => dlg.close() }, "Cancel"), go));
  for (const t of ["dragover", "drop"]) dlg.addEventListener(t, (ev) => { ev.preventDefault(); if (t === "drop") load(ev.dataTransfer.files[0]); });
  body.addEventListener("input", () => { kind = undefined; picked.textContent = ""; });
  go.addEventListener("click", async () => {
    err.textContent = ""; go.disabled = true;
    try {
      const r = await dispatch({ type: "artifact.import", content: body.value, title: title.value || undefined, url: url.value || undefined, kind });
      dlg.close(); toast(`Imported “${r.artifact.title}”. Agents can read it with read_artifact.`); openArtifact(r.artifact.id);
    } catch (e) { err.textContent = e.message; go.disabled = false; }
  });
  dlg.addEventListener("close", () => dlg.remove());
  document.body.append(dlg); dlg.showModal();
  if (file) load(file); else body.focus();
}
// Drop a file anywhere on the Artifacts page to import it.
document.addEventListener("dragover", (ev) => { if (state.view === "artifacts" && ev.dataTransfer?.types.includes("Files")) ev.preventDefault(); });
document.addEventListener("drop", (ev) => {
  if (state.view !== "artifacts" || !ev.dataTransfer?.files.length || ev.target.closest?.("dialog")) return;
  ev.preventDefault(); openArtifactImport({}, ev.dataTransfer.files[0]);
});

// ---------- teams: every goal the leads are running, in one place ----------
let teamsTimer = null;
let teamsData = null; // last JSON, so a refresh only redraws what changed
const teamsDone = new Set(); // finished goals the person expanded
function openTeams(fromHistory = false) {
  if (state.sub) call("unsubscribe", { subscription: state.sub }).catch(() => {});
  state.sub = null; state.threadId = null; state.thread = null; state.view = "teams";
  if (!fromHistory) routeTo("#/teams");
  teamsData = null;
  renderSidebar(); renderTeams();
}
$("teams-row").addEventListener("click", () => openTeams());
const isOpenGoal = (g) => ["planning", "working", "paused", "stuck"].includes(g.status);
const goalNeeds = (g) => g.tasks.reduce((n, t) => n + t.approvals.length + (t.status === "parked" ? 1 : 0), 0) + (g.status === "stuck" ? 1 : 0);
let teamsBusy = false;
async function renderTeams() {
  clearTimeout(teamsTimer);
  if (state.view !== "teams" || state.threadId) return;
  if (teamsBusy) return;
  teamsBusy = true;
  let goals;
  try { goals = await call("teams"); } catch (err) { goals = null; $("main").replaceChildren(h("div", { class: "page" }, h("div", { class: "column" }, h("div", { class: "box-empty" }, err.message)))); }
  finally { teamsBusy = false; }
  if (state.view !== "teams" || state.threadId) return;
  // Task timers and statuses move without a sidebar event, so look again every few seconds while the page is open.
  teamsTimer = setTimeout(renderTeams, 4000);
  if (!goals) return;
  const json = JSON.stringify(goals);
  if (json === teamsData && $("teams-page")) return;
  teamsData = json;
  drawTeams(goals);
}
function drawTeams(goals) {
  const scroll = $("teams-page")?.scrollTop ?? 0;
  const open = goals.filter(isOpenGoal);
  const done = goals.filter((g) => !isOpenGoal(g));
  const needs = open.reduce((n, g) => n + goalNeeds(g), 0);
  const working = open.reduce((n, g) => n + g.tasks.filter((t) => t.status === "working" || t.status === "changes").length, 0);
  const projectName = (p) => p ? p.split("/").filter(Boolean).at(-1) : "";
  const slot = (g) => {
    const el = h("div", { class: "team-slot" });
    const draw = () => {
      const t = state.threads.get(g.threadId);
      el.replaceChildren(
        h("div", { class: "team-meta" },
          h("b", {}, projectName(g.project)),
          h("span", {}, t ? `in “${t.title}”` : ""),
          g.endedAt ? h("span", {}, `· ended ${ago(g.endedAt)}`) : null,
          h("span", { class: "spacer" }),
          !isOpenGoal(g) ? h("button", { class: "link", onclick: () => { teamsDone.delete(g.goalId); drawTeams(JSON.parse(teamsData)); } }, "Collapse") : null,
          h("button", { class: "link", onclick: () => openThread(g.threadId) }, "Open chat")),
        teamCard(g, draw));
    };
    draw();
    return el;
  };
  const doneRow = (g) => {
    if (teamsDone.has(g.goalId)) return slot(g);
    const accepted = g.tasks.filter((t) => t.status === "accepted").length;
    return h("div", { class: "irow", style: "cursor:pointer", onclick: () => { teamsDone.add(g.goalId); drawTeams(JSON.parse(teamsData)); } },
      h("span", { class: "pill " + g.status, style: "margin-top:1px" }, GOAL_LABEL[g.status]),
      h("div", { class: "main" }, h("div", {}, g.title),
        h("div", { class: "sub" }, `${g.leadName} · ${projectName(g.project)} · ${accepted}/${g.tasks.length} tasks accepted · ${ago(g.endedAt ?? g.startedAt)}`)),
      h("div", { class: "acts" }, h("button", { class: "btn", onclick: (e) => { e.stopPropagation(); openThread(g.threadId); } }, "Open")));
  };
  const leads = [...state.agents.values()].filter((a) => a.canLead);
  const empty = h("div", { class: "box" }, h("div", { class: "teams-empty" },
    h("b", { style: "color:var(--text)" }, "No teams running."),
    h("ol", {},
      h("li", {}, leads.length ? `You have ${leads.length === 1 ? "a lead" : "leads"}: ${leads.map(agentLabel).join(", ")}.` : "Recruit a lead from the agent gallery (Lead / Team lead)."),
      h("li", {}, "Open a project conversation and message the lead with a goal, e.g. “@lead add dark mode to settings”."),
      h("li", {}, "The lead splits it into tasks for your other agents; every team shows up here while it works.")),
    leads.length ? null : h("button", { class: "btn primary", onclick: () => $("new-agent").click() }, "Recruit a lead")));
  const col = h("div", { class: "column" },
    h("div", { class: "teams-stats" },
      h("div", { class: "stat" }, h("b", {}, String(open.length)), h("span", {}, open.length === 1 ? "team running" : "teams running")),
      h("div", { class: "stat" }, h("b", {}, String(working)), h("span", {}, working === 1 ? "agent working now" : "agents working now")),
      h("div", { class: "stat" + (needs ? " attn" : "") }, h("b", {}, String(needs)), h("span", {}, "waiting on you"))),
    open.length ? h("div", {}, ...open.sort((a, b) => goalNeeds(b) - goalNeeds(a)).map(slot)) : empty,
    done.length ? h("div", { class: "box" }, h("div", { class: "box-h" }, "Finished this week", h("span", { class: "count" }, String(done.length))),
      h("div", { class: "box-b" }, ...done.map(doneRow))) : null);
  const page = h("div", { class: "page", id: "teams-page" }, col);
  $("main").replaceChildren(pageTopbar("users", "Teams", "Every goal your leads are running, across all projects", [
    leads.length ? null : h("button", { type: "button", class: "btn sm", onclick: () => openAgentGallery() }, icon("userplus", 14), "Recruit a lead")]), page);
  page.scrollTop = scroll;
}

