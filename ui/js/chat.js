// A chat: top bar, branch and access menus, transcript, live status, tool panels.
// Plain scripts sharing one global scope, loaded in order by index.html (no build step).

// ---------- main pane ----------
function renderNoToken() {
  $("main").replaceChildren(h("div", { class: "empty" },
    h("h2", {}, "Open this page from the terminal"),
    h("p", {}, "The UI needs the server's access token. Open the Bullpen app, or run:"),
    h("pre", { class: "mono" }, "bullpen")));
}

function renderStopped() {
  $("main").replaceChildren(h("div", { class: "empty" },
    h("h2", {}, "Bullpen is stopped"),
    h("p", {}, "Your chats and agents are saved. To start it again, open the Bullpen app, or run:"),
    h("pre", { class: "mono" }, "bullpen"),
    h("div", { class: "actions" }, h("button", { class: "btn", onclick: () => { state.stopping = false; connect(); } }, "Reconnect"))));
}

function renderMain() {
  if (!state.threadId) { renderStart(); return; }
  $("main").replaceChildren(
    h("div", { class: "topbar", id: "topbar" }),
    h("div", { class: "workarea" },
      h("div", { class: "center" },
        h("div", { class: "transcript", id: "transcript" }, h("div", { class: "column", id: "column" })),
        h("div", { class: "composer-wrap" },
          h("div", { id: "team-dock" }),
          h("div", { class: "composer t3", id: "composer" },
            h("textarea", { id: "input", rows: 1, placeholder: "Ask anything… type @ to bring in an agent" }),
            h("div", { class: "composer-bar" },
              h("div", { class: "composer-tools", id: "composer-tools" }),
              h("span", { class: "spacer" }),
              h("span", { id: "mic-slot" }),
              h("button", { type: "button", class: "stop-btn", id: "stop", hidden: true, "aria-label": "Stop", "data-tip": "Stop the agent", "data-tip-pos": "up",
                onclick: () => state.threadId && dispatch({ type: "run.interrupt", threadId: state.threadId }).catch(fail) }, icon("stop", 13)),
              h("button", { type: "button", class: "send-btn", id: "send", "aria-label": "Send", "data-tip": "Send   ↵", "data-tip-pos": "up", disabled: true }, icon("send", 16)))),
          h("div", { class: "hint", id: "hint" })),
        h("div", { class: "drawer", id: "drawer", hidden: true })),
      h("aside", { class: "files", id: "files", hidden: true }),
      h("aside", { class: "browser", id: "browser", hidden: true }),
      h("aside", { class: "teampanel", id: "teampanel", hidden: true })));
  setupComposer();
  renderTopbar();
  syncPanels();
}

