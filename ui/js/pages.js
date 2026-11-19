// Artifacts, jobs, lessons, the composer, dialogs, the agent gallery, projects suggestions, updates, remote access, the folder picker, Home and search.
// Plain scripts sharing one global scope, loaded in order by index.html (no build step).

// ---------- standing jobs ----------
const JOB_PRESETS = [
  { label: "Nightly tests & fix", handle: "debugger", name: "Nightly tests", when: "daily", time: "02:00",
    instructions: "Run the project's test suite (and type check/lint if it has them). If anything fails, find the root cause. Fix it if the fix is small and safe; otherwise explain the failure and the fix you'd suggest." },
  { label: "Review new commits", handle: "reviewer", name: "Review new commits", when: "commit", branch: "main",
    instructions: "Review the new commits listed above for bugs, risky changes and missing tests. Report only real problems, by severity, with file and line." },
  { label: "Weekly dependency check", handle: "security", name: "Dependency check", when: "weekly", weekday: "1", time: "08:00",
    instructions: "Check the project's dependencies for known vulnerabilities and badly outdated packages (use the package manager's audit/outdated commands). Summarize what matters and what to upgrade; don't change anything." },
  { label: "Morning changes summary", handle: "docs", name: "What changed yesterday", when: "weekdays", time: "07:30",
    instructions: "Summarize what changed in this project in the last day (git log and diffs): features, fixes, and anything that looks unfinished. Keep it short." },
];
let editingJob = null;
function openJobDialog(job = null) {
  editingJob = job;
  const f = $("job-form"); f.reset(); $("job-error").textContent = "";
  $("job-dialog-title").textContent = job ? `Edit “${job.name}”` : "New standing job";
  $("job-submit").textContent = job ? "Save" : "Create job";
  $("job-delete").hidden = !job;
  $("job-presets").hidden = !!job;
  const agents = [...state.agents.values()].sort((a, b) => agentLabel(a).localeCompare(agentLabel(b)));
  f.elements.agentId.replaceChildren(...agents.map((a) => h("option", { value: a.id }, `${agentLabel(a)}${a.displayName ? ` (@${a.name})` : ""}`)));
  $("job-presets").replaceChildren(h("span", { class: "faint", style: "font-size:12.5px;align-self:center" }, "Start from:"), ...JOB_PRESETS.map((pr) =>
    h("button", { type: "button", onclick: () => applyPreset(pr) }, pr.label)));
  const p = prefs.get();
  f.elements.project.value = job?.project ?? (state.thread && !state.thread.agentId ? state.thread.cwd : p.cwd) ?? "";
  if (job) {
    f.elements.name.value = job.name;
    f.elements.agentId.value = job.agentId;
    f.elements.instructions.value = job.instructions;
    f.elements.enabled.checked = job.enabled;
    f.elements.team.checked = job.mode === "team";
    setTrigger(job.trigger);
    $("job-project-btn").disabled = true;
  } else {
    $("job-project-btn").disabled = false;
    if (!agents.length) $("job-error").textContent = "Recruit an agent first (+ next to Agents).";
  }
  syncJobForm();
  $("job-dialog").showModal();
}
function applyPreset(pr) {
  const f = $("job-form");
  f.elements.name.value = pr.name;
  f.elements.instructions.value = pr.instructions;
  f.elements.when.value = pr.when;
  if (pr.time) f.elements.time.value = pr.time;
  if (pr.weekday) f.elements.weekday.value = pr.weekday;
  if (pr.branch) f.elements.branch.value = pr.branch;
  const agent = [...state.agents.values()].find((a) => a.name === pr.handle || a.templateId === pr.handle);
  if (agent) f.elements.agentId.value = agent.id;
  else toast(`Tip: recruit the ${pr.label.split(" ")[0]} specialist for this job, or pick any agent.`);
  syncJobForm();
}
function setTrigger(t) {
  const f = $("job-form");
  if (t.kind === "daily") {
    f.elements.time.value = t.time.padStart(5, "0");
    if (!t.days?.length || t.days.length === 7) f.elements.when.value = "daily";
    else if (t.days.join() === "1,2,3,4,5") f.elements.when.value = "weekdays";
    else { f.elements.when.value = "weekly"; f.elements.weekday.value = String(t.days[0]); }
  } else if (t.kind === "interval") { f.elements.when.value = "interval"; f.elements.hours.value = t.hours; }
  else if (t.kind === "commit") { f.elements.when.value = "commit"; f.elements.branch.value = t.branch; }
  else f.elements.when.value = "manual";
}
function readTrigger() {
  const f = $("job-form"), w = f.elements.when.value, time = f.elements.time.value || "02:00";
  if (w === "daily") return { kind: "daily", time };
  if (w === "weekdays") return { kind: "daily", time, days: [1, 2, 3, 4, 5] };
  if (w === "weekly") return { kind: "daily", time, days: [Number(f.elements.weekday.value)] };
  if (w === "interval") return { kind: "interval", hours: Math.max(1, Number(f.elements.hours.value) || 6) };
  if (w === "commit") return { kind: "commit", branch: f.elements.branch.value.trim() || "main" };
  return { kind: "manual" };
}
function syncJobForm() {
  const f = $("job-form"), w = f.elements.when.value;
  f.elements.time.hidden = !["daily", "weekdays", "weekly"].includes(w);
  f.elements.weekday.hidden = w !== "weekly";
  f.elements.hours.hidden = w !== "interval";
  f.elements.branch.hidden = w !== "commit";
  const agent = state.agents.get(f.elements.agentId.value);
  $("job-team-row").hidden = !agent?.canLead;
  const cwd = f.elements.project.value;
  $("job-project-btn").replaceChildren(folderIcon(), cwd
    ? h("span", { class: "row-main" }, h("div", { class: "row-title" }, folderName(cwd)), h("div", { class: "faint" }, tildePath(cwd)))
    : h("span", { class: "faint" }, "Choose a project…"));
}
$("job-form").elements.when.addEventListener("change", syncJobForm);
$("job-form").elements.agentId.addEventListener("change", syncJobForm);
$("job-project-btn").addEventListener("click", async () => {
  const path = await pickFolder();
  if (path) { $("job-form").elements.project.value = path; syncJobForm(); }
});
$("job-form").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const f = ev.target, v = (n) => f.elements[n].value.trim();
  const body = { name: v("name"), agentId: v("agentId"), instructions: v("instructions"), trigger: readTrigger(), mode: f.elements.team.checked ? "team" : "solo", enabled: f.elements.enabled.checked };
  try {
    if (editingJob) await dispatch({ type: "job.update", jobId: editingJob.id, ...body });
    else {
      if (!v("project")) { $("job-error").textContent = "Choose a project."; return; }
      const { jobId } = await dispatch({ type: "job.create", project: v("project"), ...body });
      await new Promise((r) => setTimeout(r, 150));
      const job = state.jobs.get(jobId);
      if (job) openThread(job.threadId);
    }
    $("job-dialog").close();
  } catch (err) { $("job-error").textContent = err.message; }
});
$("job-delete").addEventListener("click", async () => {
  if (!editingJob || !confirm(`Delete the job “${editingJob.name}”? Its chat and past results are kept.`)) return;
  try { await dispatch({ type: "job.delete", jobId: editingJob.id }); $("job-dialog").close(); } catch (err) { $("job-error").textContent = err.message; }
});
$("new-job").addEventListener("click", () => openJobDialog());

// ---------- lessons ----------
let lessonsFor = null; // agent, or "all" for everyone
function openLessons(agent) {
  lessonsFor = agent ?? "all";
  $("lessons-title").textContent = agent ? `${agentLabel(agent)}'s lessons` : "Lessons for every agent";
  $("lesson-new").value = "";
  renderLessons();
  $("lessons-dialog").showModal();
}
function lessonRow(l, showAgent) {
  const agent = l.agentId ? state.agents.get(l.agentId) : null;
  const who = showAgent ? (agent ? agentLabel(agent) : "Every agent") : null;
  const src = l.source.kind === "review" ? (l.source.note ?? "From a team review") : l.source.kind === "agent" ? "Suggested after your correction" : "Added by you";
  if (l.status === "proposed") {
    const ta = h("textarea", { rows: 2 }, l.text);
    return h("div", { class: "irow" },
      h("div", { class: "main" }, who ? h("div", { class: "sub", style: "margin:0 0 4px" }, who) : null, ta, h("div", { class: "sub" }, src)),
      h("div", { class: "acts" },
        h("button", { class: "btn primary", onclick: () => dispatch({ type: "lesson.decide", lessonId: l.id, decision: "approve", text: ta.value }).then(refreshLessonViews).catch(fail) }, "Approve"),
        h("button", { class: "btn", onclick: () => dispatch({ type: "lesson.decide", lessonId: l.id, decision: "reject" }).then(refreshLessonViews).catch(fail) }, "Dismiss")));
  }
  return h("div", { class: "irow" },
    h("div", { class: "main" }, h("div", {}, l.text), h("div", { class: "sub" }, [who, src].filter(Boolean).join(" · "))),
    h("div", { class: "acts" }, h("button", { class: "icon-btn", title: "Remove", onclick: () => dispatch({ type: "lesson.delete", lessonId: l.id }).then(refreshLessonViews).catch(fail) }, icon("x", 14))));
}
function renderLessons() {
  const id = lessonsFor === "all" ? undefined : lessonsFor.id;
  const list = [...state.lessons.values()].filter((l) => l.agentId === id);
  const proposed = list.filter((l) => l.status === "proposed"), approved = list.filter((l) => l.status === "approved");
  $("lessons-list").replaceChildren(
    ...(proposed.length ? [h("div", { class: "lbl", style: "margin:4px 0" }, "Suggested"), ...proposed.map((l) => lessonRow(l, false))] : []),
    h("div", { class: "lbl", style: "margin:10px 0 4px" }, "Following"),
    ...(approved.length ? approved.map((l) => lessonRow(l, false)) : [h("div", { class: "box-empty", style: "padding:4px 0" }, "None yet.")]));
}
function refreshLessonViews() {
  setTimeout(() => {
    if ($("lessons-dialog").open) renderLessons();
    if (!state.view && !state.threadId) refreshHome();
    renderTopbar(); renderSidebar();
  }, 120);
}
$("lesson-add").addEventListener("click", async () => {
  const text = $("lesson-new").value.trim(); if (!text) return;
  try { await dispatch({ type: "lesson.add", agentId: lessonsFor === "all" ? undefined : lessonsFor.id, text }); $("lesson-new").value = ""; refreshLessonViews(); } catch (err) { fail(err); }
});

