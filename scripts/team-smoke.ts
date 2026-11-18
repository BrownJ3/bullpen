// End-to-end test of team goals against a running server (use a throwaway BULLPEN_HOME).
//   BULLPEN_HOME=... BULLPEN_PORT=... node scripts/team-smoke.ts <empty-git-repo>
// Recruits a Project Lead and three small specialists, @mentions the lead with a goal that needs two
// parallel tasks and a dependent check, auto-approves anything that asks, and checks the whole flow:
// delegation, parallel work, dependency ordering, review, report, team card and sidebar status.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { WebSocket } from "ws";
import { AGENT_TEMPLATES } from "../src/agent-templates.ts";
import { readToken } from "../src/home.ts";
import { DEFAULT_PORT, type Push, type Response } from "../src/protocol.ts";
import type { StoredEvent, Thread, TurnItem } from "../src/types.ts";

const repo = process.argv[2];
if (!repo) throw new Error("usage: team-smoke.ts <empty-git-repo>");
const PORT = Number(process.env.BULLPEN_PORT ?? DEFAULT_PORT);
const ws = new WebSocket(`ws://127.0.0.1:${PORT}`, { headers: { authorization: `Bearer ${readToken()}` } });
let id = 1;
const waiters = new Map<number, (r: Response) => void>();
const listeners = new Set<(e: StoredEvent) => void>();
ws.on("message", (raw) => {
  const msg = JSON.parse(String(raw)) as Response | Push;
  if ("subscription" in msg) {
    if ("items" in msg) for (const e of msg.items) for (const l of listeners) l(e);
  } else waiters.get(msg.id)?.(msg);
});
async function call<T>(method: string, params?: unknown): Promise<T> {
  const myId = id++;
  ws.send(JSON.stringify({ id: myId, method, params }));
  const res = await new Promise<Response>((r) => waiters.set(myId, r));
  if ("error" in res) throw new Error(res.error);
  return res.result as T;
}
function check(cond: unknown, label: string) {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}`);
  if (!cond) process.exitCode = 1;
}

const approved = new Set<string>();
let approvals = 0;
let editPrompts = 0;
listeners.add((e) => {
  if (e.event.type === "turn-item.upserted" && e.event.item.kind === "approval_request" && e.event.item.status === "pending") {
    const { threadId, requestId, tool, input } = e.event.item;
    if (approved.has(requestId)) return;
    approved.add(requestId);
    approvals++;
    if (["Write", "Edit", "MultiEdit", "apply_patch"].includes(tool)) editPrompts++;
    console.log(`      approving ${tool} ${JSON.stringify(input).slice(0, 100)}`);
    void call("dispatch", { type: "runtime-request.respond", threadId, requestId, decision: "accept" }).catch(() => {});
  }
});
let card: Extract<TurnItem, { kind: "team_goal" }> | undefined;
const replies: Array<Extract<TurnItem, { kind: "agent_reply" }>> = [];
let lastStatus = "";
listeners.add((e) => {
  if (e.event.type !== "turn-item.upserted") return;
  const item = e.event.item;
  if (item.kind === "team_goal") {
    card = item;
    const line = `${item.status}: ${item.tasks.map((t) => `${t.ref}@${t.agentName}=${t.status}`).join(" ")}`;
    if (line !== lastStatus) console.log(`      ${line}`);
    lastStatus = line;
  }
  if (item.kind === "agent_reply" && item.status !== "running") {
    const i = replies.findIndex((r) => r.id === item.id);
    if (i >= 0) replies[i] = item;
    else replies.push(item);
  }
});

await new Promise((r) => ws.once("open", r));
await call("subscribeSidebar");

const lead = AGENT_TEMPLATES.find((t) => t.id === "lead")!;
const writer = (name: string) => ({
  type: "agent.create",
  name,
  description: "Writes small files exactly as asked",
  instructions: "You create or edit exactly the files you're asked to, with exactly the content asked for, then report what you did. Be brief.",
  runtimeMode: "approval-required",
});
await call("dispatch", { type: "agent.create", name: lead.name, handle: lead.handle, templateId: lead.id, description: lead.description, instructions: lead.instructions, runtimeMode: lead.runtimeMode });
await call("dispatch", writer("Writer A"));
await call("dispatch", writer("Writer B"));
await call("dispatch", {
  type: "agent.create",
  name: "Checker",
  description: "Verifies files have the expected contents",
  instructions: "You verify files by reading them and report exactly what each contains and whether it matches. Never edit files.",
  runtimeMode: "approval-required",
});

const { threadId } = await call<{ threadId: string }>("dispatch", { type: "thread.create", cwd: repo });
await call("subscribeThread", { threadId });
const started = Date.now();
await call("dispatch", {
  type: "message.send",
  threadId,
  text:
    "@lead Run this as a small team exercise. Create two files in this project in parallel: a.txt containing exactly the word alpha " +
    "(assign it to @writer-a) and b.txt containing exactly the word beta (assign it to @writer-b). Then have @checker verify both files' " +
    "contents, as a task that depends on the other two. Accept good work and finish with a short report.",
});

const deadline = Date.now() + 12 * 60_000;
while (Date.now() < deadline && !(card && ["done", "failed", "cancelled", "stuck"].includes(card.status))) {
  await new Promise((r) => setTimeout(r, 2000));
}
const secs = Math.round((Date.now() - started) / 1000);
console.log(`      finished in ${secs}s with ${approvals} approval prompt(s)`);

check(card, "a team card appeared in the thread");
check(card?.status === "done", `goal finished (${card?.status}${card?.note ? `: ${card.note}` : ""})`);
const tasks = card?.tasks ?? [];
check(tasks.length >= 3, `lead delegated ${tasks.length} tasks`);
check(tasks.length > 0 && tasks.every((t) => t.status === "accepted"), "every task accepted");
const a = tasks.find((t) => /a\.txt/i.test(t.title + (t.summary ?? "")) && t.agentName === "Writer A");
const b = tasks.find((t) => /b\.txt/i.test(t.title + (t.summary ?? "")) && t.agentName === "Writer B");
const c = tasks.find((t) => t.agentName === "Checker");
check(a && b, "writer tasks went to @writer-a and @writer-b");
check(c && c.dependsOn.length >= 2, `checker task depends on the writers (${c?.dependsOn.join(", ")})`);
check(
  a?.startedAt && b?.startedAt && a.endedAt && b.endedAt && a.startedAt < b.endedAt && b.startedAt < a.endedAt,
  "writer tasks ran in parallel (their time ranges overlap)",
);
check(c?.startedAt && a?.endedAt && b?.endedAt && c.startedAt >= a.endedAt && c.startedAt >= b.endedAt, "checker started only after both were accepted");
check(readFileSync(join(repo, "a.txt"), "utf8").trim() === "alpha" && readFileSync(join(repo, "b.txt"), "utf8").trim() === "beta", "files have the right contents");
check(a?.filesTouched?.some((f) => f.endsWith("a.txt")), `files touched recorded (${a?.filesTouched?.join(", ")})`);
check(editPrompts === 0, "team mode: no approval prompts for file edits inside the project");
check(approvals === 0, `team mode: no approval prompts at all (${approvals})`);
const report = replies.find((r) => r.id.startsWith("report:"));
check(report && report.text.length > 20, "lead posted a final report in the thread");
check(replies.some((r) => !r.id.startsWith("report:") && r.text.length > 10), "lead posted its plan in the thread");
const threads = await call<Thread[]>("listThreads");
check(threads.find((t) => t.id === threadId)?.team?.active === 0, "sidebar shows no active team once done");
check(!existsSync(join(repo, "c.txt")), "nobody created files they weren't asked to");

// ---- Scenario 2: one-round review. The lead sends a task back once; the rework is accepted. ----
console.log("\n-- send-back scenario --");
card = undefined;
lastStatus = "";
await call("dispatch", {
  type: "message.send",
  threadId,
  text:
    "@lead New goal: have @writer-a create c.txt containing exactly the word gamma. When it's submitted, send it back once " +
    "with the note 'Use capitals: the file must contain exactly GAMMA', then accept the rework and finish.",
});
const d2 = Date.now() + 8 * 60_000;
while (Date.now() < d2 && !(card && ["done", "failed", "cancelled", "stuck"].includes(card.status))) await new Promise((r) => setTimeout(r, 2000));
const c2 = card?.tasks[0];
check(card?.status === "done", `send-back goal finished (${card?.status})`);
check(c2?.round === 1 && c2?.status === "accepted", `task was sent back once, then accepted (round ${c2?.round}, ${c2?.status})`);
check(c2?.reviewNotes?.includes("GAMMA"), "review notes reached the task");
check(existsSync(join(repo, "c.txt")) && readFileSync(join(repo, "c.txt"), "utf8").trim() === "GAMMA", "rework applied (c.txt is GAMMA)");

// ---- Scenario 3: stop a team mid-way. ----
console.log("\n-- stop scenario --");
card = undefined;
lastStatus = "";
await call("dispatch", {
  type: "message.send",
  threadId,
  text: "@lead New goal: have @writer-b write d.txt with 200 lines numbered 1 to 200, then have @checker verify it (depends on the first).",
});
const d3 = Date.now() + 4 * 60_000;
while (Date.now() < d3 && !(card && card.tasks.some((t) => t.status === "working"))) await new Promise((r) => setTimeout(r, 500));
check(card?.tasks.some((t) => t.status === "working"), "a task started");
await call("dispatch", { type: "goal.cancel", goalId: card!.goalId });
await new Promise((r) => setTimeout(r, 4000));
check(card?.status === "cancelled", `goal stopped (${card?.status})`);
check(card?.tasks.every((t) => t.status === "cancelled"), `all tasks cancelled (${card?.tasks.map((t) => t.status).join(", ")})`);
const after = await call<Thread[]>("listThreads");
check(after.find((t) => t.id === threadId)?.team?.active === 0, "sidebar shows no active team after stopping");
ws.close();