function renderTopbar() {
  const t = state.thread; const bar = $("topbar"); if (!t || !bar) return;
  const agent = t.agentId ? state.agents.get(t.agentId) : null;
  const job = t.jobId ? state.jobs.get(t.jobId) : null;
  const modes = { "approval-required": "asks first", "auto-accept-edits": "auto-accepts edits", "full-access": "full access" };
  const engine = engineName(t.provider);
  const cur = (lead, text) => h("span", { class: "crumb-cur", title: text }, lead, h("span", { class: "tx" }, text));
  let crumbs, sub;
  if (agent) {
    crumbs = [crumb([icon("bot", 15), h("span", { class: "tx" }, "Agents")], (ev) => { ev.stopPropagation(); switchMenu(ev.currentTarget, "agents"); }, "Switch agent"),
      crumbSep(), cur(badge(agentLabel(agent)), agentLabel(agent))];
    sub = [`@${agent.name}`, agent.description, `${engine}${t.model ? " · " + t.model : ""}`, modes[t.runtimeMode]];
  } else if (job) {
    const jobAgent = state.agents.get(job.agentId);
    crumbs = [crumb([icon("clock", 15), h("span", { class: "tx" }, "Jobs")], (ev) => { ev.stopPropagation(); switchMenu(ev.currentTarget, "jobs"); }, "Switch job"),
      crumbSep(), cur(null, job.name)];
    sub = [`${describeTrigger(job.trigger)}${job.enabled && job.nextRunAt ? ` · next ${whenNext(job.nextRunAt)}` : job.enabled ? "" : " · paused"}`,
      jobAgent ? agentLabel(jobAgent) : null, job.project ? folderName(job.project) : null];
  } else {
    const project = [...state.projects.values()].find((p) => p.path === t.cwd);
    crumbs = [crumb([project ? projectIcon(project) : icon("files", 15), h("span", { class: "tx" }, project?.title ?? folderName(t.cwd))],
        (ev) => { ev.stopPropagation(); switchMenu(ev.currentTarget, "project", t.cwd); }, "Chats in this project"),
      crumbSep(), cur(null, t.title)];
    sub = [t.worktree ? `${t.worktree.branch} · ${tildePath(t.worktree.path)}` : tildePath(t.cwd), `${engine}${t.model ? " · " + t.model : ""}`];
  }
  const proj = !agent && !job ? projectAt(t.cwd) : null;
  const pmode = proj?.runtimeMode && MODE_RANK[proj.runtimeMode] > MODE_RANK[t.runtimeMode] ? proj.runtimeMode : t.runtimeMode;
  // One chip for where this chat works and what agents may do there; one menu for both.
  const accessItems = proj ? ["-", { header: `What agents may do in ${proj.title}` },
    ...Object.entries(MODE_INFO).map(([m, info]) => ({ icon: m === pmode ? "check" : info.icon, label: info.label, desc: info.desc, active: m === pmode, run: () => setProjectMode(proj, m) }))] : [];
  const branchBtn = proj ? h("button", { type: "button", class: "cbtn" + (t.worktree || pmode !== "approval-required" ? " on" : ""), "aria-haspopup": "menu",
      "data-tip": `${t.worktree ? `Working in a separate copy (branch ${t.worktree.branch}); your folder isn't touched until you merge.` : "Working in your project folder."}\nAgents here: ${MODE_INFO[pmode].label.toLowerCase()}.`, "data-tip-pos": "up",
      onclick: (ev) => { ev.stopPropagation(); branchMenu(ev.currentTarget, t, accessItems); } },
    icon(t.worktree ? "branch" : "files", 14), t.worktree ? shortBranch(t.worktree.branch) : "Your folder",
    h("span", { class: "chip-sep" }, "·"), icon(MODE_INFO[pmode].icon, 13), MODE_SHORT[pmode], icon("chevdown", 12)) : null;
  const waiting = state.approvals.get(t.id)?.size ?? 0;
  const status = waiting ? h("span", { class: "live needs" }, h("span", { class: "pulse" }), waiting === 1 ? "Needs your OK" : `${waiting} need your OK`)
    : t.status === "running" ? h("span", { class: "live" }, h("span", { class: "pulse" }), "Working") : null;
  const actions = [];
  if (job) {
    const running = job.lastStatus === "running";
    actions.push(h("button", { type: "button", class: "btn primary sm", disabled: running, onclick: () => dispatch({ type: "job.run", jobId: job.id }).then(() => toast("Running now.")).catch(fail) },
      icon("play", 13), running ? "Running…" : "Run now"));
    actions.push(ibtn(job.enabled ? "pause" : "play", job.enabled ? "Pause this job" : "Resume this job", () => dispatch({ type: "job.update", jobId: job.id, enabled: !job.enabled }).catch(fail)));
  }
  if (agent) {
    const proposed = [...state.lessons.values()].filter((l) => l.agentId === agent.id && l.status === "proposed").length;
    const approved = [...state.lessons.values()].filter((l) => l.agentId === agent.id && l.status === "approved").length;
    actions.push(ibtn("bulb", proposed ? `Lessons · ${proposed} to review` : `Lessons${approved ? ` (${approved})` : ""}`, () => openLessons(agent), { badge: proposed || null }));
  }
  // Files, Terminal and Browser: one button, one menu (each still has its shortcut).
  const openPanels = ["team", "files", "terminal", "browser"].filter((k) => ui[k]);
  const panels = ibtn("panels", openPanels.length ? `Panels: ${openPanels.join(", ")}` : "Team, files, terminal, browser", (ev) => {
    ev.stopPropagation();
    popMenu(ev.currentTarget, [
      { icon: ui.team ? "check" : "users", label: "Team", desc: "Who's doing what, what needs you, how fast", kbd: "⌘⇧M", active: ui.team, run: () => togglePanel("team") },
      { icon: ui.files ? "check" : "files", label: "Files", kbd: "⌘⇧E", active: ui.files, run: () => togglePanel("files") },
      { icon: ui.terminal ? "check" : "terminal", label: "Terminal", kbd: "⌃`", active: ui.terminal, run: () => togglePanel("terminal") },
      { icon: ui.browser ? "check" : "globe", label: "Browser", kbd: "⌘⇧B", active: ui.browser, run: () => togglePanel("browser") },
    ], "end");
  }, { on: openPanels.length > 0, pos: "end" });
  const moreItems = agent ? [
    { icon: "edit", label: "Edit agent", run: () => openAgentDialog(agent) },
    { icon: "bulb", label: "Lessons", run: () => openLessons(agent) },
    { icon: "reset", label: "Start the chat over", run: () => resetAgent(agent) },
    "-",
    { icon: "trash", label: "Delete agent…", danger: true, run: () => deleteAgent(agent) },
  ] : job ? [
    { icon: "edit", label: "Edit job", run: () => openJobDialog(job) },
    { icon: "play", label: "Run now", run: () => dispatch({ type: "job.run", jobId: job.id }).then(() => toast("Running now.")).catch(fail) },
    { icon: job.enabled ? "pause" : "play", label: job.enabled ? "Pause" : "Resume", run: () => dispatch({ type: "job.update", jobId: job.id, enabled: !job.enabled }).catch(fail) },
  ] : [
    { icon: "compose", label: "New chat in this project", run: () => newThread(t.cwd) },
    { icon: "copy", label: "Copy project path", run: () => navigator.clipboard?.writeText(t.cwd).then(() => toast("Path copied.")) },
  ];
  // Server events arrive constantly; only redraw when something shown changed, so clicks never land mid-redraw.
  const sig = JSON.stringify([t.id, t.title, t.status, t.runtimeMode, t.model, t.provider, Boolean(t.nativeSessionId), t.cwd, t.worktree?.branch, t.worktree?.prUrl, agent && [agent.name, agent.displayName, agent.description],
    job && [job.name, job.enabled, job.lastStatus, job.nextRunAt], proj && [proj.title, proj.runtimeMode], waiting, ui.files, ui.terminal, ui.browser,
    nav.i, nav.top, sideHidden, agent ? [...state.lessons.values()].filter((l) => l.agentId === agent.id).map((l) => l.status).join() : ""]);
  if (bar.dataset.sig !== sig) { bar.dataset.sig = sig; bar.replaceChildren(...[
    navCluster(),
    h("div", { class: "tb-title" }, h("div", { class: "crumbs-row" }, ...crumbs), h("div", { class: "tb-sub", title: sub.filter(Boolean).join(" · ") }, sub.filter(Boolean).join("  ·  "))),
    status,
    h("span", { class: "spacer" }),
    ...actions,
    actions.length ? h("span", { class: "vsep" }) : null,
    panels,
    ibtn("more", "More", (ev) => { ev.stopPropagation(); popMenu(ev.currentTarget, moreItems, "end"); }, { pos: "end" }),
  ].filter(Boolean));
    // Like T3: what the agent runs on and what it may do sit under the message box, not in the title bar.
    const tools = $("composer-tools");
    if (tools) tools.replaceChildren(...[
      h("button", { type: "button", class: "cbtn", "aria-haspopup": "menu", "data-tip": agent ? `${agentLabel(agent)} runs on ${engine}${t.model ? ` (${t.model})` : ""}` : `Model and engine for this chat`, "data-tip-pos": "up",
        onclick: (ev) => { ev.stopPropagation(); modelMenu(ev.currentTarget, t, agent); } },
        icon("bot", 14), h("span", { class: "tx" }, modelLabel(t)), icon("chevdown", 12)),
      branchBtn ? h("span", { class: "cbar-sep" }) : null,
      branchBtn,
    ].filter(Boolean));
  }
  const hint = $("hint");
  if (hint) hint.textContent = agent
    ? `You're talking to ${agentLabel(agent)} directly. Its context carries over to every chat that calls it.`
    : proj ? `${pmode === "auto-accept-edits" ? `${proj.title} builds automatically: every agent here edits files and runs tests and builds on its own. Anything else waits for you.`
        : pmode === "full-access" ? `${proj.title} has full access: agents here run anything without asking.`
        : `${proj.title} asks before acting: agents wait for your OK before editing files or running commands.`}${state.agents.size ? " Type @ to bring in an agent." : ""}`
    : state.agents.size ? "A message with @name goes to that agent; this chat's agent sees the answer on your next message." : "";
  const stop = $("stop"); if (stop) stop.hidden = t.status !== "running";
}
// ---------- branches: a thread can work in its own git worktree ----------
const shortBranch = (b) => { const x = b.replace(/^bullpen\//, ""); return x.length > 22 ? x.slice(0, 21) + "…" : x; };
async function branchMenu(anchor, t, extra = []) {
  if (!t.worktree) {
    popMenu(anchor, [
      { header: "Where this chat works" },
      { icon: "files", label: "Your project folder", disabled: true },
      { icon: "branch", label: "Move to a separate copy (new branch)", desc: "Your folder isn't touched until you merge", run: async () => {
        try { toast("Making a separate copy…"); await dispatch({ type: "worktree.create", threadId: t.id }); toast("This chat now works in a separate copy, on its own branch."); } catch (err) { fail(err); }
      } },
      ...extra,
    ]);
    return;
  }
  const wt = t.worktree;
  const items = [{ icon: "branch", label: `${wt.branch} ← ${wt.base}`, disabled: true }];
  let st = null;
  try { st = await call("worktreeStatus", { threadId: t.id }); } catch {}
  if (st) items.push({ icon: "list", label: !st.exists ? "Its folder is missing" : `${st.changed} file${st.changed === 1 ? "" : "s"} changed · ${st.ahead} commit${st.ahead === 1 ? "" : "s"} ahead${st.behind ? ` · ${st.behind} behind ${wt.base}` : ""}`, disabled: true });
  const busy = t.status === "running";
  const act = (type, done, extra = {}) => async () => {
    try { const r = await dispatch({ type, threadId: t.id, ...extra }); if (done) toast(typeof done === "function" ? done(r) : done); } catch (err) { fail(err); }
  };
  items.push("-",
    { icon: "check", label: `Merge into ${wt.base}`, disabled: busy, run: act("worktree.merge", (r) => r.how === "nothing" ? "Nothing to merge yet." : `Merged into ${wt.base}.`) },
    { icon: "refresh", label: `Bring in the latest ${wt.base}`, disabled: busy, run: act("worktree.update", (r) => r.conflicts?.length ? `Conflicts in ${r.conflicts.length} file${r.conflicts.length === 1 ? "" : "s"}; the agent is resolving them.` : `Up to date with ${wt.base}.`) },
    st?.pr || wt.prUrl
      ? { icon: "external", label: `Open pull request${st?.pr ? ` #${st.pr.number} (${st.pr.state.toLowerCase()})` : ""}`, run: () => window.open(st?.pr?.url ?? wt.prUrl, "_blank", "noopener") }
      : { icon: "external", label: "Open a pull request…", disabled: busy, run: () => openPrDialog(t) },
    "-",
    { icon: "copy", label: "Copy worktree path", run: () => navigator.clipboard?.writeText(wt.path).then(() => toast("Path copied.")) },
    { icon: "trash", label: "Remove worktree…", danger: true, disabled: busy, run: async () => {
      const merged = st?.merged;
      if (!confirm(`Remove this chat's worktree folder?${merged ? "" : "\n\nIts branch has work that isn't merged; the branch is kept so nothing is lost."}`)) return;
      act("worktree.remove", "Worktree removed. The chat now works in your project folder.", { deleteBranch: Boolean(merged) })();
    } });
  popMenu(anchor, [{ header: "Where this chat works" }, ...items, ...extra], "end");
}
function openPrDialog(t) {
  const title = prompt("Pull request title", t.title);
  if (title === null) return;
  toast("Pushing and opening the pull request…");
  dispatch({ type: "worktree.pr", threadId: t.id, title }).then((r) => { toast("Pull request opened."); if (r.url) window.open(r.url, "_blank", "noopener"); }).catch(fail);
}

// ---------- project permissions: one setting every agent working there follows ----------
const MODE_INFO = {
  "approval-required": { label: "Ask first", desc: "Agents ask before they edit files or run commands.", icon: "shield" },
  "auto-accept-edits": { label: "Build automatically", desc: "Edits inside the project, tests and builds run on their own. Anything else asks you.", icon: "shieldcheck" },
  "full-access": { label: "Full access", desc: "Agents run anything without asking. For throwaway projects.", icon: "shieldcheck" },
};
const MODE_RANK = { "approval-required": 0, "auto-accept-edits": 1, "full-access": 2 };
const MODE_SHORT = { "approval-required": "Asks first", "auto-accept-edits": "Builds automatically", "full-access": "Full access" };
const projectAt = (path) => [...state.projects.values()].find((p) => p.path === path);
function setProjectMode(p, mode) {
  dispatch({ type: "project.update", projectId: p.id, runtimeMode: mode })
    .then(() => toast(`${p.title}: ${MODE_INFO[mode].label.toLowerCase()}. Every agent working there follows this.`)).catch(fail);
}
function permMenu(anchor, p, current) {
  popMenu(anchor, [{ header: `Every agent working in ${p.title}` },
    ...Object.entries(MODE_INFO).map(([m, info]) => ({ icon: m === current ? "check" : info.icon, label: info.label, desc: info.desc, active: m === current, run: () => setProjectMode(p, m) }))], "end");
}
/** Plain words for a tool call: "Ran npm test", "Edited src/app.ts", "Asked @reviewer". */
function toolLabel(tool, input = {}) {
  const name = String(tool).replace(/^mcp__harness__/, "");
  // Paths relative to where the thread works (its worktree or project), else the last two parts.
  const root = state.thread ? (state.thread.worktree?.path ?? state.thread.cwd) : "";
  const file = (p) => {
    const x = String(p ?? "").replace(/^\/private(?=\/(tmp|var)\/)/, "");
    const r = root.replace(/^\/private(?=\/(tmp|var)\/)/, "");
    return r && x.startsWith(r + "/") ? x.slice(r.length + 1) : x.split("/").filter(Boolean).slice(-2).join("/");
  };
  const inp = input && typeof input === "object" ? input : {};
  const cmd = String(inp.command ?? "").replace(/\s+/g, " ");
  const code = cmd ? String(inp.command) : typeof input === "string" ? input : pretty(input);
  const said = (icon, verb, detail, ask) => ({ icon, verb, code, detail: short(detail ?? "", 140), ask: ask ?? `${verb.toLowerCase()} ${short(detail ?? "", 80)}`.trim() });
  switch (name) {
    case "Bash": case "shell": return said("terminal", "Ran", cmd, inp.description ? `run a command: ${String(inp.description).replace(/^\w/, (c) => c.toLowerCase())}` : "run a command");
    case "Read": return said("filetext", "Read", file(inp.file_path));
    case "Write": return said("edit", "Wrote", file(inp.file_path), `write ${file(inp.file_path)}`);
    case "Edit": case "MultiEdit": case "NotebookEdit": return said("edit", "Edited", file(inp.file_path ?? inp.notebook_path), `edit ${file(inp.file_path ?? inp.notebook_path)}`);
    case "apply_patch": return said("edit", "Edited", (inp.files ?? []).map((f) => file(String(f).replace(/^\w+ /, ""))).join(", "), "edit files");
    case "Grep": return said("search", "Searched for", inp.pattern);
    case "Glob": case "LS": return said("files", "Listed", inp.pattern ?? inp.path);
    case "WebFetch": return said("globe", "Fetched", inp.url, `fetch ${inp.url}`);
    case "WebSearch": return said("search", "Searched the web for", inp.query);
    case "TodoWrite": return said("list", "Updated the plan", "");
    case "Task": case "Agent": return said("users", "Sub-agent:", inp.description ?? inp.prompt, `start a sub-agent: ${short(inp.description ?? "", 60)}`);
    case "report_progress": return said("message", "Noted:", inp.note);
    case "estimate": return said("chart", "Sized the work:", inp.question);
    case "hire": return said("userplus", "Hired", inp.role);
    case "list_threads": return said("list", "Looked at chats", inp.project ?? "");
    case "read_thread": return said("message", "Read chat", inp.thread);
    case "start_thread": return said("compose", "Started a chat:", inp.title ?? inp.prompt);
    case "message_thread": return said("message", "Messaged chat", inp.message);
    case "wait_for_thread": return said("clock", "Waited for chat", inp.thread);
    case "propose_pull_request": return said("external", "Proposed a pull request:", inp.title);
    case "browser_open": return said("globe", "Opened", inp.url);
    case "browser_snapshot": return said("globe", "Read the page", "");
    case "browser_click": return said("pointer", "Clicked", inp.target);
    case "browser_type": return said("type", "Typed into", inp.target);
    case "browser_press": return said("keyboard", "Pressed", inp.key);
    case "browser_screenshot": return said("monitor", "Took a screenshot", "");
    case "Delete": return said("trash", "Deleted", file(inp.path), `delete ${file(inp.path)}`);
    case "Think": return said("bulb", "Thought", inp.title ?? "");
    case "ask_agent": return said("message", `Asked @${String(inp.agent ?? "").replace(/^@/, "")}`, inp.question);
    case "list_agents": return said("users", "Looked up the team", "");
    default: return said("chevright", name, typeof input === "string" ? input : short(input, 140), `use ${name}`);
  }
}
/** Breadcrumb dropdowns: jump between agents, jobs, or threads in a project. */
function switchMenu(anchor, kind, cwd) {
  if (kind === "agents") {
    const agents = [...state.agents.values()].sort((a, b) => agentLabel(a).localeCompare(agentLabel(b)));
    popMenu(anchor, [{ header: "Agents" }, ...agents.map((a) => ({ el: badge(agentLabel(a)), label: agentLabel(a), sub: "@" + a.name, active: state.threadId === a.homeThreadId, run: () => openThread(a.homeThreadId) })),
      "-", { icon: "userplus", label: "Recruit agents", run: () => openAgentGallery() }]);
  } else if (kind === "jobs") {
    const jobs = [...state.jobs.values()].sort((a, b) => a.name.localeCompare(b.name));
    popMenu(anchor, [{ header: "Standing jobs" }, ...jobs.map((j) => ({ icon: "clock", label: j.name, sub: j.enabled ? describeTrigger(j.trigger) : "paused", active: state.threadId === j.threadId, run: () => openThread(j.threadId) })),
      "-", { icon: "plus", label: "New standing job", run: () => openJobDialog() }]);
  } else {
    const homes = new Set([...state.agents.values()].map((a) => a.homeThreadId));
    const threads = [...state.threads.values()].filter((t) => t.cwd === cwd && !homes.has(t.id) && !t.jobId).sort((a, b) => activity(b).localeCompare(activity(a))).slice(0, 14);
    popMenu(anchor, [{ header: folderName(cwd) }, ...threads.map((t) => ({ icon: t.status === "running" ? "refresh" : "message", label: t.title, sub: ago(activity(t)).replace(" ago", ""), active: state.threadId === t.id, run: () => openThread(t.id) })),
      "-", { icon: "compose", label: "New chat here", run: () => newThread(cwd) }]);
  }
}
async function deleteAgent(agent) {
  if (!confirm(`Delete ${agentLabel(agent)}? It leaves the sidebar; its past conversation is kept as a regular thread.`)) return;
  try { await dispatch({ type: "agent.delete", agentId: agent.id }); toast(`${agentLabel(agent)} deleted.`); } catch (err) { fail(err); }
}

async function openThread(threadId, reconnecting = false, fromHistory = false) {
  state.view = null;
  document.querySelector(".app")?.classList.remove("side-open");
  if (state.sub && !reconnecting) call("unsubscribe", { subscription: state.sub }).catch(() => {});
  if (state.threadId !== threadId) { state.items = new Map(); state.order = []; state.runs = new Map(); state.seq = 0; }
  state.threadId = threadId;
  if (!fromHistory) routeTo(`#/t/${threadId}`, reconnecting);
  renderSidebar();
  if (!reconnecting || !$("column")) renderMain();
  const res = await call("subscribeThread", reconnecting && state.seq ? { threadId, afterSequence: state.seq } : { threadId }).catch(fail);
  if (!res) return;
  state.sub = res.subscription;
  subs.set(res.subscription, (events) => events.forEach(apply));
  if (res.mode === "snapshot") {
    const s = res.snapshot;
    state.thread = s.thread; state.seq = s.sequence;
    state.runs = new Map(s.runs.map((r) => [r.id, r]));
    state.items = new Map(); state.order = [];
    for (const item of s.turnItems) { state.items.set(item.id, item); state.order.push(item.id); }
    renderTopbar(); renderTranscript(true);
  }
  // Panels drawn before the connection was up (page load, reconnect) need their data now.
  if (ui.terminal || ui.files || ui.browser) { if (ui.files && !fx.cache.size) fx.threadId = null; syncPanels(); }
  $("input")?.focus();
}

function apply({ sequence, event: e }) {
  if (sequence <= state.seq) return;
  state.seq = sequence;
  if (e.type === "thread.upserted") {
    const hadHistory = Boolean(state.thread?.importedFrom?.history);
    state.thread = e.thread; renderTopbar(); renderLive();
    if (!hadHistory && e.thread.importedFrom?.history) renderTranscript(); // the past conversation just arrived
  }
  else if (e.type === "run.upserted") {
    const was = state.runs.get(e.run.id);
    state.runs.set(e.run.id, e.run);
    renderLive();
    if (Boolean(was?.rewound) !== Boolean(e.run.rewound)) renderTranscript();
    else if (e.run.status !== "running") renderRunMeta(e.run);
  }
  else if (e.type === "turn-item.upserted") {
    if (!state.items.has(e.item.id)) state.order.push(e.item.id);
    state.items.set(e.item.id, e.item);
    upsertItemEl(e.item);
  }
}

// ---------- transcript ----------
function nearBottom() { const t = $("transcript"); return !t || t.scrollHeight - t.scrollTop - t.clientHeight < 120; }
function toBottom() { const t = $("transcript"); if (t) t.scrollTop = t.scrollHeight; }

function renderTranscript() {
  const col = $("column"); if (!col) return;
  col.replaceChildren();
  if (state.thread?.importedFrom) {
    const imp = state.thread.importedFrom;
    const who = imp.tool === "codex" ? "Codex" : "Claude Code";
    col.append(h("div", { class: "imported-note" }, !imp.history
      ? `Continues a ${who} session last used ${ago(imp.at)}. Loading its earlier conversation…`
      : `Continues a ${who} session last used ${ago(imp.at)}. ${imp.history.truncated ? "Its most recent conversation is shown below (older parts aren't)" : "Its conversation is shown below"}; ${imp.tool === "codex" ? "Codex" : "Claude"} remembers all of it, so just keep going.`));
    // Imported before history was brought in: fetch it once.
    if (!imp.history && state.thread.nativeSessionId && !state.backfilling?.has(state.thread.id)) {
      (state.backfilling ??= new Set()).add(state.thread.id);
      dispatch({ type: "thread.backfill", threadId: state.thread.id }).catch(() => {});
    }
  }
  if (!state.order.length && !state.thread?.importedFrom) {
    const agent = state.thread?.agentId ? state.agents.get(state.thread.agentId) : null;
    const job = state.thread?.jobId ? state.jobs.get(state.thread.jobId) : null;
    col.append(h("div", { class: "empty" }, h("p", {}, job
      ? (job.trigger.kind === "manual" ? `Each run of “${job.name}” reports here. It runs when you press Run now.` : `Each run of “${job.name}” reports here (${describeTrigger(job.trigger)}). Press Run now to try it.`)
      : agent
      ? `Say hello to ${agentLabel(agent)}, or mention it as @${agent.name} from any thread. Everything it learns here stays in its context.`
      : "Describe the problem. Type @ to pull in one of your agents.")));
  }
  for (const id of state.order) { const el = itemEl(state.items.get(id)); if (el) col.append(el); }
  for (const run of state.runs.values()) if (run.status !== "running") renderRunMeta(run, false);
  renderLive();
  renderDock();
  toBottom();
}

function upsertItemEl(item) {
  const stick = nearBottom();
  const col = $("column"); if (!col) return;
  col.querySelector(":scope > .empty")?.remove();
  const el = itemEl(item);
  const old = col.querySelector(`[data-id="${CSS.escape(item.id)}"]`);
  if (old && el) old.replaceWith(el); else if (old) old.remove(); else if (el) col.append(el);
  renderLive(); // keep the live status line last and current
  if (item.kind === "note" && item.team) renderTeamPanel(); // a team update: refresh the panel's log
  if (item.kind === "team_goal") renderDock();
  if (stick) toBottom();
}

/** While a team works on a goal from this chat: who's doing what right now, always in view above the message box. */
/** The team's goals in this chat (newest last). */
const chatGoals = () => state.order.map((id) => state.items.get(id)).filter((i) => i?.kind === "team_goal");
const goalOpen = (g) => ["planning", "working", "paused", "stuck"].includes(g.status);
/**
 * Team status lives in the Team panel on the right; the chat only gets a slim line above the message box while a
 * team works (click it to open the panel). The panel opens by itself the first time a team starts here.
 */
function renderDock() {
  const strip = $("team-dock"); if (!strip) return;
  const goals = chatGoals();
  const g = goals.filter(goalOpen).at(-1);
  if (g && !ui.team && !state.teamShown?.has(g.goalId)) { (state.teamShown ??= new Set()).add(g.goalId); ui.team = true; saveUi(); renderTopbar(); syncPanels(); }
  if (ui.team) renderTeamPanel();
  if (!g || ui.team) { strip.replaceChildren(); return; }
  const needs = g.tasks.reduce((n, t) => n + t.approvals.length + (t.status === "parked" ? 1 : 0), 0) + (g.status === "stuck" ? 1 : 0);
  const working = g.tasks.filter((t) => t.status === "working").length;
  const done = g.tasks.filter((t) => t.status === "accepted").length;
  strip.replaceChildren(h("button", { class: "team-strip" + (needs ? " needs" : ""), onclick: () => togglePanel("team") },
    h("span", { class: "act-spin" }), h("b", {}, "Team working"),
    h("span", { class: "faint" }, [working && `${working} at once`, `${done}/${g.tasks.length} done`].filter(Boolean).join(" · ")),
    needs ? h("span", { class: "dock-needs" }, `Needs you (${needs})`) : null,
    h("span", { class: "spacer" }), h("span", { class: "go" }, "Show team →")));
}
// ---- model picker (under the message box) ----
/** Short names people know; any other model id can be typed in. Claude Code accepts these aliases. */
const MODEL_CHOICES = {
  claude: [["opus", "Opus", "Most capable, for hard problems"], ["sonnet", "Sonnet", "Fast and capable, a good default"], ["haiku", "Haiku", "Fastest, for quick small tasks"]],
};
function modelLabel(t) {
  const m = t.model;
  if (!m) return engineName(t.provider);
  const known = MODEL_CHOICES[t.provider]?.find(([id]) => id === m);
  return `${engineName(t.provider)} · ${known ? known[1] : m}`;
}
function modelMenu(anchor, t, agent) {
  const set = (patch, note) => dispatch({ type: "thread.setModel", threadId: t.id, ...patch })
    .then(() => toast(note ?? (t.status === "running" ? "Switches after this turn." : "Done. The next message uses it.")))
    .catch(fail);
  const choices = MODEL_CHOICES[t.provider] ?? [];
  const items = [{ header: agent ? `Model for ${agentLabel(agent)} (everywhere it works)` : "Model" },
    { icon: !t.model ? "check" : "bot", label: `${engineName(t.provider)} default`, desc: "Whatever the engine picks", active: !t.model, run: () => set({ model: "" }) },
    ...choices.map(([id, label, desc]) => ({ icon: t.model === id ? "check" : "bot", label, desc, active: t.model === id, run: () => set({ model: id }) })),
    { icon: t.model && !choices.some(([id]) => id === t.model) ? "check" : "edit", label: t.model && !choices.some(([id]) => id === t.model) ? `Other: ${t.model}` : "Other model…",
      desc: "Type a model id", run: () => { const m = prompt(`Model id for ${engineName(t.provider)} (blank for the default):`, t.model ?? ""); if (m !== null) set({ model: m }); } }];
  // The engine holds the conversation, so it can only change before the chat starts.
  if (!agent && ENGINES.length > 1) {
    items.push("-", { header: "Engine" });
    for (const e of ENGINES) {
      const on = e.id === t.provider;
      items.push(t.nativeSessionId && !on
        ? { icon: "lock", label: e.name, desc: "Start a new chat to use it; this one has begun", disabled: true }
        : { icon: on ? "check" : "bot", label: e.name, active: on, run: () => on || set({ provider: e.id }, `This chat now uses ${e.name}.`) });
    }
  }
  popMenu(anchor, items);
}

/** Wide enough for the four-column board by default (about 40% of the window); drag the left edge to change it. */
function teamWidth() {
  // Always leave the conversation room to read and type (sidebar + at least 460px of chat).
  const side = document.querySelector(".sidebar")?.getBoundingClientRect().width ?? 0;
  const max = Math.max(320, innerWidth - side - 460);
  return Math.min(max, Math.max(320, ui.teamW || Math.round(innerWidth * 0.42)));
}
addEventListener("resize", () => { const tp = $("teampanel"); if (tp && !tp.hidden) tp.style.setProperty("--team-w", teamWidth() + "px"); });
/** The Team panel: live status (what needs you, who's doing what) and the team card (list or board, log). */
function renderTeamPanel() {
  const panel = $("teampanel"); if (!panel || panel.hidden) return;
  const goals = chatGoals();
  const g = goals.filter(goalOpen).at(-1) ?? goals.at(-1);
  const head = h("div", { class: "tp-bar" }, icon("users", 15), h("b", {}, "Team"), h("span", { class: "spacer" }),
    h("button", { class: "icon-btn", title: "Hide team panel (⌘⇧M)", onclick: () => togglePanel("team") }, icon("x", 15)));
  if (!g) {
    panel.replaceChildren(teamGrip(panel), head, h("div", { class: "launcher" }, h("div", { class: "note" },
      "No team in this chat yet. @mention a lead (e.g. @lead) with a goal and the team's progress shows up here: who's doing what, what needs you, and how fast it's going.")));
    return;
  }
  const scroller = panel.querySelector(".tp-body");
  const top = scroller?.scrollTop ?? 0;
  const body = h("div", { class: "tp-body" }, goalOpen(g) ? teamLive(g) : null, teamCard(g, () => renderTeamPanel(), { approvalsAbove: goalOpen(g) }),
    goals.length > 1 ? h("div", { class: "faint tp-older" }, `${goals.length - 1} earlier team goal${goals.length > 2 ? "s" : ""} in this chat (see Teams).`) : null);
  panel.replaceChildren(teamGrip(panel), head, body);
  body.scrollTop = top;
}
function teamGrip(panel) {
  const g = h("div", { class: "files-grip", title: "Drag to resize" });
  let startW = 0;
  g.addEventListener("pointerdown", () => { startW = teamWidth(); });
  grip(g, "x", (dx) => { ui.teamW = Math.max(320, startW - dx); panel.style.setProperty("--team-w", teamWidth() + "px"); });
  return g;
}
/** The live part of the Team panel: what needs you (with buttons), the lead, and each working task. */
function teamLive(g) {
  const working = g.tasks.filter((t) => t.status === "working");
  const done = g.tasks.filter((t) => t.status === "accepted").length;
  const waiting = g.tasks.filter((t) => ["queued", "waiting"].includes(t.status)).length;
  const review = g.tasks.filter((t) => t.status === "submitted").length;
  const needs = g.tasks.reduce((n, t) => n + t.approvals.length + (t.status === "parked" ? 1 : 0), 0) + (g.status === "stuck" ? 1 : 0);
  const counts = [working.length && `${working.length} of ${g.speed?.max ?? 4} at once`, review && `${review} being checked`, waiting && `${waiting} waiting`, `${done}/${g.tasks.length} done`, g.speed?.avgTaskMin ? `~${g.speed.avgTaskMin} min each` : ""].filter(Boolean).join(" · ");
  const rows = [];
  if (g.lead?.busy) rows.push(h("div", { class: "dock-row" }, badge(g.leadName),
    g.lead.activity ? activityLine(g.lead.activity, { label: g.tasks.length ? "Reviewing and planning" : "Planning", compact: true }) : h("span", { class: "act-what" }, "Planning…")));
  for (const t of working) rows.push(h("div", { class: "dock-row" }, badge(t.agentName),
    h("div", { class: "dock-task" }, h("div", { class: "dock-t" }, h("span", { class: "mono" }, t.ref), " ", t.title),
      t.activity ? activityLine(t.activity, { label: t.wrapping ? "Out of time, wrapping up" : "Working", compact: true }) : null)));
  // What needs you, each with the thing to do about it.
  const tellLead = () => { const inp = $("input"); if (inp) { inp.value = `@${state.agents.get(g.leadAgentId)?.name ?? "lead"} `; inp.focus(); inp.dispatchEvent(new Event("input")); } };
  for (const t of g.tasks) {
    for (const a of t.approvals) {
      const answer = (decision) => dispatch({ type: "runtime-request.respond", threadId: a.threadId, requestId: a.requestId, decision }).catch(fail);
      const l = toolLabel(a.tool, a.input);
      rows.unshift(h("div", { class: "dock-row needs" }, badge(t.agentName),
        h("div", { class: "dock-task" }, h("div", { class: "dock-t" }, h("b", {}, `${t.agentName} wants to ${l.ask}`)), h("code", { class: "dock-code" }, l.code.slice(0, 160))),
        h("div", { class: "dock-acts" }, h("button", { class: "btn sm", onclick: () => answer("decline") }, "Deny"), h("button", { class: "btn sm primary", onclick: () => answer("accept") }, "Allow"))));
    }
    if (t.status === "parked") rows.unshift(h("div", { class: "dock-row needs" }, badge(t.agentName),
      h("div", { class: "dock-task" }, h("div", { class: "dock-t" }, h("b", {}, `${t.ref} is stuck`), ` · ${t.title}`), t.error ? h("div", { class: "faint" }, t.error.slice(0, 200)) : null),
      h("div", { class: "dock-acts" }, h("button", { class: "btn sm", onclick: tellLead }, "Tell the lead"), h("button", { class: "btn sm primary", onclick: () => dispatch({ type: "task.retry", taskId: t.id }).catch(fail) }, "Retry"))));
  }
  if (g.status === "stuck") rows.unshift(h("div", { class: "dock-row needs" }, icon("users", 14),
    h("div", { class: "dock-task" }, h("div", { class: "dock-t" }, h("b", {}, "The team is stuck")), h("div", { class: "faint" }, g.note ?? "")),
    h("div", { class: "dock-acts" }, h("button", { class: "btn sm primary", onclick: tellLead }, "Tell the lead what to do"))));
  if (g.status === "paused") rows.unshift(h("div", { class: "dock-row" }, icon("clock", 14), h("span", {}, g.note ?? "Paused; it resumes on its own.")));
  if (!rows.length) rows.push(h("div", { class: "dock-row faint" }, review ? "Waiting on the lead to check the finished work…" : "Between steps…"));
  return h("div", { class: "dock" + (needs ? " needs" : "") },
    h("div", { class: "dock-head" }, icon("users", 14), h("b", {}, g.title), g.rounds ? h("span", { class: "faint" }, `Pass ${g.rounds.round} of ${g.rounds.max}`) : null,
      h("span", { class: "spacer" }), needs ? h("span", { class: "dock-needs" }, `Needs you (${needs})`) : null),
    h("div", { class: "dock-counts faint" }, counts),
    ...rows);
}

/** The status line under a running turn: elapsed, steps, what it's doing now, its latest note. */
function renderLive() {
  const col = $("column"); if (!col) return;
  const t = state.thread;
  let el = $("live-status");
  const runId = t?.status === "running" ? t.activeRunId : null;
  const run = runId ? state.runs.get(runId) : null;
  if (!run) { el?.remove(); return; }
  let steps = 0, last = null, note = null;
  for (const id of state.order) {
    const it = state.items.get(id);
    if (!it || it.runId !== runId) continue;
    if (it.kind === "tool_call" && !it.parentId) { steps++; last = { tool: it.tool, input: it.input }; }
    if (it.kind === "note" && it.progress) note = it.text;
  }
  const waiting = state.approvals.get(t.id)?.size;
  const line = activityLine({ startedAt: run.startedAt, steps, last, note, access: run.access }, { label: waiting ? "Waiting for your OK" : "Working" });
  line.id = "live-status";
  line.classList.add("thread-live");
  const stick = nearBottom();
  el?.remove();
  col.append(line); // always last, under the newest step
  if (stick) toBottom();
}
function renderRunMeta(run, scroll = true) {
  const col = $("column"); if (!col) return;
  const id = `meta:${run.id}`;
  col.querySelector(`[data-id="${CSS.escape(id)}"]`)?.remove();
  const parts = [run.rewound ? "Undone: the agent no longer remembers this turn" : run.status === "completed" ? "Done" : run.status === "interrupted" ? (run.error === "Server restarted" ? "Interrupted by a restart" : "Interrupted") : "Failed"];
  if (run.tokens) parts.push(`${run.tokens >= 1000 ? (run.tokens / 1000).toFixed(run.tokens >= 100000 ? 0 : 1) + "k" : run.tokens} tokens`);
  if (run.endedAt) parts.push(`${Math.max(1, Math.round((new Date(run.endedAt) - new Date(run.startedAt)) / 1000))}s`);
  const el = h("div", { class: "run-meta", "data-id": id }, parts.join(" · "));
  // place after the last item of that run
  const runEls = [...col.querySelectorAll(`[data-run="${CSS.escape(run.id)}"]`)];
  const last = runEls.at(-1);
  if (last) last.after(el); else col.append(el);
  if (scroll && nearBottom()) toBottom();
}

function itemEl(item) {
  const el = itemElInner(item);
  if (el && state.runs.get(item.runId)?.rewound) el.classList.add("rewound");
  return el;
}
function itemElInner(item) {
  const base = { "data-id": item.id, "data-run": item.runId };
  switch (item.kind) {
    case "note":
      if (item.team) return null; // shown in its team card's log (and live in the panel above the message box)
      if (item.progress) return h("div", { ...base, class: "note progress" }, icon("message", 13), h("span", {}, item.text));
      return h("div", { ...base, class: "note" }, icon(item.action ? "external" : "branch", 13), h("span", {}, richText(item.text)),
        item.action?.kind === "open_artifact"
          ? h("button", { class: "btn sm", onclick: () => openArtifact(item.action.artifactId) }, icon("layers", 13), "Open")
          : item.action?.kind === "open_pr" && state.thread?.worktree && !state.thread.worktree.prUrl
          ? h("button", { class: "btn sm primary", onclick: (ev) => { ev.currentTarget.disabled = true; toast("Pushing and opening the pull request…");
              dispatch({ type: "worktree.pr", threadId: item.threadId, title: item.action.title, body: item.action.body })
                .then((r) => { toast("Pull request opened."); if (r.url) window.open(r.url, "_blank", "noopener"); }).catch((err) => { ev.currentTarget.disabled = false; fail(err); }); } }, "Open pull request")
          : null);
    case "user_message":
      return h("div", { ...base, class: "msg-user" }, mentionText(item.text));
    case "assistant_message":
      return h("div", { ...base, class: "msg-assistant" + (item.streaming ? " streaming" : "") }, richText(item.text));
    case "reasoning":
      return h("details", { ...base, class: "reasoning" }, h("summary", {}, item.streaming ? "Thinking…" : "Thought"), h("div", {}, item.text));
    case "tool_call": {
      // Its note is shown on its own (and in the live status line).
      if (/(^|__)report_progress$/.test(item.tool)) return null;
      const t = toolLabel(item.tool, item.input);
      return h("details", { ...base, class: "tool" + (item.parentId ? " sub" : "") },
        h("summary", {}, icon(t.icon, 14), h("span", { class: "tool-name" }, t.verb), h("span", { class: "tool-sum" }, t.detail),
          item.status === "running" ? h("span", { class: "tool-state" }, "running…") : item.status === "failed" ? h("span", { class: "tool-state failed" }, "failed") : null),
        h("pre", {}, pretty(item.input) + (item.output ? "\n\n── result ──\n" + item.output : "")));
    }
    case "approval_request": {
      if (item.status === "resolved") {
        const words = { accept: "Allowed", acceptForSession: "Allowed for session", decline: "Declined", cancel: "Cancelled" };
        return h("div", { ...base, class: "approval resolved" }, `${words[item.decision] ?? "Resolved"}: ${toolLabel(item.tool, item.input).ask}`);
      }
      const answer = (decision) => dispatch({ type: "runtime-request.respond", threadId: item.threadId, requestId: item.requestId, decision }).catch(fail);
      const t = toolLabel(item.tool, item.input);
      return h("div", { ...base, class: "approval" },
        h("div", { class: "approval-title" }, `Needs your OK to ${t.ask}`),
        h("pre", { class: "mono" }, t.code),
        h("div", { class: "approval-actions" },
          h("button", { class: "btn ghost", onclick: () => answer("cancel") }, "Stop turn"),
          h("span", { class: "spacer" }),
          h("button", { class: "btn", onclick: () => answer("decline") }, "Deny"),
          h("button", { class: "btn", onclick: () => answer("acceptForSession") }, "Always allow"),
          h("button", { class: "btn primary", onclick: () => answer("accept") }, "Allow")));
    }
    case "agent_reply": {
      const agent = state.agents.get(item.agentId);
      return h("div", { ...base, class: "reply" + (item.status === "failed" ? " failed" : "") },
        h("div", { class: "reply-head" }, badge(agent ? agentLabel(agent) : item.agentName), agent ? agentLabel(agent) : "@" + item.agentName,
          h("span", { class: "muted" }, item.status === "running" ? "working on it…" : item.status === "failed" ? "couldn't answer" : item.delivered ? "shared with this chat's agent" : ""),
          item.status === "running" && agent ? h("button", { class: "link", onclick: () => openThread(item.runThreadId ?? agent.homeThreadId) }, "watch") : null),
        item.status === "running" ? (item.activity ? activityLine(item.activity, { compact: true }) : h("div", { class: "act-line compact" }, h("span", { class: "act-spin" }), h("span", { class: "act-what" }, "Starting…")))
          : h("div", { class: "reply-body" }, richText(item.text)),
        // Its approvals, right here (the work may be running in another thread you're not looking at).
        ...(item.status === "running" ? [...(state.approvals.get(item.runThreadId ?? agent?.homeThreadId)?.values() ?? [])].map((a) => {
          const answer = (decision) => dispatch({ type: "runtime-request.respond", threadId: a.threadId, requestId: a.requestId, decision }).catch(fail);
          const l = toolLabel(a.tool, a.input);
          return h("div", { class: "needs" }, h("div", { class: "needs-t" }, `Needs your OK to ${l.ask}`), h("pre", { class: "mono" }, l.code),
            h("div", { class: "approval-actions" }, h("button", { class: "btn sm", onclick: () => answer("decline") }, "Deny"),
              h("button", { class: "btn sm", onclick: () => answer("acceptForSession") }, "Always allow"), h("button", { class: "btn sm primary", onclick: () => answer("accept") }, "Allow")));
        }) : []));
    }
    case "team_goal": {
      // The card lives in the Team panel; the chat just marks where the team started (and how it's doing).
      const open = goalOpen(item);
      const done = item.tasks.filter((t) => t.status === "accepted").length;
      // While it works, the live status is the strip above the message box (or the panel), not this line.
      return h("div", { ...base, class: "team-line" + (open ? " quiet" : "") },
        icon("users", 14), h("span", {}, h("b", {}, open ? "Team started: " : `Team ${GOAL_LABEL[item.status].toLowerCase()}: `), item.title),
        open ? null : h("span", { class: "faint" }, `${done}/${item.tasks.length} tasks done`),
        h("button", { class: "link", onclick: () => { if (!ui.team) togglePanel("team"); } }, open ? "Show team" : "See what they did"));
    }
    case "checkpoint":
      return h("div", { ...base, class: "checkpoint" },
        `After message ${item.ordinal} · ${item.filesChanged} file${item.filesChanged === 1 ? "" : "s"} changed`,
        item.filesChanged ? h("button", { class: "link", onclick: () => showDiff(item.ordinal - 1, item.ordinal) }, "View changes") : null,
        item.filesChanged && !state.runs.get(item.runId)?.rewound ? h("button", { class: "link", onclick: () => rollback(item.ordinal - 1) }, "Undo this turn") : null);
    case "error":
      return h("div", { ...base, class: "error-item" }, item.message);
  }
  return null;
}

// ---------- tool panels (T3: ThreadTerminalDrawer + FileExplorerPane) ----------
const ui = (() => {
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem("bp-panels") || "{}"); } catch {}
  return { team: !!saved.team, live: !!saved.live, files: !!saved.files, terminal: !!saved.terminal, browser: !!saved.browser, drawerH: saved.drawerH || 280, filesW: saved.filesW || 340, browserW: saved.browserW || 560, teamW: saved.teamW || 0, device: saved.device || "full" };
})();
const saveUi = () => { try { localStorage.setItem("bp-panels", JSON.stringify(ui)); } catch {} };
function togglePanel(which) { ui[which] = !ui[which]; saveUi(); renderTopbar(); syncPanels(); }
function syncPanels() {
  const drawer = $("drawer"), files = $("files");
  if (!drawer || !files) return;
  drawer.hidden = !ui.terminal; drawer.style.height = ui.drawerH + "px";
  files.hidden = !ui.files; files.style.setProperty("--files-w", ui.filesW + "px");
  if (ui.terminal) renderDrawer(); else for (const v of termViews.values()) v.host.hidden = true;
  if (ui.files) renderFiles();
  const browser = $("browser");
  if (browser) {
    browser.hidden = !ui.browser;
    // Never take more than half the window, so the conversation stays usable on small screens.
    browser.style.setProperty("--browser-w", Math.min(ui.browserW, Math.max(320, Math.round(innerWidth * 0.5))) + "px");
    if (ui.browser) renderBrowser();
  }
  const tp = $("teampanel");
  if (tp) { tp.hidden = !ui.team; tp.style.setProperty("--team-w", teamWidth() + "px"); if (ui.team) renderTeamPanel(); }
  renderDock();
}
document.addEventListener("keydown", (ev) => {
  if (!state.threadId) return;
  if (ev.ctrlKey && ev.key === "`") { ev.preventDefault(); togglePanel("terminal"); }
  if ((ev.metaKey || ev.ctrlKey) && ev.shiftKey && (ev.key === "e" || ev.key === "E")) { ev.preventDefault(); togglePanel("files"); }
  if ((ev.metaKey || ev.ctrlKey) && ev.shiftKey && (ev.key === "m" || ev.key === "M")) { ev.preventDefault(); togglePanel("team"); }
  if ((ev.metaKey || ev.ctrlKey) && ev.shiftKey && (ev.key === "b" || ev.key === "B")) { ev.preventDefault(); togglePanel("browser"); }
});
/** Drag a grip to resize the drawer (height) or the files panel (width). */
function grip(el, axis, onMove) {
  el.addEventListener("pointerdown", (ev) => {
    ev.preventDefault();
    const start = axis === "y" ? ev.clientY : ev.clientX;
    const move = (e) => onMove((axis === "y" ? e.clientY : e.clientX) - start);
    const up = () => { removeEventListener("pointermove", move); removeEventListener("pointerup", up); saveUi(); };
    addEventListener("pointermove", move); addEventListener("pointerup", up);
  });
}

// ---- terminal drawer: shells live on the server, one or more per thread ----
const termViews = new Map(); // terminalId -> { xterm, fit, host, sub, threadId }
const activeTerm = new Map(); // threadId -> terminalId
const opening = new Map(); // threadId -> pending terminal.open
function resetTerminalViews() {
  for (const v of termViews.values()) { v.xterm.dispose(); v.host.remove(); }
  termViews.clear();
}
function termTheme() {
  const css = getComputedStyle(document.documentElement);
  const v = (n) => css.getPropertyValue(n).trim();
  return { background: v("--term-bg"), foreground: v("--term-fg"), cursor: v("--term-cursor"), cursorAccent: v("--term-bg"), selectionBackground: "rgba(252,163,17,0.3)" };
}
async function renderDrawer() {
  const drawer = $("drawer"); const threadId = state.threadId;
  if (!drawer || !threadId) return;
  if (!window.Terminal) { drawer.replaceChildren(h("div", { class: "preview-empty" }, "Loading terminal…")); setTimeout(renderDrawer, 300); return; }
  let list;
  try { list = await call("terminal.list", { threadId }); } catch (err) { return fail(err); }
  if (threadId !== state.threadId) return;
  if (!list.length) {
    // Two renders can race here on first open; share one "open" per thread.
    opening.set(threadId, opening.get(threadId) ?? call("terminal.open", { threadId }).finally(() => setTimeout(() => opening.delete(threadId), 1000)));
    try { await opening.get(threadId); list = await call("terminal.list", { threadId }); } catch (err) { return fail(err); }
  }
  let active = activeTerm.get(threadId);
  if (!list.some((t) => t.id === active)) active = list[list.length - 1].id;
  activeTerm.set(threadId, active);
  let body = drawer.querySelector(".drawer-body");
  if (!body) {
    body = h("div", { class: "drawer-body" });
    const g = h("div", { class: "drawer-grip", title: "Drag to resize" });
    let startH = 0;
    g.addEventListener("pointerdown", () => { startH = ui.drawerH; });
    grip(g, "y", (dy) => { ui.drawerH = Math.max(120, Math.min(innerHeight - 220, startH - dy)); drawer.style.height = ui.drawerH + "px"; });
    drawer.replaceChildren(g, h("div", { class: "drawer-bar" }), body);
  }
  drawer.querySelector(".drawer-bar").replaceChildren(
    ...list.map((t) => h("button", { class: "tab" + (t.id === active ? " on" : ""), onclick: () => { activeTerm.set(threadId, t.id); renderDrawer(); } },
      t.title + (t.exitCode !== undefined ? " (exited)" : ""),
      h("span", { class: "x", title: "Close terminal", onclick: async (ev) => {
        ev.stopPropagation();
        await call("terminal.close", { terminalId: t.id }).catch(() => {});
        const v = termViews.get(t.id); if (v) { v.xterm.dispose(); v.host.remove(); termViews.delete(t.id); }
        if ((await call("terminal.list", { threadId }).catch(() => [])).length === 0) { ui.terminal = false; saveUi(); renderTopbar(); syncPanels(); }
        else renderDrawer();
      } }, "×"))),
    h("button", { class: "icon-btn", title: "New terminal", onclick: async () => {
      try { const t = await call("terminal.open", { threadId }); activeTerm.set(threadId, t.id); renderDrawer(); } catch (err) { fail(err); }
    } }, "+"),
    h("span", { class: "spacer" }),
    h("button", { class: "icon-btn", title: "Hide terminal (⌃`)", onclick: () => togglePanel("terminal") }, icon("chevdown", 15)));
  for (const v of termViews.values()) v.host.hidden = true;
  const view = termViews.get(active) ?? (await attachTerminal(active, threadId, body));
  if (!view || threadId !== state.threadId) return;
  if (view.host.parentElement !== body) body.append(view.host);
  view.host.hidden = false;
  requestAnimationFrame(() => { try { view.fit.fit(); } catch {} view.xterm.focus(); });
}
async function attachTerminal(terminalId, threadId, body) {
  const host = h("div", { class: "xterm-host" });
  body.append(host);
  const xterm = new window.Terminal({
    fontFamily: getComputedStyle(document.documentElement).getPropertyValue("--mono"), fontSize: 12.5, lineHeight: 1.2,
    cursorBlink: true, scrollback: 5000, allowProposedApi: false, theme: termTheme(),
  });
  const fit = new window.FitAddon.FitAddon();
  xterm.loadAddon(fit);
  xterm.open(host);
  let res;
  try { res = await call("terminal.attach", { terminalId }); } catch (err) { xterm.dispose(); host.remove(); fail(err); return null; }
  xterm.write(res.history);
  subs.set(res.subscription, (msg) => {
    if (msg.data) xterm.write(msg.data);
    if (msg.exitCode !== undefined) { xterm.write(`\r\n\x1b[2m[process exited with code ${msg.exitCode}]\x1b[0m\r\n`); if (threadId === state.threadId && ui.terminal) renderDrawer(); }
  });
  xterm.onData((data) => call("terminal.input", { terminalId, data }).catch(() => {}));
  let resizeTimer;
  const sendSize = () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(() => call("terminal.resize", { terminalId, cols: xterm.cols, rows: xterm.rows }).catch(() => {}), 80); };
  xterm.onResize(sendSize);
  new ResizeObserver(() => { if (!host.hidden && host.offsetHeight) { try { fit.fit(); } catch {} } }).observe(host);
  const view = { xterm, fit, host, sub: res.subscription, threadId };
  termViews.set(terminalId, view);
  sendSize();
  return view;
}
// Re-theme open terminals when the palette changes.
new MutationObserver(() => { for (const v of termViews.values()) v.xterm.options.theme = termTheme(); })
  .observe(document.documentElement, { attributes: true, attributeFilter: ["data-palette"] });