// ---------- inbox: briefing, lessons to review, everything waiting on you ----------
/** Inbox and Home are one page now: Home. (Kept for old links and toasts.) */
function openInbox() { newThread(); }
$("inbox-row").addEventListener("click", () => newThread());

// ---------- composer with @ autocomplete ----------
/** Auto-growing textarea with @agent autocomplete; Enter calls onSubmit, Shift+Enter is a newline. */
function attachMentions(input, composer, onSubmit) {
  let popup = null, matches = [], sel = 0;
  const grow = () => { input.style.height = "auto"; input.style.height = Math.min(220, input.scrollHeight) + "px"; };
  const mentionAtCursor = () => {
    const upto = input.value.slice(0, input.selectionStart);
    const m = upto.match(/(?:^|[^\w@])@([a-z0-9-]*)$/);
    return m ? { query: m[1], start: input.selectionStart - m[1].length - 1 } : null;
  };
  const close = () => { popup?.remove(); popup = null; };
  const pick = (agent) => {
    const m = mentionAtCursor(); if (!m) return;
    const before = input.value.slice(0, m.start), after = input.value.slice(input.selectionStart);
    input.value = `${before}@${agent.name} ${after}`;
    const pos = before.length + agent.name.length + 2;
    input.setSelectionRange(pos, pos); close(); input.focus(); grow();
  };
  const update = () => {
    const m = mentionAtCursor();
    const self = state.thread?.agentId;
    matches = m ? [...state.agents.values()].filter((a) => a.id !== self && a.name.startsWith(m.query)).sort((a, b) => a.name.localeCompare(b.name)) : [];
    if (!matches.length) return close();
    sel = Math.min(sel, matches.length - 1);
    const el = h("div", { class: "popup" }, matches.map((a, i) =>
      h("button", { class: "row" + (i === sel ? " sel" : ""), type: "button", onmousedown: (ev) => { ev.preventDefault(); pick(a); } },
        badge(agentLabel(a)), h("span", { class: "row-main" }, h("div", { class: "row-title" }, a.displayName ? `${a.displayName}  @${a.name}` : "@" + a.name), h("div", { class: "row-sub" }, a.description || a.provider)))));
    popup ? popup.replaceWith(el) : composer.append(el);
    popup = el;
  };
  input.addEventListener("input", () => { grow(); sel = 0; update(); });
  input.addEventListener("click", update);
  input.addEventListener("blur", () => setTimeout(close, 100));
  input.addEventListener("keydown", (ev) => {
    if (popup) {
      if (ev.key === "ArrowDown") { sel = (sel + 1) % matches.length; update(); ev.preventDefault(); return; }
      if (ev.key === "ArrowUp") { sel = (sel - 1 + matches.length) % matches.length; update(); ev.preventDefault(); return; }
      if (ev.key === "Enter" || ev.key === "Tab") { pick(matches[sel]); ev.preventDefault(); return; }
      if (ev.key === "Escape") { close(); return; }
    }
    if (ev.key === "Enter" && !ev.shiftKey && !ev.isComposing) { ev.preventDefault(); onSubmit(); }
  });
}

/**
 * Speak instead of typing: a mic button that dictates into the box (the browser's own speech recognition; in Safari
 * and Chrome the audio goes to Apple's or Google's speech service). Click to start, click again or press Enter to stop.
 * Hidden where the browser can't do it (Firefox, or a phone on plain http).
 */
let activeMic = null;
function micButton(input) {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR || !window.isSecureContext) return null;
  const btn = h("button", { type: "button", class: "mic-btn", "aria-label": "Dictate", "data-tip": "Speak instead of typing", "data-tip-pos": "up" }, icon("mic", 16));
  let rec = null, base = "", finalText = "", sent = false;
  // stop(true): the message is being sent with what's in the box, so drop anything still arriving.
  const stop = (sending = false) => { if (!rec) return; if (sending) { sent = true; rec.abort(); } else rec.stop(); };
  const render = (interim) => {
    const spoken = (finalText + interim).trim();
    input.value = base + (base && spoken && !/\s$/.test(base) ? " " : "") + spoken;
    input.dispatchEvent(new Event("input"));
    input.scrollTop = input.scrollHeight;
  };
  btn.addEventListener("click", () => {
    if (rec) { stop(); return; }
    if (activeMic && activeMic !== stop) activeMic();
    rec = new SR();
    rec.continuous = true; rec.interimResults = true; rec.lang = navigator.language || "en-US";
    base = input.value; finalText = ""; sent = false;
    rec.onresult = (ev) => {
      let interim = "";
      for (let i = ev.resultIndex; i < ev.results.length; i++) {
        const r = ev.results[i];
        if (r.isFinal) finalText += r[0].transcript + " "; else interim += r[0].transcript;
      }
      render(interim);
    };
    rec.onerror = (ev) => {
      if (ev.error === "not-allowed" || ev.error === "service-not-allowed") toast("Microphone blocked. Allow it for this page in your browser's settings, then try again.", { error: true });
      else if (ev.error === "no-speech") toast("Didn't hear anything.");
      else if (ev.error !== "aborted") toast(`Dictation stopped: ${ev.error}`, { error: true });
    };
    rec.onend = () => { if (!sent) render(""); rec = null; activeMic = null; btn.classList.remove("on"); btn.dataset.tip = "Speak instead of typing"; input.focus(); };
    try { rec.start(); } catch (err) { rec = null; fail(err); return; }
    activeMic = stop;
    btn.classList.add("on"); btn.dataset.tip = "Listening… click to stop";
  });
  // Sending or pressing Enter ends dictation, so the next message doesn't keep listening.
  input.addEventListener("keydown", (ev) => { if (rec && ev.key === "Enter" && !ev.shiftKey) stop(true); });
  return btn;
}

function setupComposer() {
  const input = $("input"), send = $("send");
  const mic = micButton(input);
  if (mic) $("mic-slot")?.replaceWith(mic);
  send.addEventListener("click", () => activeMic?.(true), { capture: true });
  const submit = async () => {
    const text = input.value.trim(); if (!text) return;
    send.disabled = true;
    try {
      await dispatch({ type: "message.send", threadId: state.threadId, text });
      input.value = "";
    } catch (err) { fail(err); }
    input.dispatchEvent(new Event("input")); input.focus();
  };
  attachMentions(input, $("composer"), submit);
  send.addEventListener("click", submit);
  const sync = () => { send.disabled = !input.value.trim(); };
  input.addEventListener("input", sync); sync();
}

// ---------- dialogs ----------
function fail(err) { toast(err?.message ?? String(err), { error: true }); }
for (const btn of document.querySelectorAll("[data-close]")) btn.addEventListener("click", () => btn.closest("dialog").close());

