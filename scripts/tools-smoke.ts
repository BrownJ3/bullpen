// Live test of the harness tools agents get: the real browser, starting and following threads, proposing a PR.
//   node scripts/tools-smoke.ts [claude|codex] [model]      (a few short agent turns)
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";

const provider = process.argv[2] ?? "claude";
const model = process.argv[3];
const HOME = mkdtempSync(join(tmpdir(), "bullpen-tools-home-"));
const PORT = 4790 + Math.floor(Math.random() * 5);
process.env.BULLPEN_HOME = HOME;
const { readToken } = await import("../src/home.ts");

const repo = execFileSync("realpath", [mkdtempSync(join(tmpdir(), "bullpen-tools-repo-"))], { encoding: "utf8" }).trim();
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
  const { threadId } = await call<{ threadId: string }>("dispatch", { type: "thread.create", cwd: repo, provider, model, runtimeMode: "full-access", title: "Tools", worktree: {} });
  await call("subscribeThread", { threadId });
  const tools: string[] = [];
  const collect = onEvent;
  const a1 = await turn(threadId, "Use your browser_open tool to open https://example.com, then browser_snapshot. Reply with only the page's main heading text.");
  check(/example domain/i.test(a1), "agent read a public page with its browser", a1.slice(0, 80));
  const frame = await call<{ url: string } | null>("browser.frame", { threadId });
  check(frame?.url.includes("example.com"), "the Browser panel sees the same tab", frame?.url);

  const a2 = await turn(threadId,
    "Use start_thread to start a thread (branch: no) with this prompt: 'Reply with exactly the word PONG and do nothing else.' Then wait_for_thread on it and reply with only what it answered.");
  check(/PONG/.test(a2), "agent started a thread and waited for its answer", a2.slice(0, 80));
  const list = await call<Array<{ id: string; startedBy?: { threadId: string } }>>("listThreads");
  check(list.some((t) => t.startedBy?.threadId === threadId), "started thread records who started it");

  writeFileSync(join((await thread(threadId)).worktree!.path, "x.txt"), "x\n");
  const a3 = await turn(threadId, "Call propose_pull_request with title 'Add x' and body 'Adds x.txt'. Reply in one word.");
  const snap = await call<{ snapshot: { turnItems: Array<{ kind: string; action?: { kind: string } }> } }>("subscribeThread", { threadId });
  check(snap.snapshot.turnItems.some((i) => i.kind === "note" && i.action?.kind === "open_pr"), "PR proposal shows as a button for you", a3.slice(0, 40));
  void collect; void tools;
} catch (err) {
  fail++;
  console.log("✗ error:", (err as Error).message);
} finally {
  await call("browser.close", { threadId: "x" }).catch(() => {});
  server?.kill("SIGTERM");
  await new Promise((r) => setTimeout(r, 500));
  try { execFileSync("git", ["-C", repo, "worktree", "prune"]); } catch {}
  rmSync(repo, { recursive: true, force: true });
  rmSync(HOME, { recursive: true, force: true });
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