// ---- file explorer: lazy folder tree + preview, confined to the thread's folder ----
const fx = { threadId: null, open: new Set([""]), cache: new Map(), preview: null, sel: null };
async function loadDir(path) {
  if (!fx.cache.has(path)) fx.cache.set(path, await call("files.list", { threadId: state.threadId, path }));
  return fx.cache.get(path);
}
async function renderFiles() {
  const panel = $("files"); if (!panel || !state.threadId) return;
  if (fx.threadId !== state.threadId) { fx.threadId = state.threadId; fx.open = new Set([""]); fx.cache.clear(); fx.preview = null; fx.sel = null; }
  const t = state.thread;
  const g = h("div", { class: "files-grip", title: "Drag to resize" });
  let startW = 0;
  g.addEventListener("pointerdown", () => { startW = ui.filesW; });
  grip(g, "x", (dx) => { ui.filesW = Math.max(240, Math.min(innerWidth - 520, startW - dx)); panel.style.setProperty("--files-w", ui.filesW + "px"); });
  const head = h("div", { class: "files-head" },
    h("span", { class: "ttl", title: t?.cwd }, t ? folderName(t.cwd) : "Files"),
    h("button", { class: "icon-btn", title: "Refresh", onclick: () => { fx.cache.clear(); renderFiles(); } }, icon("refresh", 14)),
    h("button", { class: "icon-btn", title: "Hide files (⌘⇧E)", onclick: () => togglePanel("files") }, icon("x", 15)));
  if (fx.preview) { panel.replaceChildren(g, head, renderPreview()); return; }
  const tree = h("div", { class: "files-tree" });
  panel.replaceChildren(g, head, tree);
  try { await renderDirInto(tree, "", 0); } catch (err) { tree.replaceChildren(h("div", { class: "files-note" }, err.message)); }
}
async function renderDirInto(container, path, depth) {
  const entries = await loadDir(path);
  if (!entries.length && depth === 0) container.append(h("div", { class: "files-note" }, "This folder is empty."));
  for (const e of entries) {
    const isOpen = fx.open.has(e.path);
    const row = h("button", { class: "frow" + (e.dir ? " dir" : "") + (e.ignored ? " ignored" : "") + (fx.sel === e.path ? " sel" : ""),
      style: `padding-left:${8 + depth * 14}px`, title: e.path + (e.ignored ? " (git-ignored)" : ""),
      onclick: async () => {
        if (e.dir) { isOpen ? fx.open.delete(e.path) : fx.open.add(e.path); renderFiles(); }
        else { fx.sel = e.path; await openPreview(e.path); }
      } },
      h("span", { class: "chev" }, e.dir ? (isOpen ? "▾" : "▸") : ""),
      h("span", { class: "ic" }, e.dir ? "▤" : "·"),
      h("span", { class: "nm" }, e.name));
    container.append(row);
    if (e.dir && isOpen) await renderDirInto(container, e.path, depth + 1);
  }
}
async function openPreview(path) {
  fx.preview = { path, data: null };
  renderFiles();
  try { fx.preview.data = await call("files.read", { threadId: state.threadId, path }); }
  catch (err) { fx.preview.data = { kind: "error", message: err.message }; }
  if (fx.preview?.path === path) renderFiles();
}
function fmtSize(n) { return n > 1048576 ? (n / 1048576).toFixed(1) + " MB" : n > 1024 ? Math.round(n / 1024) + " KB" : n + " B"; }
function renderPreview() {
  const { path, data } = fx.preview;
  const mention = () => {
    const input = $("input"); if (!input) return;
    input.value = (input.value ? input.value.replace(/\s*$/, " ") : "") + "`" + path + "` ";
    input.dispatchEvent(new Event("input")); input.focus();
  };
  const bar = h("div", { class: "preview-bar" },
    h("button", { class: "btn", onclick: () => { fx.preview = null; renderFiles(); } }, "← Files"),
    h("button", { class: "btn", title: "Add this file's path to your message", onclick: mention }, "Mention"),
    h("button", { class: "btn", title: "Show in Finder", onclick: () => call("files.reveal", { threadId: state.threadId, path, how: "reveal" }).catch(fail) }, "Reveal"),
    h("button", { class: "btn", title: "Open with its default app", onclick: () => call("files.reveal", { threadId: state.threadId, path, how: "open" }).catch(fail) }, "Open"),
    h("div", { class: "path", title: path }, path + (data?.size !== undefined ? `  ·  ${fmtSize(data.size)}` : "")));
  let body;
  if (!data) body = h("div", { class: "preview-empty" }, "Loading…");
  else if (data.kind === "error") body = h("div", { class: "preview-empty" }, data.message);
  else if (data.kind === "image") body = h("img", { src: data.dataUrl, alt: path });
  else if (data.kind === "binary") body = h("div", { class: "preview-empty" }, "Binary file. Use Open to view it in its app.");
  else if (data.kind === "too-large") body = h("div", { class: "preview-empty" }, `Too large to preview (${fmtSize(data.size)}). Use Open to view it.`);
  else {
    const lines = data.text.split("\n");
    const shown = lines.slice(0, 4000);
    body = h("div", { class: "code" }, ...shown.map((l, i) => h("div", {}, h("span", { class: "ln" }, String(i + 1)), l || " ")),
      lines.length > shown.length || data.truncated ? h("div", { class: "preview-empty" }, "Preview cut short. Use Open to see the whole file.") : null);
  }
  return h("div", { class: "preview" }, bar, h("div", { class: "preview-body" }, body));
}