let editingAgent = null, editingTemplate = null, handleTouched = false;
/** Same rule as the server: "Code Reviewer 🐛" → "code-reviewer". */
function toHandle(text) {
  let h = text.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/^@/, "").replace(/['’]/g, "")
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 32).replace(/-+$/, "");
  if (/^[0-9]/.test(h)) h = ("a-" + h).slice(0, 32);
  return h.length >= 2 ? h : "agent";
}
const agentLabel = (a) => a.displayName || "@" + a.name;
function openAgentDialog(agent = null, template = null) {
  editingAgent = agent; editingTemplate = template; handleTouched = !!agent;
  const f = $("agent-form");
  f.reset();
  $("agent-error").textContent = "";
  $("agent-dialog-title").textContent = agent ? `Edit ${agentLabel(agent)}` : template ? `Add ${template.name}` : "New agent";
  $("agent-submit").textContent = agent ? "Save" : "Create agent";
  $("agent-delete").hidden = !agent;
  f.elements.provider.replaceChildren(...engineOptions());
  f.elements.provider.disabled = !!agent;
  if (template) {
    f.elements.name.value = template.name;
    f.elements.handle.value = template.handle;
    f.elements.description.value = template.description;
    f.elements.instructions.value = template.instructions;
    f.elements.runtimeMode.value = template.runtimeMode;
    f.elements.canLead.checked = template.id === "lead";
    handleTouched = true;
  }
  if (agent) {
    f.elements.name.value = agent.displayName || agent.name;
    f.elements.handle.value = agent.name;
    f.elements.description.value = agent.description;
    f.elements.instructions.value = agent.instructions;
    f.elements.provider.value = agent.provider;
    f.elements.model.value = agent.model ?? "";
    f.elements.runtimeMode.value = agent.runtimeMode;
    f.elements.canLead.checked = !!agent.canLead;
  }
  $("agent-dialog").showModal();
}
$("agent-form").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const f = ev.target, v = (n) => f.elements[n].value.trim();
  try {
    if (editingAgent) {
      await dispatch({ type: "agent.update", agentId: editingAgent.id, displayName: v("name"), handle: v("handle") || toHandle(v("name")), canLead: f.elements.canLead.checked, description: v("description"), instructions: v("instructions"), model: v("model"), runtimeMode: v("runtimeMode") });
      toast(`Saved. ${v("name")} picks up the change on its next turn.`);
    } else {
      const res = await dispatch({ type: "agent.create", name: v("name"), handle: v("handle") || undefined, templateId: editingTemplate?.id, canLead: f.elements.canLead.checked, description: v("description"), instructions: v("instructions"), provider: v("provider"), model: v("model") || undefined, runtimeMode: v("runtimeMode") });
      openThread(res.threadId);
    }
    $("agent-dialog").close();
  } catch (err) { $("agent-error").textContent = err.message; }
});
// The @handle follows the name until you edit it yourself.
$("agent-form").elements.name.addEventListener("input", (ev) => {
  if (!handleTouched) $("agent-form").elements.handle.value = ev.target.value.trim() ? toHandle(ev.target.value) : "";
});
$("agent-form").elements.handle.addEventListener("input", () => { handleTouched = true; });
$("agent-form").elements.handle.addEventListener("blur", (ev) => { if (ev.target.value.trim()) ev.target.value = toHandle(ev.target.value); });

// ---------- gallery of ready-made agents ----------
let templates = null, departments = [], galleryDept = "";
async function openAgentGallery() {
  $("agent-gallery").showModal();
  if (!templates) {
    $("gallery-list").replaceChildren(h("div", { class: "picker-empty" }, "Loading…"));
    try { ({ templates, departments } = await call("listAgentTemplates")); } catch (err) { $("agent-gallery").close(); return fail(err); }
  }
  $("gallery-filter").value = "";
  renderGallery();
}
function renderGallery() {
  const have = new Set([...state.agents.values()].map((a) => a.templateId).filter(Boolean));
  const q = $("gallery-filter").value.trim().toLowerCase();
  const match = (t) => (!galleryDept || t.department === galleryDept) &&
    (!q || [t.name, t.handle, t.description, t.department].some((x) => x.toLowerCase().includes(q)));
  $("gallery-depts").replaceChildren(...["", ...departments].map((d) =>
    h("button", { type: "button", class: d === galleryDept ? "on" : "", onclick: () => { galleryDept = d; renderGallery(); } },
      d || `All (${templates.length})`)));
  const card = (t) => {
    const added = have.has(t.id);
    const add = h("button", { type: "button", class: "btn primary" }, "Recruit");
    add.addEventListener("click", async () => { add.disabled = true; await recruit([t]); });
    return h("div", { class: "tpl" },
      h("div", { class: "tpl-head" }, agentTile({ templateId: t.id, name: t.name }, 34),
        h("div", {}, h("div", { class: "tpl-name" }, t.name), h("div", { class: "tpl-handle" }, "@" + t.handle))),
      h("div", { class: "tpl-desc" }, t.description),
      h("div", { class: "tpl-actions" },
        added ? h("span", { class: "added" }, "✓ On the team") : add,
        h("button", { type: "button", class: "link", onclick: () => { $("agent-gallery").close(); openAgentDialog(null, t); } }, added ? "Add another, customized…" : "Customize first…")));
  };
  const kids = [];
  for (const dept of departments) {
    const list = templates.filter((t) => t.department === dept && match(t));
    if (!list.length) continue;
    const missing = list.filter((t) => !have.has(t.id));
    kids.push(h("div", { class: "dept-head" }, h("h4", {}, dept), h("span", { class: "count" }, `${list.length - missing.length}/${list.length} recruited`),
      missing.length > 1 ? h("button", { type: "button", class: "link", onclick: (ev) => { ev.target.disabled = true; recruit(missing); } }, `Recruit all ${missing.length}`) : null));
    kids.push(h("div", { class: "gallery" }, ...list.map(card)));
  }
  if (!kids.length) kids.push(h("div", { class: "picker-empty" }, "No agents match."));
  $("gallery-list").replaceChildren(...kids);
}
async function recruit(list) {
  let ok = 0;
  for (const t of list) {
    try {
      await dispatch({ type: "agent.create", name: t.name, handle: t.handle, templateId: t.id, description: t.description, instructions: t.instructions, runtimeMode: t.runtimeMode });
      ok++;
    } catch (err) { fail(err); }
  }
  await new Promise((r) => setTimeout(r, 200));
  renderGallery();
  if (ok === 1) toast(`${list[0].name} joined. Mention it with @${[...state.agents.values()].find((a) => a.templateId === list[0].id)?.name ?? list[0].handle}.`);
  else if (ok) toast(`${ok} agents joined the team.`);
}
$("gallery-filter").addEventListener("input", () => renderGallery());
$("gallery-custom").addEventListener("click", () => { $("agent-gallery").close(); openAgentDialog(); });

$("agent-delete").addEventListener("click", async () => {
  if (!editingAgent || !confirm(`Delete ${agentLabel(editingAgent)}? Its conversation stays as an ordinary thread.`)) return;
  try { await dispatch({ type: "agent.delete", agentId: editingAgent.id }); $("agent-dialog").close(); } catch (err) { $("agent-error").textContent = err.message; }
});
async function resetAgent(agent) {
  if (!confirm(`Start ${agentLabel(agent)}'s conversation over? It forgets everything said so far; its instructions stay.`)) return;
  try { await dispatch({ type: "agent.reset", agentId: agent.id }); toast(`${agentLabel(agent)} starts fresh on its next turn.`); } catch (err) { fail(err); }
}

