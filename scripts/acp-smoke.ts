// Test of the ACP engine adapter and the MCP tool endpoint, with a mock ACP agent (no model calls).
//   node scripts/acp-smoke.ts
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";

const provider = process.argv[2] ?? "claude";
const model = process.argv[3];
const HOME = mkdtempSync(join(tmpdir(), "bullpen-acp-home-"));
const PORT = 4790 + Math.floor(Math.random() * 5);
process.env.BULLPEN_HOME = HOME;
const { readToken } = await import("../src/home.ts");
writeFileSync(join(HOME, "engines.json"), JSON.stringify([{ id: "mock", name: "Mock ACP", command: "node", args: [fileURLToPath(new URL("./mock-acp-agent.mjs", import.meta.url))] }]));

const repo = realpathSync.native(mkdtempSync(join(tmpdir(), "bullpen-acp-repo-")));
const git = (...a: string[]) => execFileSync("git", ["-C", repo, ...a], { encoding: "utf8" }).trim();
git("init", "-q", "-b", "main");
git("config", "user.email", "t@t");
git("config", "user.name", "t");
writeFileSync(join(repo, "README.md"), "# test\n");
git("add", "-A");
git("commit", "-q", "-m", "init");

let server: ChildProcess | undefined;
async function startServer() {
  server = spawn(process.execPath, ["src/server.ts"], { env: { ...process.env, BULLPEN_HOME: HOME, BULLPEN_PORT: String(PORT) }, stdio: ["ignore", "pipe", "pipe"] });
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
  const engines = await call<Array<{ id: string }>>("listEngines");
  check(engines.some((e) => e.id === "mock"), "custom ACP engine is offered", engines.map((e) => e.id).join(","));
  const { threadId } = await call<{ threadId: string }>("dispatch", { type: "thread.create", cwd: repo, provider: "mock", runtimeMode: "approval-required", title: "ACP" });
  await call("subscribeThread", { threadId });
  let asked = 0;
  let last = "";
  const done = new Promise<void>((resolve) => {
    let running = false;
    onEvent = ({ event: ev }) => {
      const item = ev.item as { kind?: string; status?: string; requestId?: string; text?: string; streaming?: boolean } | undefined;
      if (ev.type === "turn-item.upserted" && item?.kind === "approval_request" && item.status === "pending") {
        asked++;
        void call("dispatch", { type: "runtime-request.respond", threadId, requestId: item.requestId, decision: "accept" });
      }
      if (ev.type === "turn-item.upserted" && item?.kind === "assistant_message" && !item.streaming) last = item.text ?? "";
      const t = ev.thread as Thread | undefined;
      if (ev.type === "thread.upserted" && t) { if (t.status === "running") running = true; if (running && t.status === "idle") resolve(); }
    };
  });
  await call("dispatch", { type: "message.send", threadId, text: "write hello" });
  await Promise.race([done, new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), 20_000))]);
  check(asked === 1, "approval prompt reached you", String(asked));
  check(existsSync(join(repo, "hello.txt")), "file written through the client fs");
  check(/MCP tools: [1-9]/.test(last), "agent got Bullpen's tools over MCP", last.slice(0, 120));
  check(/no other agents|\(no other/.test(last), "MCP tool call worked", last.slice(-60));
  rmSync(join(repo, "hello.txt"));
  const { threadId: t2 } = await call<{ threadId: string }>("dispatch", { type: "thread.create", cwd: repo, provider: "mock", runtimeMode: "full-access", title: "ACP 2" });
  await call("subscribeThread", { threadId: t2 });
  asked = 0;
  await turn(t2, "write hello");
  check(asked === 0 && existsSync(join(repo, "hello.txt")), "full access: no prompt");
  const bad = await fetch(`http://127.0.0.1:${PORT}/mcp/${"0".repeat(48)}`, { method: "POST", body: "{}" });
  check(bad.status === 404, "unknown MCP session refused", String(bad.status));
} catch (err) {
  fail++;
  console.log("✗ error:", (err as Error).message);
} finally {
  server?.kill("SIGTERM");
  await new Promise((r) => setTimeout(r, 300));
  rmSync(repo, { recursive: true, force: true });
  rmSync(HOME, { recursive: true, force: true });
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