// ---- browser: preview a project's site (iframe; T3 uses Electron/server-side browsers instead) ----
const bx = {
  urls: (() => { try { return JSON.parse(localStorage.getItem("bp-browser-urls") || "{}"); } catch { return {}; } })(),
  hist: new Map(), // threadId -> { stack: [], i }
  waiting: null, // { threadId, label, until }
};
const DEVICES = { full: null, tablet: 820, phone: 390 };
function normalizeUrl(text) {
  let u = text.trim();
  if (!u) return null;
  if (/^\d+$/.test(u)) u = "localhost:" + u;
  if (!/^[a-z]+:\/\//i.test(u)) u = (/^(localhost|127\.|\[::1\]|[\w-]+\.local)/i.test(u) ? "http://" : "https://") + u;
  try {
    const url = new URL(u);
    if (url.origin === location.origin) { toast("That's Bullpen itself; open a project's site instead.", { error: true }); return null; }
    return url.href;
  } catch { toast("That doesn't look like a web address.", { error: true }); return null; }
}
function browserGo(text, push = true) {
  const url = normalizeUrl(text); if (!url) return;
  const id = state.threadId;
  bx.urls[id] = url; try { localStorage.setItem("bp-browser-urls", JSON.stringify(bx.urls)); } catch {}
  if (push) {
    const h0 = bx.hist.get(id) ?? { stack: [], i: -1 };
    h0.stack = h0.stack.slice(0, h0.i + 1); h0.stack.push(url); h0.i = h0.stack.length - 1;
    bx.hist.set(id, h0);
  }
  bx.waiting = null;
  renderBrowser();
}
function browserHome() { delete bx.urls[state.threadId]; try { localStorage.setItem("bp-browser-urls", JSON.stringify(bx.urls)); } catch {} renderBrowser(); }
// ---- live browser: a real Chrome tab on the server, shared with the thread's agent ----
const live = { timer: null, threadId: null, busy: false, url: "" };
function stopLive() { clearTimeout(live.timer); live.timer = null; live.threadId = null; }
function renderLiveBrowser(panel, g) {
  const id = state.threadId;
  const addr = h("input", { class: "addr", value: live.threadId === id ? live.url : "", placeholder: "Any address: localhost:3000, github.com…", spellcheck: "false" });
  const img = h("img", { class: "live-img", alt: "Live browser page", draggable: "false" });
  const empty = h("div", { class: "launcher" }, h("div", { class: "note" },
    "A real Chrome tab for this chat: any site loads, and you can click and type in it. When the agent uses its browser tools you'll see it here."));
  const view = h("div", { class: "live-view", tabindex: "0", "aria-label": "Live browser; click to interact, type to send keys" }, empty);
  const go = async (text) => {
    if (!text.trim()) return;
    try { const r = await call("browser.open", { threadId: id, url: text }); live.url = r.url; addr.value = r.url; poll(true); } catch (err) { fail(err); }
  };
  addr.addEventListener("keydown", (ev) => { if (ev.key === "Enter") go(addr.value); });
  const nav = (to) => call("browser.input", { threadId: id, event: { kind: "nav", to } }).then(() => poll(true)).catch(fail);
  const at = (ev) => { const r = img.getBoundingClientRect(); return { x: Math.round((ev.clientX - r.left) * (img.naturalWidth / r.width)), y: Math.round((ev.clientY - r.top) * (img.naturalHeight / r.height)) }; };
  img.addEventListener("click", (ev) => { view.focus(); call("browser.input", { threadId: id, event: { kind: "click", ...at(ev) } }).then(() => poll(true)); });
  img.addEventListener("wheel", (ev) => { ev.preventDefault(); call("browser.input", { threadId: id, event: { kind: "wheel", ...at(ev), dy: Math.round(ev.deltaY) } }).then(() => poll(true)); }, { passive: false });
  view.addEventListener("keydown", (ev) => {
    if (ev.target !== view) return;
    const mods = [ev.metaKey && "Meta", ev.ctrlKey && "Control", ev.altKey && "Alt"].filter(Boolean);
    let event;
    if (ev.key.length === 1 && !mods.length) event = { kind: "text", text: ev.key };
    else if (ev.key.length === 1 || /^(Enter|Backspace|Delete|Tab|Escape|Arrow\w+|Home|End|PageUp|PageDown)$/.test(ev.key)) event = { kind: "key", key: [...mods, ev.shiftKey && ev.key.length > 1 ? "Shift" : null, ev.key].filter(Boolean).join("+") };
    if (!event) return;
    ev.preventDefault();
    call("browser.input", { threadId: id, event }).then(() => poll(true));
  });
  const bar = h("div", { class: "browser-bar" },
    h("button", { class: "icon-btn", title: "Back", onclick: () => nav("back") }, icon("back", 15)),
    h("button", { class: "icon-btn", title: "Forward", onclick: () => nav("forward") }, icon("forward", 15)),
    h("button", { class: "icon-btn", title: "Reload", onclick: () => nav("reload") }, icon("refresh", 14)),
    addr,
    h("button", { class: "icon-btn on", title: "Live browser (real Chrome tab). Click for the quick preview instead.", onclick: () => { ui.live = false; saveUi(); stopLive(); renderBrowser(); } }, icon("monitor", 14)),
    h("button", { class: "icon-btn", title: "Open in your browser", onclick: () => live.url && window.open(live.url, "_blank", "noopener") }, icon("external", 14)),
    h("button", { class: "icon-btn", title: "Hide browser (⌘⇧B)", onclick: () => togglePanel("browser") }, icon("x", 15)));
  panel.replaceChildren(g, bar, view);
  const poll = async (soon) => {
    clearTimeout(live.timer);
    if (soon) await new Promise((r) => setTimeout(r, 150));
    if (state.threadId !== id || !ui.browser || !ui.live || live.busy) { live.timer = setTimeout(() => poll(), 800); return; }
    live.busy = true;
    try {
      const f = await call("browser.frame", { threadId: id });
      if (f) {
        img.src = `data:image/jpeg;base64,${f.image}`;
        if (!img.isConnected) view.replaceChildren(img);
        live.url = f.url;
        if (document.activeElement !== addr) addr.value = f.url;
        // While an agent works, this shows the page it has open.
        let tag = view.querySelector(".live-who");
        if (f.agent) { if (!tag) view.prepend((tag = h("div", { class: "live-who" }))); tag.textContent = `Watching ${f.agent}'s browser (sound muted)`; }
        else tag?.remove();
      }
    } catch {}
    live.busy = false;
    if (state.threadId === id && ui.browser && ui.live) live.timer = setTimeout(() => poll(), document.hidden ? 3000 : 700);
  };
  live.threadId = id;
  poll();
}

function renderBrowser() {
  const panel = $("browser"); if (!panel || !state.threadId) return;
  if (ui.live) {
    const lg = h("div", { class: "files-grip", title: "Drag to resize" });
    let sw = 0;
    lg.addEventListener("pointerdown", () => { sw = panel.getBoundingClientRect().width; }, { capture: true });
    grip(lg, "x", (dx) => { ui.browserW = Math.max(320, Math.min(innerWidth - 480, sw - dx)); panel.style.setProperty("--browser-w", ui.browserW + "px"); });
    return renderLiveBrowser(panel, lg);
  }
  stopLive();
  const id = state.threadId, url = bx.urls[id];
  const hist = bx.hist.get(id) ?? { stack: url ? [url] : [], i: url ? 0 : -1 };
  bx.hist.set(id, hist);
  const g = h("div", { class: "files-grip", title: "Drag to resize" });
  let startW = 0;
  g.addEventListener("pointerdown", () => { startW = ui.browserW; });
  g.addEventListener("pointerdown", () => { startW = panel.getBoundingClientRect().width; }, { capture: true });
  grip(g, "x", (dx) => { ui.browserW = Math.max(320, Math.min(innerWidth - 480, startW - dx)); panel.style.setProperty("--browser-w", ui.browserW + "px"); });
  const addr = h("input", { class: "addr", value: url ?? "", placeholder: "localhost:3000 or any address", spellcheck: "false" });
  addr.addEventListener("keydown", (ev) => { if (ev.key === "Enter") browserGo(addr.value); });
  const step = (d) => { const hh = bx.hist.get(id); hh.i += d; bx.urls[id] = hh.stack[hh.i]; renderBrowser(); };
  const device = h("select", { title: "Width" },
    h("option", { value: "full" }, "Fit"), h("option", { value: "tablet" }, "Tablet"), h("option", { value: "phone" }, "Phone"));
  device.value = ui.device;
  device.addEventListener("change", () => { ui.device = device.value; saveUi(); renderBrowser(); });
  const bar = h("div", { class: "browser-bar" },
    h("button", { class: "icon-btn", title: "Back", disabled: hist.i <= 0, onclick: () => step(-1) }, icon("back", 15)),
    h("button", { class: "icon-btn", title: "Forward", disabled: hist.i >= hist.stack.length - 1, onclick: () => step(1) }, icon("forward", 15)),
    h("button", { class: "icon-btn", title: "Reload", disabled: !url, onclick: () => { const f = panel.querySelector("iframe"); if (f) f.src = f.src; } }, icon("refresh", 14)),
    h("button", { class: "icon-btn", title: "Project sites", onclick: browserHome }, icon("home", 14)),
    addr, device,
    h("button", { class: "icon-btn", title: "Live browser: a real Chrome tab that loads any site and that the agent can use", onclick: () => { ui.live = true; saveUi(); renderBrowser(); } }, icon("monitor", 14)),
    h("button", { class: "icon-btn", title: "Open in your browser", disabled: !url, onclick: () => window.open(url, "_blank", "noopener") }, icon("external", 14)),
    h("button", { class: "icon-btn", title: "Hide browser (⌘⇧B)", onclick: () => togglePanel("browser") }, icon("x", 15)));
  if (!url) { panel.replaceChildren(g, bar, renderLauncher()); return; }
  const w = DEVICES[ui.device];
  // Sandboxed, and never Bullpen's own origin: the page can run but can't navigate or script Bullpen.
  const frame = h("iframe", { src: url, title: "Project preview", referrerpolicy: "no-referrer",
    sandbox: "allow-scripts allow-same-origin allow-forms allow-popups allow-modals allow-downloads allow-pointer-lock",
    style: w ? `width:${w}px` : "" });
  panel.replaceChildren(g, bar, h("div", { class: "bframe-wrap" + (w ? " device" : "") }, frame));
}
function renderLauncher() {
  const box = h("div", { class: "launcher" }, h("div", { class: "note" }, "Looking for this project's sites…"));
  const id = state.threadId;
  // An agent on this chat has a page open: offer to watch it.
  call("browser.frame", { threadId: id }).then((f) => {
    if (!f || id !== state.threadId) return;
    box.prepend(h("button", { class: "row", onclick: () => { ui.live = true; saveUi(); renderBrowser(); } },
      h("span", { class: "row-main" }, h("div", { class: "row-title" }, f.agent ? `See what ${f.agent} is testing` : "Open the live browser"), h("div", { class: "row-sub" }, f.url)),
      h("span", { class: "go" }, "Watch →")));
  }).catch(() => {});
  call("preview.info", { threadId: id }).then((info) => {
    if (id !== state.threadId || bx.urls[id]) return;
    const mine = info.servers.filter((x) => x.inProject), others = info.servers.filter((x) => !x.inProject);
    // The project's own site, straight away: its running dev server, or its static page.
    // (Once per chat, so the home button can still show the list.)
    if (!bx.waiting && !(bx.autoOpened ??= new Set()).has(id) && (mine.length || info.staticUrl)) { bx.autoOpened.add(id); browserGo(mine[0]?.url ?? info.staticUrl); return; }
    const kids = [];
    if (bx.waiting?.threadId === id) {
      kids.push(h("div", { class: "waiting" }, h("span", { class: "pulse" }), `Starting “${bx.waiting.label}” in the terminal… this page opens it when it's up.`));
    }
    if (mine.length) {
      kids.push(h("h4", {}, "Running in this project"));
      for (const x of mine) kids.push(h("button", { class: "row", onclick: () => browserGo(x.url) },
        h("span", { class: "row-main" }, h("div", { class: "row-title" }, `localhost:${x.port}`), h("div", { class: "row-sub" }, x.command)), h("span", { class: "go" }, "Open →")));
    }
    if (info.scripts.length && !bx.waiting) {
      kids.push(h("h4", {}, "Start a dev server"));
      for (const sc of info.scripts) kids.push(h("button", { class: "row", onclick: () => startDevServer(sc) },
        h("span", { class: "row-main" }, h("div", { class: "row-title mono" }, sc.label), h("div", { class: "row-sub" }, "Runs in a new terminal, then opens here")), h("span", { class: "go" }, "Start →")));
    }
    if (info.staticUrl) {
      kids.push(h("h4", {}, "Static site"));
      const entry = info.staticUrl.split(`/t/${id}/`)[1];
      kids.push(h("button", { class: "row", onclick: () => browserGo(info.staticUrl) },
        h("span", { class: "row-main" }, h("div", { class: "row-title mono" }, entry), h("div", { class: "row-sub" }, "Served by Bullpen from the project folder")), h("span", { class: "go" }, "Open →")));
    }
    if (others.length) {
      // Other projects' servers aren't this chat's business; tucked away in case you need one.
      const list = h("div", { hidden: true }, ...others.map((x) => h("button", { class: "row", onclick: () => browserGo(x.url) },
        h("span", { class: "row-main" }, h("div", { class: "row-title" }, `localhost:${x.port}`), h("div", { class: "row-sub" }, x.command)), h("span", { class: "go" }, "Open →"))));
      kids.push(h("button", { class: "link", style: "margin-top:10px", onclick: (ev) => { list.hidden = !list.hidden; ev.currentTarget.textContent = list.hidden ? `Other servers on this Mac (${others.length})` : "Hide other servers"; } }, `Other servers on this Mac (${others.length})`), list);
    }
    if (!mine.length && !info.scripts.length && !info.staticUrl) kids.unshift(h("div", { class: "note" }, "Nothing to preview found in this project. Type an address above, or ask the agent to start the app."));
    kids.push(h("div", { class: "note" }, "This quick preview suits local sites. For public sites (many refuse to be shown inside another page), switch to the live browser ", icon("monitor", 12), "."));
    box.replaceChildren(...kids);
  }).catch((err) => box.replaceChildren(h("div", { class: "note" }, err.message)));
  return box;
}
async function startDevServer(sc) {
  const threadId = state.threadId;
  let before;
  try { before = new Set((await call("preview.info", { threadId })).servers.filter((x) => x.inProject).map((x) => x.port)); } catch { before = new Set(); }
  try {
    const t = await call("terminal.open", { threadId });
    await call("terminal.input", { terminalId: t.id, data: sc.command + "\r" });
    activeTerm.set(threadId, t.id);
    if (!ui.terminal) { ui.terminal = true; saveUi(); renderTopbar(); }
    syncPanels();
  } catch (err) { return fail(err); }
  bx.waiting = { threadId, label: sc.label, until: Date.now() + 120_000 };
  if (state.threadId === threadId) renderBrowser();
  while (bx.waiting?.threadId === threadId && Date.now() < bx.waiting.until) {
    await new Promise((r) => setTimeout(r, 1500));
    let info; try { info = await call("preview.info", { threadId }); } catch { continue; }
    const fresh = info.servers.find((x) => x.inProject && !before.has(x.port));
    if (fresh) {
      bx.waiting = null;
      if (state.threadId === threadId) browserGo(fresh.url); else { bx.urls[threadId] = fresh.url; }
      toast(`Dev server is up on localhost:${fresh.port}.`);
      return;
    }
  }
  if (bx.waiting?.threadId === threadId) { bx.waiting = null; toast("The dev server didn't show up yet; check the terminal.", { error: true }); if (state.threadId === threadId) renderBrowser(); }
}