async function showDiff(from, to) {
  try {
    const text = await call("getDiff", { threadId: state.threadId, fromOrdinal: from, toOrdinal: to });
    $("diff-title").textContent = `Changes in turn ${to}`;
    $("diff-body").replaceChildren(...(text || "(no changes)").split("\n").map((line) =>
      h("div", { class: line.startsWith("+") && !line.startsWith("+++") ? "add" : line.startsWith("-") && !line.startsWith("---") ? "del" : line.startsWith("@@") ? "hunk" : "" }, line || " ")));
    $("diff-dialog").showModal();
  } catch (err) { fail(err); }
}
// ---------- your projects: offer the folders you've used Claude Code or Codex in ----------
let suggestShown = false;
async function checkProjectSuggestions(onConnect = false) {
  let r; try { r = await call("projectSuggestions"); } catch { return; }
  const box = $("project-suggest");
  if (!r.items.length) { box.replaceChildren(); return; }
  // A fresh install: ask right away, once per page load.
  if (r.firstRun && onConnect && !suggestShown) { suggestShown = true; box.replaceChildren(); openProjectSuggestions(r.items, true); return; }
  const tools = [...new Set(r.items.flatMap((i) => i.tools))].map((t) => (t === "codex" ? "Codex" : "Claude Code")).join(" and ");
  box.replaceChildren(h("button", { class: "suggest-banner", onclick: () => openProjectSuggestions(r.items, false) },
    icon("folderplus", 14), h("span", {}, `${r.items.length} project${r.items.length === 1 ? "" : "s"} from ${tools}`), h("span", { class: "go" }, "Review")));
}
setInterval(() => { if (ws?.readyState === 1) checkProjectSuggestions(); }, 30 * 60_000);
function openProjectSuggestions(items, first) {
  const recent = Date.now() - 90 * 24 * 3600_000;
  const rows = items.map((it, i) => ({ it, on: i < 15 && (!it.lastUsedAt || Date.parse(it.lastUsedAt) > recent) }));
  const count = h("span", {});
  const add = h("button", { class: "btn primary", type: "button" });
  const sync = () => { const n = rows.filter((r) => r.on).length; add.textContent = n ? `Add ${n} project${n === 1 ? "" : "s"}` : "Add projects"; add.disabled = !n; count.textContent = `${n} of ${rows.length} selected`; };
  const list = h("div", { class: "suggest-list" }, ...rows.map((r) => {
    const box = h("input", { type: "checkbox", checked: r.on, onchange: (ev) => { r.on = ev.target.checked; sync(); } });
    return h("label", { class: "import-row" }, box, folderIcon(),
      h("span", { class: "row-main" }, h("div", { class: "row-title" }, r.it.name), h("div", { class: "faint" }, r.it.where)),
      h("span", { class: "suggest-tools" }, ...r.it.tools.map((t) => h("span", { class: "tool-chip " + t }, t === "codex" ? "Codex" : "Claude Code"))),
      r.it.lastUsedAt ? h("span", { class: "faint", style: "white-space:nowrap" }, ago(r.it.lastUsedAt)) : null);
  }));
  const all = (on) => { rows.forEach((r) => (r.on = on)); list.querySelectorAll(".import-row input").forEach((b) => (b.checked = on)); sync(); };
  const withChats = h("input", { type: "checkbox", checked: true });
  const dlg = h("dialog", { class: "suggest-dlg" },
    h("div", { class: "dlg-head" }, h("h3", {}, first ? "Bring in your projects" : "New projects found"),
      h("button", { class: "icon-btn", "aria-label": "Close", onclick: () => dlg.close() }, icon("x", 15))),
    h("p", { class: "muted" }, `Bullpen found ${rows.length} folder${rows.length === 1 ? "" : "s"} you've worked in with Claude Code or Codex. Add the ones you want in the sidebar; you can resume their past sessions from there.`),
    h("div", { class: "suggest-bar" }, count, h("span", { class: "spacer" }),
      h("button", { class: "link", type: "button", onclick: () => all(true) }, "Select all"), h("button", { class: "link", type: "button", onclick: () => all(false) }, "None")),
    list,
    h("label", { class: "check suggest-chats" }, withChats, h("span", {}, "Also bring in their recent chats (last 30 days), with the conversation so far, so you can pick them up here")),
    h("div", { class: "dialog-actions" },
      h("button", { class: "link", type: "button", onclick: () => { dlg.close(); openImport(); } }, "Choose from all folders…"),
      h("span", { class: "spacer" }),
      h("button", { class: "btn", type: "button", onclick: async () => {
        await dispatch({ type: "projects.dismissSuggestions", paths: rows.map((r) => r.it.path) }).catch(fail);
        dlg.close(); $("project-suggest").replaceChildren();
        toast("OK. Add projects any time with the + next to Projects.");
      } }, "Not now"),
      add));
  add.addEventListener("click", async () => {
    add.disabled = true;
    const picked = rows.filter((r) => r.on), skipped = rows.filter((r) => !r.on);
    try {
      add.textContent = withChats.checked ? "Bringing in chats…" : "Adding…";
      const res = await dispatch({ type: "project.import", projects: picked.map((r) => ({ path: r.it.path, lastUsedAt: r.it.lastUsedAt })), sessions: withChats.checked ? 10 : 0 });
      if (skipped.length) await dispatch({ type: "projects.dismissSuggestions", paths: skipped.map((r) => r.it.path) });
      dlg.close(); $("project-suggest").replaceChildren();
      toast(`Added ${picked.length} project${picked.length === 1 ? "" : "s"}${res.sessions ? ` and ${res.sessions} chat${res.sessions === 1 ? "" : "s"}` : ""} to the sidebar.`);
    } catch (err) { fail(err); add.disabled = false; }
  });
  dlg.addEventListener("close", () => dlg.remove());
  document.body.append(dlg); dlg.showModal(); sync();
}

// ---------- updates: a small notice when a newer release is out ----------
async function checkForUpdate() {
  let v; try { v = await call("version"); } catch { return; }
  const pill = $("update-pill");
  pill.hidden = !v.updateAvailable;
  if (!v.updateAvailable) return;
  pill.textContent = `Update to ${v.latest}`;
  pill.title = `You have v${v.current}. Updating takes a few seconds and restarts Bullpen; running agents are resumed.`;
  pill.onclick = async () => {
    if (!confirm(`Update Bullpen to ${v.latest}? It restarts in a few seconds; work in progress picks back up.`)) return;
    try { await call("update.run"); toast("Updating… Bullpen reconnects on its own."); pill.disabled = true; } catch (err) { fail(err); }
  };
}
setInterval(() => { if (ws?.readyState === 1) checkForUpdate(); }, 6 * 3600_000);

// ---------- use from another device ----------
async function openRemote() {
  let info;
  try { info = await call("remote.info"); } catch (err) { return fail(err); }
  const copy = (text, what) => navigator.clipboard?.writeText(text).then(() => toast(`${what} copied.`));
  const cmdRow = (cmd, label) => h("div", { class: "cmd-row" }, h("code", {}, cmd), h("button", { class: "btn sm", onclick: () => copy(cmd, label) }, icon("copy", 13), "Copy"));
  const body = [];
  if (info.listening && info.url) {
    const qr = h("div", { class: "qr" }); qr.innerHTML = info.qr; // generated by the server from our own URL
    let shown = false;
    const link = h("code", { class: "secret" }, info.url.replace(/token=.*/, "token=••••••••"));
    body.push(
      h("p", {}, `Remote access is on, ${info.via === "lan" ? "on your local network" : "over Tailscale"}. Scan this with your phone's camera${info.via === "tailscale" ? " (Tailscale has to be on there too)" : ""}:`),
      qr,
      h("div", { class: "cmd-row" }, link,
        h("button", { class: "btn sm", onclick: (ev) => { shown = !shown; link.textContent = shown ? info.url : info.url.replace(/token=.*/, "token=••••••••"); ev.currentTarget.lastChild.textContent = shown ? "Hide" : "Show"; } }, icon("lock", 13), h("span", {}, "Show")),
        h("button", { class: "btn sm", onclick: () => copy(info.url, "Link") }, icon("copy", 13), "Copy")),
      h("p", { class: "muted" }, "Anyone with this link can use Bullpen as you, including running commands through your agents. To cut every device off, run ", h("code", {}, "bullpen remote reset"), "; to turn it off, ", h("code", {}, "bullpen remote off"), "."),
      info.via === "lan" ? h("p", { class: "warn-note" }, "On the local network the connection isn't encrypted. Use it only on a network you trust.") : null);
  } else {
    body.push(
      h("p", {}, info.enabled ? `Remote access is on, but no ${info.via === "lan" ? "local network" : "Tailscale"} address is available right now. Only this Mac can connect.` : "Only this Mac can use Bullpen right now. To use it from your phone or another computer, run one of these in Terminal on this Mac:"),
      h("h4", {}, "Phone or laptop, anywhere (recommended)"),
      h("p", { class: "muted" }, "Install Tailscale on this Mac and your phone, sign in to both, then:"),
      cmdRow("bullpen remote on", "Command"),
      h("h4", {}, "Same Wi-Fi only"),
      cmdRow("bullpen remote on --lan", "Command"),
      h("p", { class: "muted" }, "Plain HTTP on your local network: only on a network you trust."),
      h("h4", {}, "Another computer with SSH access to this Mac"),
      cmdRow("bullpen remote ssh", "Command"),
      h("p", { class: "muted" }, "Prints a tunnel command and a link; nothing is opened to the network."),
      h("p", { class: "muted" }, "Then come back here for the QR code."));
  }
  const dlg = h("dialog", { class: "remote-dlg" }, h("div", { class: "dlg-head" }, h("h3", {}, "Use from another device"),
    h("button", { class: "icon-btn", "aria-label": "Close", onclick: () => dlg.close() }, icon("x", 15))), ...body.filter(Boolean));
  dlg.addEventListener("close", () => dlg.remove());
  document.body.append(dlg);
  dlg.showModal();
}

async function rollback(ordinal) {
  if (!confirm(`Restore this chat to ${ordinal === 0 ? "before its first turn" : `after turn ${ordinal}`}? Files go back to how they were, and the agent forgets the later turns. A safety snapshot of the files is taken first.`)) return;
  try {
    const r = await dispatch({ type: "checkpoint.rollback", threadId: state.threadId, ordinal });
    toast(r.conversation === "unchanged" ? "Files restored (this engine can't rewind its conversation)." : "Files and conversation restored.");
  } catch (err) { fail(err); }
}

