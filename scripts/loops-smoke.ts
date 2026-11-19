// Live test of agent loops: time budget + wrap-up, live activity on cards and @mention replies, spare agent copies
// when an agent is busy, and draining before a restart. Starts its own throwaway server (1-minute task budget).
//   node scripts/loops-smoke.ts
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";

const provider = process.argv[2] ?? "claude";
const model = process.argv[3];
const HOME = mkdtempSync(join(tmpdir(), "bullpen-loops-home-"));
const PORT = 4790 + Math.floor(Math.random() * 5);
process.env.BULLPEN_HOME = HOME;
const { readToken } = await import("../src/home.ts");

const repo = execFileSync("realpath", [mkdtempSync(join(tmpdir(), "bullpen-loops-repo-"))], { encoding: "utf8" }).trim();
const git = (...a: string[]) => execFileSync("git", ["-C", repo, ...a], { encoding: "utf8" }).trim();
git("init", "-q", "-b", "main");
git("config", "user.email", "t@t");
git("config", "user.name", "t");
writeFileSync(join(repo, "README.md"), "# test\n");
git("add", "-A");
git("commit", "-q", "-m", "init");

let server: ChildProcess | undefined;
async function startServer() {
  server = spawn("node", ["src/server.ts"], { env: { ...process.env, BULLPEN_HOME: HOME, BULLPEN_PORT: String(PORT), BULLPEN_TASK_BUDGET_MS: "30000", BULLPEN_WRAPUP_MS: "120000" }, stdio: ["ignore", "pipe", "pipe"] });
  server.stderr?.on("data", (d) => process.env.DEBUG && process.stderr.write(d));
  await new Promise<void>((r) => server!.stdout!.on("data", (d) => String(d).includes("listening") && r()));
}

let ws: WebSocket;
let id = 1;
const waiters = new Map<number, (r: { result?: unknown; error?: string }) => void>();
let onEvent: (e: { event: { type: string; [k: string]: unknown } }) => void = () => {};
async function connect() {
  ws = new WebSocket(`ws://127.0.0.1:${PORT}`, { headers: { authorization: `Bearer ${readToken()}` } });
  ws.on("message", (raw) => {
    const msg = JSON.parse(String(raw));
    if ("subscription" in msg) { for (const e of msg.items ?? []) onEvent(e); }
    else waiters.get(msg.id)?.(msg);
  });
  await new Promise((r) => ws.once("open", r));
}
async function call<T>(method: string, params?: unknown): Promise<T> {
  const myId = id++;
  ws.send(JSON.stringify({ id: myId, method, params }));
  const res = await new Promise<{ result?: unknown; error?: string }>((r) => waiters.set(myId, r));
  if (res.error) throw new Error(res.error);
  return res.result as T;
}
let pass = 0, fail = 0;
const check = (cond: unknown, label: string, info = "") => { cond ? pass++ : fail++; console.log(`${cond ? "✓" : "✗"} ${label}${info ? `  (${info})` : ""}`); };

type Thread = { id: string; status: string; worktree?: { path: string; branch: string }; runCount: number };
async function thread(threadId: string): Promise<Thread> {
  const list = await call<Thread[]>("listThreads");
  return list.find((t) => t.id === threadId)!;
}
/** Send and wait until the thread is idle again; returns the final assistant text. */
async function turn(threadId: string, text: string, timeout = 240_000): Promise<string> {
  let last = "";
  const done = new Promise<void>((resolve) => {
    let running = false;
    onEvent = ({ event: ev }) => {
      const item = ev.item as { kind?: string; text?: string; streaming?: boolean } | undefined;
      if (ev.type === "turn-item.upserted" && item?.kind === "assistant_message" && !item.streaming) last = item.text ?? "";
      const t = ev.thread as Thread | undefined;
      if (ev.type === "thread.upserted" && t) { if (t.status === "running") running = true; if (running && t.status === "idle") resolve(); }
    };
  });
  await call("dispatch", { type: "message.send", threadId, text });
  await Promise.race([done, new Promise((_, rej) => setTimeout(() => rej(new Error(`turn timed out: ${text.slice(0, 40)}`)), timeout))]);
  return last;
}

