// Live test of worktree threads, conversation rewind and resume-after-restart. Starts its own throwaway server.
//   node scripts/branch-smoke.ts [claude|codex] [model]      (a few short agent turns)
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";

const provider = process.argv[2] ?? "claude";
const model = process.argv[3];
const HOME = mkdtempSync(join(tmpdir(), "bullpen-branch-home-"));
const PORT = 4790 + Math.floor(Math.random() * 5);
process.env.BULLPEN_HOME = HOME;
const { readToken } = await import("../src/home.ts");

const repo = execFileSync("realpath", [mkdtempSync(join(tmpdir(), "bullpen-branch-repo-"))], { encoding: "utf8" }).trim();
const git = (...a: string[]) => execFileSync("git", ["-C", repo, ...a], { encoding: "utf8" }).trim();
git("init", "-q", "-b", "main");
git("config", "user.email", "t@t");
git("config", "user.name", "t");
writeFileSync(join(repo, "README.md"), "# test\n");
git("add", "-A");
git("commit", "-q", "-m", "init");

let server: ChildProcess | undefined;
async function startServer() {
  server = spawn("node", ["src/server.ts"], { env: { ...process.env, BULLPEN_HOME: HOME, BULLPEN_PORT: String(PORT) }, stdio: ["ignore", "pipe", "pipe"] });
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

  const { threadId } = await call<{ threadId: string }>("dispatch", { type: "thread.create", cwd: repo, provider, model, runtimeMode: "full-access", title: "Notes", worktree: {} });
  let t = await thread(threadId);
  check(t.worktree && existsSync(t.worktree.path), "thread got its own worktree", t.worktree?.branch);
  const wtPath = t.worktree!.path;
  await call("subscribeThread", { threadId });

  const a1 = await turn(threadId, "Create a file notes.txt in the current directory containing exactly the line: apple. Do nothing else. Reply in one word.");
  check(existsSync(join(wtPath, "notes.txt")), "turn 1 wrote in the worktree", a1.slice(0, 200));
  if (!existsSync(join(wtPath, "notes.txt"))) {
    const runs = (await call<{ snapshot?: { runs: unknown[]; turnItems: unknown[] } }>("subscribeThread", { threadId })).snapshot;
    console.log(JSON.stringify(runs, null, 1).slice(0, 3000));
    throw new Error("stopping");
  }
  check(!existsSync(join(repo, "notes.txt")), "your checkout untouched");

  await turn(threadId, "Remember this secret word: BANANA. Also add a second line 'banana' to notes.txt. Reply in one word.");
  check(readFileSync(join(wtPath, "notes.txt"), "utf8").includes("banana"), "turn 2 edited the file");

  const rb = await call<{ conversation: string }>("dispatch", { type: "checkpoint.rollback", threadId, ordinal: 1 });
  check(rb.conversation === "rewound", "rollback rewound the conversation", rb.conversation);
  check(readFileSync(join(wtPath, "notes.txt"), "utf8").trim() === "apple", "rollback restored the file");
  const answer = await turn(threadId, "Did I tell you a secret word in this conversation? If yes, say it. If not, reply exactly NONE.");
  check(!/banana/i.test(answer), "agent forgot the undone turn", answer.slice(0, 80));

  const st = await call<{ changed: number }>("worktreeStatus", { threadId });
  check(st.changed >= 1, "status counts changes", JSON.stringify(st).slice(0, 120));
  await call("dispatch", { type: "worktree.merge", threadId });
  check(existsSync(join(repo, "notes.txt")) && git("log", "--oneline").split("\n").length >= 2, "merged into main");

  // Restart in the middle of a turn: it should be picked back up.
  const runsBefore = (await thread(threadId)).runCount;
  let sawTool = false;
  const started = new Promise<void>((resolve) => {
    onEvent = ({ event: ev }) => { const item = ev.item as { kind?: string } | undefined; if (ev.type === "turn-item.upserted" && item?.kind === "tool_call") { sawTool = true; resolve(); } };
  });
  await call("dispatch", { type: "message.send", threadId, text: "Run the shell command `sleep 25` first. After it finishes, create done.txt containing ok. Reply in one word." });
  await Promise.race([started, new Promise((r) => setTimeout(r, 90_000))]);
  check(sawTool, "turn under way before restart");
  server!.kill("SIGKILL");
  ws.close();
  await new Promise((r) => setTimeout(r, 500));
  await startServer();
  await connect();
  await call("subscribeThread", { threadId });
  const deadline = Date.now() + 240_000;
  while (Date.now() < deadline && !existsSync(join(wtPath, "done.txt"))) await new Promise((r) => setTimeout(r, 2000));
  while (Date.now() < deadline && (await thread(threadId)).status !== "idle") await new Promise((r) => setTimeout(r, 1000));
  t = await thread(threadId);
  check(existsSync(join(wtPath, "done.txt")), "interrupted turn was resumed and finished", `runs ${runsBefore} → ${t.runCount}`);

  await call("dispatch", { type: "worktree.remove", threadId, deleteBranch: false });
  check(!existsSync(wtPath), "worktree removed");
} catch (err) {
  fail++;
  console.log("✗ error:", (err as Error).message);
} finally {
  server?.kill("SIGTERM");
  await new Promise((r) => setTimeout(r, 300));
  try { execFileSync("git", ["-C", repo, "worktree", "prune"]); } catch {}
  rmSync(repo, { recursive: true, force: true });
  rmSync(HOME, { recursive: true, force: true });
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