$("new-agent").addEventListener("click", () => openAgentGallery());
$("remote-btn").addEventListener("click", () => { $("settings-dialog").close(); openRemote(); });
$("settings-btn").addEventListener("click", () => openSettings());
$("settings-close").addEventListener("click", () => $("settings-dialog").close());
$("shortcuts-btn").addEventListener("click", () => { $("settings-dialog").close(); openShortcuts(); });
/** One place for every preference (theme, briefing, notifications, sync, remote access, version). */
async function openSettings() {
  const st = state.settings ?? {};
  const row = (title, sub, control) => h("div", { class: "set-row" }, h("div", {}, h("b", {}, title), sub ? h("div", { class: "faint" }, sub) : null), control);
  const time = h("input", { type: "time", value: st.briefingTime ?? "08:00", onchange: (ev) => dispatch({ type: "settings.update", briefingTime: ev.target.value }).catch(fail) });
  const brief = h("label", { class: "check" }, h("input", { type: "checkbox", checked: st.briefingEnabled !== false, onchange: (ev) => dispatch({ type: "settings.update", briefingEnabled: ev.target.checked }).catch(fail) }), " at ", time);
  const notes = h("input", { type: "checkbox", checked: st.notifications !== false, onchange: (ev) => dispatch({ type: "settings.update", notifications: ev.target.checked }).catch(fail) });
  const sync = h("input", { type: "checkbox", checked: st.claudeArtifacts === true, onchange: (ev) => dispatch({ type: "settings.update", claudeArtifacts: ev.target.checked }).catch(fail) });
  const version = h("span", { class: "faint" }, "…");
  $("settings-dyn").replaceChildren(
    row("Morning briefing", "A summary of what your jobs did, on Home", brief),
    row("Mac notifications", "When something needs you", notes),
    row("Pull artifacts from claude.ai", "Only works where Claude Code can read them", sync),
    row("Version", null, version));
  $("settings-dialog").showModal();
  try {
    const v = await call("version");
    version.replaceChildren(`v${v.current}${v.branch ? ` (${v.branch})` : ""} `, v.updateAvailable ? h("button", { class: "btn sm primary", onclick: () => $("update-pill").click() }, `Update to ${v.latest}`) : "");
  } catch { version.textContent = ""; }
}
$("palette-pick").value = document.documentElement.dataset.palette || "graphite";
$("palette-pick").addEventListener("change", (ev) => {
  const v = ev.target.value;
  if (v !== "graphite") document.documentElement.dataset.palette = v; else delete document.documentElement.dataset.palette;
  try { localStorage.setItem("bp-palette", v); } catch {}
});
$("stop-server").addEventListener("click", async () => {
  $("settings-dialog").close();
  const busy = [...state.threads.values()].filter((t) => t.status === "running").length;
  if (!confirm(busy ? `Stop the server? ${busy} chat(s) are working and will be interrupted.` : "Stop the Bullpen server? Agents can't be reached until it starts again.")) return;
  state.stopping = true;
  try { await call("shutdown"); } catch {}
});
$("new-thread").addEventListener("click", (ev) => { ev.stopPropagation(); popMenu(ev.currentTarget, [
  { icon: "folderplus", label: "New project", desc: "Make a new folder to work in", run: () => newProject(true) },
  { icon: "files", label: "Add a folder you have", desc: "Any folder on this Mac", run: () => newProject() },
  { icon: "list", label: "Choose which projects show", desc: "Including ones from Claude Code and Codex", run: () => openImport() },
]); });
$("new-chat").addEventListener("click", () => newThread());
$("new-project").addEventListener("click", () => newProject(true));
/** Pick a folder you have, or make a new one (create: open straight on the "new folder" form), then start a chat there. */
async function newProject(create = false) {
  const path = await pickFolder({ create });
  if (!path) return;
  try { await dispatch({ type: "project.add", path }); } catch (err) { return fail(err); }
  toast(`${folderName(path)} is ready. Describe what you want to do.`);
  newThread(path);
}

// ---------- preferences (this browser only) ----------
const prefs = {
  get() { try { return JSON.parse(localStorage.getItem("bp-prefs") || "{}"); } catch { return {}; } },
  set(patch) { try { localStorage.setItem("bp-prefs", JSON.stringify({ ...prefs.get(), ...patch })); } catch {} },
};
const folderName = (p) => (p || "").split("/").filter(Boolean).pop() || p;
const tildePath = (p) => (p || "").replace(/^\/Users\/[^/]+/, "~");
const folderIcon = () => h("span", { class: "folder-ic", "aria-hidden": "true" }, "▤");

// ---------- folder picker ----------
let pickerResolve = null;
function pickFolder({ create = false } = {}) {
  return new Promise(async (resolve) => {
    pickerResolve = resolve;
    pickerData = null;
    $("picker-search").value = "";
    $("picker").showModal();
    $("picker-search").focus();
    await pickerShowProjects();
    if (create && $("picker").open) pickerNewProject();
  });
}
function pickerDone(path) {
  const r = pickerResolve; pickerResolve = null;
  if ($("picker").open) $("picker").close();
  r?.(path);
}
$("picker").addEventListener("close", () => pickerDone(null));

let pickerData = null, pickerSel = 0, pickerRows = [], browsing = null, creating = false;
async function pickerShowProjects() {
  browsing = null; creating = false;
  $("picker-title").textContent = "Choose a project folder";
  $("picker-crumbs").hidden = true; $("picker-use").hidden = true; $("picker-browse").hidden = false;
  $("picker-new").hidden = false; $("picker-new").textContent = "New project…"; $("picker-search").hidden = false;
  if (!pickerData) {
    $("picker-list").replaceChildren(h("div", { class: "picker-empty" }, "Looking for projects…"));
    for (let i = 0; i < 20 && !(ws && ws.readyState === 1); i++) await new Promise((r) => setTimeout(r, 250));
    try { pickerData = await call("listProjects"); } catch (err) { return fail(err); }
  }
  pickerRender();
}
function pickerRender() {
  const q = $("picker-search").value.trim().toLowerCase();
  const list = $("picker-list");
  pickerRows = [];
  const groups = [];
  if (browsing) {
    const dirs = browsing.dirs.filter((d) => !q || d.name.toLowerCase().includes(q));
    groups.push(["", dirs]);
  } else if (q.startsWith("/") || q.startsWith("~")) {
    list.replaceChildren(h("div", { class: "picker-empty" }, "Press Enter to open this folder."));
    return;
  } else {
    const match = (p) => !q || p.name.toLowerCase().includes(q) || p.where.toLowerCase().includes(q);
    groups.push(["Recent", pickerData.recent.filter(match)], ["Projects on this Mac", pickerData.found.filter(match)]);
  }
  const children = [];
  for (const [title, items] of groups) {
    if (!items.length) continue;
    if (title) children.push(h("div", { class: "picker-group" }, title));
    for (const p of items) {
      const i = pickerRows.length;
      pickerRows.push(p);
      children.push(h("button", { type: "button", class: "row" + (i === pickerSel ? " sel" : ""), "data-i": i,
        onclick: () => (browsing ? pickerBrowse(p.path) : pickerDone(p.path)),
        ondblclick: () => browsing && pickerDone(p.path) },
        folderIcon(), h("span", { class: "row-main" }, h("div", { class: "row-title" }, p.name), h("div", { class: "row-sub" }, p.where))));
    }
  }
  if (!pickerRows.length) children.push(h("div", { class: "picker-empty" }, browsing ? "No subfolders." : "No matching projects. Try Browse folders…, or type a path."));
  list.replaceChildren(...children);
  list.querySelector(".sel")?.scrollIntoView({ block: "nearest" });
}
async function pickerBrowse(path) {
  try { browsing = await call("listDirs", { path }); } catch (err) { return fail(err); }
  pickerSel = 0;
  $("picker-search").value = "";
  $("picker-search").placeholder = "Filter folders";
  creating = false;
  $("picker-browse").hidden = true; $("picker-use").hidden = false; $("picker-search").hidden = false;
  $("picker-new").hidden = false; $("picker-new").textContent = "New folder here…";
  $("picker-crumbs").hidden = false;
  $("picker-crumbs").replaceChildren(...[
    browsing.parent ? h("button", { type: "button", class: "btn", onclick: () => pickerBrowse(browsing.parent) }, "↑ Up") : null,
    h("span", { title: browsing.path }, browsing.display)].filter(Boolean));
  pickerRender();
}
$("picker-browse").addEventListener("click", () => pickerBrowse("~"));

/** Inline form: name a new folder, created in the folder being browsed or the usual projects folder. */
function pickerNewProject() {
  const parent = browsing ? { path: browsing.path, display: browsing.display } : pickerData?.defaultParent;
  if (!parent) return;
  creating = true;
  $("picker-title").textContent = "New project";
  $("picker-search").hidden = true; $("picker-crumbs").hidden = true;
  $("picker-new").hidden = true; $("picker-browse").hidden = true; $("picker-use").hidden = true;
  const name = h("input", { type: "text", placeholder: "my-new-project", autocomplete: "off", spellcheck: "false" });
  const git = h("input", { type: "checkbox", checked: true });
  const err = h("div", { class: "form-error" });
  const create = h("button", { type: "button", class: "btn primary" }, "Create and use");
  const submit = async () => {
    if (!name.value.trim()) { name.focus(); return; }
    create.disabled = true; err.textContent = "";
    try {
      const made = await call("createFolder", { parent: parent.path, name: name.value, git: git.checked });
      pickerDone(made.path);
    } catch (e) { err.textContent = e.message; create.disabled = false; name.focus(); }
  };
  name.addEventListener("keydown", (ev) => { if (ev.key === "Enter") { ev.preventDefault(); submit(); } });
  create.addEventListener("click", submit);
  $("picker-list").replaceChildren(h("div", { class: "new-project" },
    h("label", {}, "Folder name", name),
    h("div", { class: "where" }, "Created in", h("code", { title: parent.path }, parent.display),
      h("button", { type: "button", class: "link", onclick: () => pickerBrowse(parent.path) }, "Change")),
    h("label", { class: "check" }, git, h("span", {}, "Start it as a git repository ", h("span", { class: "faint" }, "(needed for checkpoints, diffs and restore)"))),
    err,
    h("div", { class: "dialog-actions" },
      h("button", { type: "button", class: "btn", onclick: () => (browsing ? pickerBrowse(browsing.path) : pickerShowProjects()) }, "Back"),
      create)));
  name.focus();
}
$("picker-new").addEventListener("click", pickerNewProject);
$("picker-use").addEventListener("click", () => browsing && pickerDone(browsing.path));
$("picker-search").addEventListener("input", () => { pickerSel = 0; pickerRender(); });
$("picker-search").addEventListener("keydown", (ev) => {
  const q = $("picker-search").value.trim();
  if (ev.key === "ArrowDown") { pickerSel = Math.min(pickerSel + 1, pickerRows.length - 1); pickerRender(); ev.preventDefault(); }
  else if (ev.key === "ArrowUp") { pickerSel = Math.max(pickerSel - 1, 0); pickerRender(); ev.preventDefault(); }
  else if (ev.key === "Enter") {
    ev.preventDefault();
    if (!browsing && (q.startsWith("/") || q.startsWith("~"))) return pickerBrowse(q);
    const row = pickerRows[pickerSel];
    if (row) browsing ? pickerBrowse(row.path) : pickerDone(row.path);
  }
});