try {
  await startServer();
  await connect();
  const { AGENT_TEMPLATES } = await import("../src/agent-templates.ts");
  const lead = AGENT_TEMPLATES.find((t) => t.id === "lead")!;
  await call("dispatch", { type: "agent.create", name: lead.name, handle: "lead", templateId: "lead", instructions: lead.instructions, model: "claude-sonnet-5-5" });
  await call("dispatch", { type: "agent.create", name: "Writer", handle: "writer", description: "Does small file and shell chores exactly as asked", instructions: "Do exactly what the task asks, step by step.", model: "claude-haiku-5-5" });
  const { threadId } = await call<{ threadId: string }>("dispatch", { type: "thread.create", cwd: repo, provider: "claude", runtimeMode: "full-access", title: "Loops" });
  await call("subscribeThread", { threadId });
  await call("subscribeSidebar");

  let watchThread = threadId;
  let card: any; let sawTaskActivity = false; let sawLeadActivity = false; let sawWrapping = false; let sawNote = false; let mentionActivity = false;
  onEvent = ({ event: ev }) => {
    const item = ev.item as any;
    if (ev.type !== "turn-item.upserted") return;
    if (item.kind === "approval_request" && item.status === "pending") void call("dispatch", { type: "runtime-request.respond", threadId: item.threadId, requestId: item.requestId, decision: "accept" });
    if (item.kind === "team_goal" && item.threadId === watchThread) {
      card = item;
      if (item.lead?.activity) sawLeadActivity = true;
      for (const t of item.tasks) {
        if (t.activity?.steps) sawTaskActivity = true;
        if (t.activity?.note) sawNote = true;
        if (t.wrapping) sawWrapping = true;
      }
    }
    if (item.kind === "agent_reply" && item.status === "running" && item.activity) mentionActivity = true;
  };
  if (!process.env.ROUNDS_ONLY) await call("dispatch", {
    type: "message.send",
    threadId,
    text:
      "@lead Delegate exactly ONE task to @writer (review: skip): in its folder, run these shell commands one at a time in the foreground (not in the background), each as its own command, waiting for each: " +
      "`python3 -c \"import time; time.sleep(25)\" && echo 1 >> steps.txt`, then `python3 -c \"import time; time.sleep(25)\" && echo 2 >> steps.txt`, then `python3 -c \"import time; time.sleep(25)\" && echo 3 >> steps.txt`, then `python3 -c \"import time; time.sleep(25)\" && echo 4 >> steps.txt`, calling report_progress after each. " +
      "These 25-second waits are the point of the test, don't skip them. When it's accepted, finish the goal with a one-line report.",
  });
  // While writer is busy on its task, ask it something directly: a spare copy should answer without waiting.
  const deadline = Date.now() + 8 * 60_000;
  while (Date.now() < deadline && !card?.tasks?.some((t: any) => t.status === "working")) await new Promise((r) => setTimeout(r, 1000));
  const tStart = Date.now();
  await call("dispatch", { type: "message.send", threadId, text: "@writer reply with exactly the word BANANA and nothing else." });
  let answered = 0;
  while (Date.now() < deadline) {
    const snap = await call<any>("subscribeThread", { threadId });
    const r = snap.snapshot.turnItems.find((i: any) => i.kind === "agent_reply" && i.agentName === "writer" && i.status === "completed");
    if (r) { answered = Date.now() - tStart; break; }
    await new Promise((r) => setTimeout(r, 2000));
  }
  const taskStillWorking = card?.tasks?.some((t: any) => t.status === "working");
  check(answered > 0 && answered < 90_000, "busy agent answered a mention right away (spare copy)", `${Math.round(answered / 1000)}s, task still working: ${taskStillWorking}`);
  const threads = await call<any[]>("listThreads");
  check(threads.some((t) => t.cloneOf), "a spare copy of the agent was used");
  while (Date.now() < deadline && !["done", "failed", "cancelled", "stuck"].includes(card?.status)) await new Promise((r) => setTimeout(r, 2000));
  const t1 = card?.tasks?.[0];
  console.log("   task:", t1?.status, t1?.startedAt, t1?.endedAt, "attempts?", JSON.stringify(t1?.summary ?? "").slice(0, 300));
  check(sawLeadActivity, "lead's live activity showed on the card");
  check(sawTaskActivity, "task's live activity (steps, current step) showed on the card");
  check(mentionActivity || answered < 15_000, "mention reply showed live activity while working");
  check(sawWrapping, "task hit its budget and wrapped up instead of being killed");
  check(t1?.partial && ["accepted", "submitted"].includes(t1?.status), "wrapped-up task was submitted as partial, not parked", `${t1?.status} partial=${t1?.partial}`);
  console.log(`${sawNote ? "✓" : "·"} report_progress note showed on the card (timing-dependent with a 30s budget)`);
  check(card?.status === "done", "goal finished", card?.status);

  // Drain: nothing new starts; your messages get a clear "restarting" answer.
  await call("drain", { on: true });
  const sent = await new Promise<any>((res) => { const i = 9999; waiters.set(i, res); ws.send(JSON.stringify({ id: i, method: "dispatch", params: { type: "message.send", threadId, text: "hello" } })); });
  check(/restarting/i.test(sent.error ?? ""), "while draining, new messages are refused with a clear reason", sent.error);
  await call("drain", { on: false });

  // Improvement rounds: an open-ended goal runs in rounds until its criteria are met.
  writeFileSync(join(repo, "count.txt"), "1\n");
  git("add", "-A"); git("commit", "-q", "-m", "count");
  const { threadId: t2 } = await call<{ threadId: string }>("dispatch", { type: "thread.create", cwd: repo, provider: "claude", runtimeMode: "full-access", title: "Rounds" });
  await call("subscribeThread", { threadId: t2 });
  card = undefined;
  watchThread = t2;
  await call("dispatch", {
    type: "message.send",
    threadId: t2,
    text:
      "@lead Keep improving count.txt until it contains the number 3. This is open-ended: call set_goal_criteria (criteria: count.txt contains 3; rounds: 4). " +
      "Each round, delegate ONE task to @writer (review: skip) that adds 1 to the number in count.txt. Use next_round between rounds.",
  });
  const d2 = Date.now() + 10 * 60_000;
  while (Date.now() < d2 && !["done", "failed", "cancelled", "stuck"].includes(card?.status)) await new Promise((r) => setTimeout(r, 2000));
  const snap2 = await call<any>("subscribeThread", { threadId: t2 });
  for (const i of snap2.snapshot.turnItems) if (i.kind === "agent_reply" || i.kind === "team_goal") console.log("   ", i.kind, i.kind === "team_goal" ? JSON.stringify({ status: i.status, rounds: i.rounds, tasks: i.tasks.map((t: any) => t.status) }) : (i.text ?? "").slice(0, 300));
  check(card?.rounds && card.rounds.reports.length >= 1, "goal ran in rounds with a report per round", `round ${card?.rounds?.round}, reports ${card?.rounds?.reports?.length}`);
  check(card?.status === "done" && readFileSync(join(repo, "count.txt"), "utf8").includes("3"), "rounds stopped once the criteria were met", `${card?.status}, count.txt=${readFileSync(join(repo, "count.txt"), "utf8").trim()}`);
} catch (err) {
  fail++;
  console.log("✗ error:", (err as Error).message);
} finally {
  server?.kill("SIGTERM");
  await new Promise((r) => setTimeout(r, 500));
  rmSync(repo, { recursive: true, force: true });
  rmSync(HOME, { recursive: true, force: true });
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