// ---------- start screen: type what you want, pick a project, go ----------
function newThread(projectPath, fromHistory = false) {
  if (projectPath) prefs.set({ cwd: projectPath });
  if (state.sub) call("unsubscribe", { subscription: state.sub }).catch(() => {});
  state.sub = null; state.threadId = null; state.thread = null; state.view = null;
  if (!fromHistory) routeTo("");
  renderSidebar(); renderMain();
}
// ---------- home: what needs you, what's running, where you left off ----------
function homeData() {
  const homes = new Map([...state.agents.values()].map((a) => [a.homeThreadId, a]));
  const needs = [], running = [];
  // Approvals inside a team's tasks are counted once, as "a team needs you".
  const teamRuns = new Set([...state.threads.values()].flatMap((t) => t.team?.runs ?? []));
  for (const t of state.threads.values()) {
    const n = teamRuns.has(t.id) ? 0 : state.approvals.get(t.id)?.size ?? 0;
    // An agent's spare copy counts as the agent.
    const a = homes.get(t.id) ?? (t.cloneOf ? state.agents.get(t.cloneOf) : undefined);
    if (n) needs.push({ title: `${a ? agentLabel(a) : t.title} needs your OK${n > 1 ? ` (${n})` : ""}`, sub: a ? "Waiting on a command or edit" : folderName(t.cwd), open: () => openThread(t.id) });
    if (t.team?.needsYou) needs.push({ title: "A team needs you", sub: t.title, open: () => openThread(t.id) });
    if (t.team?.active) running.push({ icon: "users", title: t.title, sub: `Team · ${folderName(t.cwd)}`, open: () => openThread(t.id) });
    else if (t.status === "running" && !t.jobId) running.push({ el: a ? agentTile(a) : icon("message", 16), title: a ? agentLabel(a) : t.title, sub: a ? "Working" : folderName(t.cwd), open: () => openThread(t.id) });
  }
  for (const j of state.jobs.values()) {
    if (j.lastStatus === "needs-you" || j.lastStatus === "failed") needs.push({ title: j.lastStatus === "failed" ? `${j.name} failed` : `${j.name} needs a decision`, sub: describeTrigger(j.trigger), open: () => openThread(j.threadId) });
    if (j.lastStatus === "running") { const a = state.agents.get(j.agentId); running.push({ icon: "clock", title: j.name, sub: `Job${a ? " · " + agentLabel(a) : ""}`, open: () => openThread(j.threadId) }); }
  }
  for (const l of state.lessons.values()) if (l.status === "proposed") {
    const a = state.agents.get(l.agentId);
    needs.push({ quiet: true, title: `New lesson from ${a ? agentLabel(a) : "an agent"}`, sub: `“${l.text}”`, lesson: l });
  }
  const recent = [...state.threads.values()].filter((t) => !homes.has(t.id) && !t.jobId).sort((a, b) => activity(b).localeCompare(activity(a))).slice(0, 6);
  return { needs, running, recent };
}
function refreshHome() {
  const head = $("home-head"), secs = $("home-secs");
  if (!head || !secs) return;
  const { needs, running, recent } = homeData();
  const fresh = !state.agents.size && !state.threads.size;
  head.replaceChildren(
    h("div", { class: "home-date" }, new Date().toLocaleDateString([], { weekday: "long", month: "long", day: "numeric" })),
    h("h1", {}, fresh ? "Describe some work to get started."
      : `${needs.length ? (needs.length === 1 ? "One thing needs you." : `${needs.length} things need you.`) : "Nothing needs you."} ${running.length ? (running.length === 1 ? "One thing is running." : `${running.length} things are running.`) : "Everything is quiet."}`));
  const sec = (title, n, body, extra) => h("section", { class: "home-sec" },
    h("div", { class: "home-sec-h" }, h("h2", {}, title), n ? h("span", { class: "n" }, String(n)) : null, h("span", { class: "spacer" }), extra ?? null), body);
  const decide = (l, decision) => dispatch({ type: "lesson.decide", lessonId: l.id, decision }).then(refreshLessonViews).catch(fail);
  const kids = [];
  if (needs.length) kids.push(sec("Needs you", needs.length, h("div", { class: "hlist" }, ...needs.slice(0, 6).map((it) => h("div", { class: "hrow" },
    h("span", { class: "hdot" + (it.quiet ? " quiet" : "") }),
    h("div", { class: "hm" }, h("div", { class: "ht" }, it.title), h("div", { class: "hs" }, it.sub)),
    ...(it.lesson
      ? [h("button", { type: "button", class: "btn ghost sm", onclick: () => decide(it.lesson, "reject") }, "Dismiss"), h("button", { type: "button", class: "btn sm", onclick: () => decide(it.lesson, "approve") }, "Approve")]
      : [h("button", { type: "button", class: "btn sm", onclick: it.open }, "Open")])))),
    needs.length > 6 ? h("span", { class: "faint" }, `and ${needs.length - 6} more`) : null));
  if (running.length) kids.push(sec("Running now", running.length, h("div", { class: "hlist" }, ...running.map((it) => h("button", { type: "button", class: "hrow", onclick: it.open },
    it.el ?? icon(it.icon, 16), h("div", { class: "hm" }, h("div", { class: "ht" }, it.title), h("div", { class: "hs" }, it.sub)),
    h("span", { class: "home-when" }, "Working"))))));
  if (!state.agents.size) kids.push(sec("Your team", 0, h("div", { class: "hlist" }, h("div", { class: "hrow" }, icon("userplus", 16),
    h("div", { class: "hm" }, h("div", { class: "ht" }, "Recruit specialists"), h("div", { class: "hs" }, "Reviewers, testers, a lead who runs a team. Mention them in any project.")),
    h("button", { type: "button", class: "btn sm primary", onclick: () => openAgentGallery() }, "Recruit agents")))));
  if (recent.length) kids.push(sec("Recent", 0, h("div", { class: "rlist" }, ...recent.map((t) => h("button", { type: "button", class: "rrow", onclick: () => openThread(t.id) },
    h("span", { class: "rt" }, t.title), h("span", { class: "rp" }, projectAt(t.cwd)?.title ?? folderName(t.cwd)), h("span", { class: "home-when" }, ago(activity(t))))))));
  // What jobs did (and the briefing that sums it up): was the Inbox page.
  const ib = state.inbox;
  if (ib && (state.jobs.size || ib.latest)) {
    const b = ib.latest ?? ib.recent;
    kids.push(sec("While you were away", 0, h("div", {},
      b?.headline ? h("div", { class: "home-brief" }, h("b", {}, b.headline), b.lines?.length ? h("ul", {}, ...b.lines.slice(0, 6).map((l) => h("li", {}, l))) : null) : null,
      ib.pausedUntil && Date.parse(ib.pausedUntil) > Date.now() ? h("div", { class: "faint" }, `Jobs are paused until ${new Date(ib.pausedUntil).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })} (usage limit).`) : null,
      h("div", { class: "hlist" }, ...ib.runs.slice(0, 6).map((r) => {
        const j = state.jobs.get(r.jobId);
        return h("button", { type: "button", class: "hrow", onclick: () => j && openThread(j.threadId) }, h("span", { class: "dot " + r.status }),
          h("div", { class: "hm" }, h("div", { class: "ht" }, `${j?.name ?? "Deleted job"} · ${r.status === "needs-you" ? "needs you" : r.status}`), h("div", { class: "hs" }, `${ago(r.startedAt)}${r.summary ? ` · ${r.summary.slice(0, 120)}` : ""}`)));
      }))),
      h("button", { type: "button", class: "link", onclick: () => openJobDialog() }, "+ New job")));
  }
  const nLessons = [...state.lessons.values()].filter((l) => l.status === "approved").length;
  kids.push(h("div", { class: "home-links" },
    h("button", { type: "button", class: "link", onclick: () => openLessons(null) }, `Lessons${nLessons ? ` (${nLessons})` : ""}`),
    h("button", { type: "button", class: "link", onclick: () => openJobDialog() }, "New job"),
    h("button", { type: "button", class: "link", onclick: () => openSettings() }, "Settings")));
  secs.replaceChildren(...kids);
}
function renderStart() {
  const p = prefs.get();
  let cwd = p.cwd || "", provider = p.provider || "claude";
  const input = h("textarea", { rows: 3, placeholder: "Describe the work. Mention @agents to bring them in.", "aria-label": "Describe the work" });
  const projectBtn = h("button", { type: "button", class: "qbtn strong", "data-tip": "Project folder", "data-tip-pos": "start" });
  const renderProject = () => projectBtn.replaceChildren(...[icon("files", 14),
    cwd ? h("span", { class: "name" }, folderName(cwd)) : h("span", { class: "faint" }, "Choose project"), icon("chevdown", 12)]);
  // Past Claude Code sessions in the chosen project, to pick one back up.
  const resumeBox = h("div", { class: "resume" });
  const loadResume = async () => {
    resumeBox.replaceChildren();
    if (!cwd) return;
    const forPath = cwd;
    let sessions = [];
    try { sessions = await call("pastSessions", { path: forPath }); } catch { return; }
    if (forPath !== cwd || !sessions.length) return;
    resumeBox.replaceChildren(
      h("h3", {}, `Pick up where you left off in ${folderName(cwd)}`),
      ...sessions.slice(0, 6).map((ss) => h("button", { type: "button", class: "row", title: ss.title, onclick: async (ev) => {
        ev.currentTarget.disabled = true;
        try {
          const { threadId } = await dispatch({ type: "session.import", path: forPath, tool: ss.tool, id: ss.id });
          openThread(threadId);
        } catch (err) { fail(err); ev.currentTarget.disabled = false; }
      } },
        h("span", { class: "row-main" }, h("div", { class: "row-title" }, ss.title),
          h("div", { class: "row-sub" }, h("span", { class: "tool-chip " + ss.tool }, ss.tool === "codex" ? "Codex" : "Claude Code"), ` ${ago(ss.updatedAt)} · ${ss.sizeKb > 1024 ? (ss.sizeKb / 1024).toFixed(1) + " MB" : ss.sizeKb + " KB"}`)),
        h("span", { class: "go" }, "Resume →"))));
  };
  renderProject();
  projectBtn.addEventListener("click", async () => {
    const path = await pickFolder();
    if (path) { cwd = path; prefs.set({ cwd }); renderProject(); loadResume(); renderMode(); }
    input.focus();
  });
  const engine = h("select", { class: "qsel", "aria-label": "Engine" }, ...engineOptions());
  if (!ENGINES.some((e) => e.id === provider)) provider = "claude";
  engine.value = provider;
  engine.addEventListener("change", () => { provider = engine.value; prefs.set({ provider }); model.value = prefs.get()["model_" + provider] || ""; });
  const model = h("input", { type: "text", placeholder: "Model (provider default)", value: p["model_" + provider] || "" });
  // The project's access, shown (not a per-message choice): changing it is explicit and applies to every agent there.
  const mode = h("button", { type: "button", class: "qbtn", "data-tip": "What agents may do in this project without asking", "data-tip-pos": "start" });
  const renderMode = () => {
    const m = (cwd && projectAt(cwd)?.runtimeMode) || "approval-required";
    mode.value = m;
    mode.replaceChildren(icon(MODE_INFO[m].icon, 13), MODE_SHORT[m], icon("chevdown", 12));
  };
  mode.addEventListener("click", (ev) => {
    ev.stopPropagation();
    const proj = cwd && projectAt(cwd);
    if (!proj) { toast("Choose a project first; access is set per project."); return; }
    popMenu(mode, [{ header: `What agents may do in ${proj.title}` }, ...Object.entries(MODE_INFO).map(([m, info]) => ({ icon: m === mode.value ? "check" : info.icon, label: info.label, desc: info.desc, active: m === mode.value,
      run: () => dispatch({ type: "project.update", projectId: proj.id, runtimeMode: m }).then(() => { toast(`${proj.title}: ${info.label.toLowerCase()}. Every agent there follows this.`); setTimeout(renderMode, 150); }).catch(fail) }))]);
  });
  renderMode();
  const where = h("select", { class: "qsel", "aria-label": "Where to work" },
    h("option", { value: "local" }, "In your folder"),
    h("option", { value: "worktree" }, "In a separate copy"));
  where.title = "On a new branch: the work happens in its own git worktree, and your checkout isn't touched until you merge";
  where.value = p.where || "local";
  const more = h("div", { class: "more" }, model);
  const moreBtn = h("button", { type: "button", class: "qbtn", onclick: () => more.classList.toggle("open") }, "Model");
  const go = h("button", { type: "button", class: "send-btn", "aria-label": "Start", "data-tip": "Start   ↵", "data-tip-pos": "end" }, icon("send", 16));
  const composer = h("div", { class: "composer" }, input,
    h("div", { class: "start-bar" }, projectBtn, where, engine, mode, moreBtn, h("span", { class: "spacer" }), micButton(input), go), more);
  go.addEventListener("click", () => activeMic?.(true), { capture: true });

  const submit = async () => {
    const text = input.value.trim();
    if (!cwd) { projectBtn.click(); return; }
    if (!text) { input.focus(); return; }
    go.disabled = true;
    prefs.set({ where: where.value, ["model_" + provider]: model.value.trim() });
    try {
      if (where.value === "worktree") toast("Making a branch for this…");
      // The chat itself asks first; the project's access (shown above) applies on top.
      const { threadId } = await dispatch({ type: "thread.create", cwd, provider, model: model.value.trim() || undefined,
        title: where.value === "worktree" ? text.slice(0, 60) : undefined, worktree: where.value === "worktree" ? {} : undefined });
      // The choice is the project's: every agent pulled in here follows it.
      const proj = projectAt(cwd);

      await dispatch({ type: "message.send", threadId, text });
      openThread(threadId);
    } catch (err) { fail(err); go.disabled = false; }
  };
  go.addEventListener("click", submit);
  attachMentions(input, composer, submit);

  const secs = h("div", { id: "home-secs", style: "display:contents" });
  const head = h("div", { class: "home-head", id: "home-head" });
  $("main").replaceChildren(h("div", { class: "topbar ghost", id: "topbar" }, navCluster()),
    h("div", { class: "page", style: "padding:0" }, h("div", { class: "home" }, head, composer, resumeBox, secs)));
  refreshHome();
  call("inbox").then((d) => { state.inbox = d; refreshHome(); }).catch(() => {});
  input.focus();
  loadResume();
}


// ---------- ⌘K: search and jump anywhere ----------
let pal = null;
const PALETTES = [["harbor", "Harbor"], ["night", "Night"], ["paper", "Paper"], ["graphite", "Graphite"]];
function paletteItems() {
  const items = [];
  const add = (group, it) => items.push({ group, ...it });
  add("Go to", { icon: "home", title: "Home", sub: "what needs you, what's running, your briefing", kbd: "⌘1", run: () => newThread() });
  add("Go to", { icon: "users", title: "Teams", sub: "every goal your leads are running", kbd: "⌘2", run: () => openTeams() });
  add("Go to", { icon: "compose", title: "New chat", sub: "start something new", kbd: "⌥N", run: () => newThread() });
  add("Go to", { icon: "layers", title: "Artifacts", sub: "pages agents made, and your claude.ai artifacts", run: () => openArtifacts() });
  add("Go to", { icon: "folderplus", title: "New project", sub: "create a folder or add one you have", kbd: "⌥⇧N", run: () => newProject(true) });
  const homes = new Set([...state.agents.values()].map((a) => a.homeThreadId));
  for (const a of [...state.agents.values()].sort((x, y) => agentLabel(x).localeCompare(agentLabel(y))))
    add("Agents", { el: badge(agentLabel(a)), title: agentLabel(a), sub: "@" + a.name + (a.description ? " · " + a.description : ""), run: () => openThread(a.homeThreadId) });
  const threads = [...state.threads.values()].filter((t) => !homes.has(t.id) && !t.jobId && !t.cloneOf).sort((a, b) => activity(b).localeCompare(activity(a)));
  for (const t of threads.slice(0, 60))
    add("Chats", { icon: "message", title: t.title, sub: `${folderName(t.cwd)} · ${ago(activity(t))}`, recent: true, run: () => openThread(t.id) });
  for (const j of state.jobs.values())
    add("Jobs", { icon: "clock", title: j.name, sub: j.enabled ? describeTrigger(j.trigger) : "paused", run: () => openThread(j.threadId) });
  for (const p of [...state.projects.values()].filter((p) => !p.archivedAt))
    add("Projects", { el: projectIcon(p), title: p.title, sub: "new chat · " + tildePath(p.path), run: () => newThread(p.path) });
  add("Actions", { icon: "userplus", title: "Recruit agents", sub: "29 ready-made specialists", run: () => openAgentGallery() });
  add("Actions", { icon: "bot", title: "Create a custom agent", run: () => openAgentDialog() });
  add("Actions", { icon: "clock", title: "New standing job", run: () => openJobDialog() });
  add("Actions", { icon: "bulb", title: "Lessons for every agent", run: () => openLessons(null) });
  add("Actions", { icon: "list", title: "Choose which projects show in the sidebar", run: () => openImport() });
  if (state.threadId) {
    add("Actions", { icon: "files", title: ui.files ? "Hide files" : "Show files", kbd: "⌘⇧E", run: () => togglePanel("files") });
    add("Actions", { icon: "terminal", title: ui.terminal ? "Hide terminal" : "Show terminal", kbd: "⌃`", run: () => togglePanel("terminal") });
    add("Actions", { icon: "globe", title: ui.browser ? "Hide browser" : "Show browser", kbd: "⌘⇧B", run: () => togglePanel("browser") });
    const agent = state.thread?.agentId ? state.agents.get(state.thread.agentId) : null;
    if (agent) add("Actions", { icon: "edit", title: `Edit ${agentLabel(agent)}`, run: () => openAgentDialog(agent) });
    if (state.thread?.status === "running") add("Actions", { icon: "stop", title: "Stop the agent", run: () => dispatch({ type: "run.interrupt", threadId: state.threadId }).catch(fail) });
  }
  add("Actions", { icon: "sidebar", title: sideHidden ? "Show sidebar" : "Hide sidebar", kbd: "⌘\\", run: toggleSidebar });
  for (const [v, name] of PALETTES) add("Actions", { icon: "palette", title: `Theme: ${name}`, sub: (document.documentElement.dataset.palette || "graphite") === v ? "current" : "", run: () => { const sel = $("palette-pick"); sel.value = v; sel.dispatchEvent(new Event("change")); } });
  add("Actions", { icon: "keyboard", title: "Keyboard shortcuts", kbd: "?", run: openShortcuts });
  return items;
}
/** Fuzzy score: contiguous matches in the title win, then word starts, then any subsequence, then the subtitle. */
function palScore(it, q) {
  const t = it.title.toLowerCase(), sub = (it.sub || "").toLowerCase();
  const at = t.indexOf(q);
  if (at === 0) return 1000 - t.length;
  if (at > 0) return (/[\s@/·-]/.test(t[at - 1]) ? 800 : 600) - at;
  let i = 0, gaps = 0, last = -1;
  for (let k = 0; k < t.length && i < q.length; k++) if (t[k] === q[i]) { if (last >= 0 && k > last + 1) gaps++; last = k; i++; }
  if (i === q.length && gaps <= Math.max(1, Math.floor(q.length / 3))) return 400 - gaps * 20 - t.length;
  if (sub.includes(q)) return 200 - sub.indexOf(q);
  return -1;
}
function markTitle(title, q) {
  const at = q ? title.toLowerCase().indexOf(q) : -1;
  if (at < 0) return [title];
  return [title.slice(0, at), h("mark", {}, title.slice(at, at + q.length)), title.slice(at + q.length)];
}
function openPalette(initial = "") {
  if (pal) { pal.input.focus(); return; }
  closeMenu();
  const input = h("input", { class: "pal-input", placeholder: "Search agents, chats, jobs, projects, actions…", spellcheck: "false", autocomplete: "off", value: initial });
  const list = h("div", { class: "pal-list", role: "listbox" });
  const box = h("div", { class: "pal", role: "dialog", "aria-label": "Search and jump" },
    h("div", { class: "pal-search" }, icon("search", 17), input, kbd("esc")),
    list,
    h("div", { class: "pal-foot" }, h("span", {}, kbd("↑"), kbd("↓"), " move"), h("span", {}, kbd("↵"), " open"), h("span", {}, kbd("⌘K"), " close"), h("span", { class: "spacer" }), h("span", {}, kbd("⌘["), kbd("⌘]"), " back, forward")));
  const overlay = h("div", { class: "pal-overlay", onmousedown: (ev) => { if (ev.target === overlay) closePalette(); } }, box);
  document.body.append(overlay);
  const all = paletteItems();
  pal = { overlay, input, list, sel: 0, shown: [], all };
  const order = ["Go to", "Agents", "Chats", "Jobs", "Projects", "Actions"];
  const draw = () => {
    const q = input.value.trim().toLowerCase();
    let shown;
    if (!q) {
      const recent = all.filter((it) => it.group === "Chats").slice(0, 6).map((it) => ({ ...it, group: "Recent chats" }));
      shown = [...all.filter((it) => it.group === "Go to"), ...recent, ...all.filter((it) => it.group === "Agents"), ...all.filter((it) => it.group === "Jobs"), ...all.filter((it) => it.group === "Actions").slice(0, 4)];
    } else {
      const scored = all.map((it) => ({ it, sc: palScore(it, q) })).filter((x) => x.sc >= 0);
      // Group by kind, best groups first.
      const best = new Map();
      for (const { it, sc } of scored) best.set(it.group, Math.max(best.get(it.group) ?? -1, sc));
      shown = scored.sort((a, b) => (best.get(b.it.group) - best.get(a.it.group)) || order.indexOf(a.it.group) - order.indexOf(b.it.group) || b.sc - a.sc)
        .slice(0, 50).map((x) => x.it);
    }
    pal.shown = shown;
    pal.sel = Math.min(pal.sel, Math.max(0, shown.length - 1));
    const kids = [];
    let group = null;
    shown.forEach((it, idx) => {
      if (it.group !== group) { group = it.group; kids.push(h("div", { class: "pal-group" }, group)); }
      kids.push(h("button", { type: "button", class: "pal-row" + (idx === pal.sel ? " sel" : ""), role: "option", "data-idx": idx,
          onmousemove: () => { if (pal.sel !== idx) { pal.sel = idx; paint(); } }, onclick: () => runPal(idx) },
        h("span", { class: "lead" }, it.el ? it.el.cloneNode(true) : icon(it.icon, 15)),
        h("span", { class: "pm" }, h("span", { class: "t" }, ...markTitle(it.title, q)), it.sub ? h("span", { class: "s" }, it.sub) : null),
        h("span", { class: "go" }, it.kbd ? kbd(it.kbd) : null, h("span", { class: "ret" }, icon("enter", 14)))));
    });
    list.replaceChildren(...(kids.length ? kids : [h("div", { class: "pal-empty" }, `Nothing matches “${input.value}”.`)]));
  };
  const paint = () => {
    for (const r of list.querySelectorAll(".pal-row")) r.classList.toggle("sel", Number(r.dataset.idx) === pal.sel);
    list.querySelector(".pal-row.sel")?.scrollIntoView({ block: "nearest" });
  };
  const runPal = (idx) => { const it = pal.shown[idx]; if (!it) return; closePalette(); it.run(); };
  input.addEventListener("input", () => { pal.sel = 0; draw(); });
  input.addEventListener("keydown", (ev) => {
    if (ev.key === "ArrowDown") { ev.preventDefault(); pal.sel = (pal.sel + 1) % Math.max(1, pal.shown.length); paint(); }
    else if (ev.key === "ArrowUp") { ev.preventDefault(); pal.sel = (pal.sel - 1 + pal.shown.length) % Math.max(1, pal.shown.length); paint(); }
    else if (ev.key === "Enter") { ev.preventDefault(); runPal(pal.sel); }
    else if (ev.key === "Escape") { ev.preventDefault(); closePalette(); }
  });
  draw();
  input.focus();
}
function closePalette() { if (!pal) return; pal.overlay.remove(); pal = null; }
function openShortcuts() {
  const rows = [["Search and jump anywhere", "⌘K"], ["Back / forward", "⌘[  ⌘]"], ["Home", "⌘1"], ["Teams", "⌘2"], ["New chat", "⌥N"], ["New project", "⌥⇧N"],
    ["Show or hide the sidebar", "⌘\\"], ["Files", "⌘⇧E"], ["Terminal", "⌃`"], ["Browser", "⌘⇧B"], ["Send a message", "↵"], ["New line", "⇧↵"], ["Mention an agent", "@"], ["This list", "?"]];
  const d = h("dialog", {}, h("form", { method: "dialog" },
    h("h3", {}, "Keyboard shortcuts"),
    h("div", { class: "keys" }, ...rows.flatMap(([a, k]) => [h("span", {}, a), h("span", {}, ...k.split("  ").map(kbd))])),
    h("div", { class: "dialog-actions" }, h("button", { class: "btn primary", value: "ok" }, "Done"))));
  d.addEventListener("close", () => d.remove());
  document.body.append(d); d.showModal();
}
$("jump").addEventListener("click", () => openPalette());
document.addEventListener("keydown", (ev) => {
  const mod = ev.metaKey || ev.ctrlKey;
  if (mod && !ev.shiftKey && !ev.altKey && (ev.key === "k" || ev.key === "K")) { ev.preventDefault(); pal ? closePalette() : openPalette(); return; }
  if (pal || document.querySelector("dialog[open]")) return;
  const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName) || document.activeElement?.isContentEditable || document.activeElement?.closest?.(".xterm");
  if (mod && ev.key === "1") { ev.preventDefault(); newThread(); }
  else if (mod && ev.key === "2") { ev.preventDefault(); openTeams(); }
  else if (mod && ev.key === "\\") { ev.preventDefault(); toggleSidebar(); }
  else if (mod && ev.key === "[") { ev.preventDefault(); history.back(); }
  else if (mod && ev.key === "]") { ev.preventDefault(); history.forward(); }
  else if (ev.altKey && !mod && ev.code === "KeyN") { ev.preventDefault(); ev.shiftKey ? newProject(true) : newThread(); }
  else if (!typing && !mod && ev.key === "?") { ev.preventDefault(); openShortcuts(); }
  else if (!typing && !mod && ev.key === "/") { ev.preventDefault(); openPalette(); }
});
hydrateIcons();
if (sideHidden) document.querySelector(".app").classList.add("side-hidden");

