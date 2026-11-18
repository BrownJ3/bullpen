// End-to-end smoke test against a running server.
//   BULLPEN_HOME=... BULLPEN_PORT=... node scripts/smoke.ts <git-repo-dir> [claude|codex] [model]
// Creates a thread, asks the agent to write a file, auto-approves, checks the checkpoint
// diff, rolls back, and verifies the file is gone. Costs one short Claude turn.

import { existsSync } from "node:fs";
import { join } from "node:path";
import { WebSocket } from "ws";
import { readToken } from "../src/home.ts";
import { DEFAULT_PORT, type Push, type Response } from "../src/protocol.ts";
import type { StoredEvent } from "../src/types.ts";

const repo = process.argv[2];
const provider = process.argv[3] ?? "claude";
const model = process.argv[4];
if (!repo) throw new Error("usage: smoke.ts <git-repo-dir>");
const PORT = Number(process.env.BULLPEN_PORT ?? DEFAULT_PORT);

const ws = new WebSocket(`ws://127.0.0.1:${PORT}`, { headers: { authorization: `Bearer ${readToken()}` } });
let id = 1;
const waiters = new Map<number, (r: Response) => void>();
const seen: StoredEvent[] = [];
let onEvent: (e: StoredEvent) => void = () => {};

ws.on("message", (raw) => {
  const msg = JSON.parse(String(raw)) as Response | Push;
  if ("subscription" in msg) {
    if (!("items" in msg)) return;
    for (const e of msg.items) {
      seen.push(e);
      onEvent(e);
    }
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

await new Promise((r) => ws.once("open", r));

const { threadId } = await call<{ threadId: string }>("dispatch", {
  type: "thread.create",
  cwd: repo,
  provider,
  model,
  runtimeMode: "approval-required",
});
await call("subscribeThread", { threadId });

const finished = new Promise<void>((resolve) => {
  let sawRunning = false;
  onEvent = (e) => {
    const ev = e.event;
    if (ev.type === "turn-item.upserted" && ev.item.kind === "approval_request" && ev.item.status === "pending") {
      console.log(`      approving ${ev.item.tool}`);
      void call("dispatch", { type: "runtime-request.respond", threadId, requestId: ev.item.requestId, decision: "accept" });
    }
    if (ev.type === "thread.upserted") {
      if (ev.thread.status === "running") sawRunning = true;
      if (sawRunning && ev.thread.status === "idle") resolve();
    }
  };
});

await call("dispatch", {
  type: "message.send",
  threadId,
  text: "Create a file named hello.txt in the current directory containing exactly the word: hi. Do nothing else.",
});
await Promise.race([finished, new Promise((_, rej) => setTimeout(() => rej(new Error("turn timed out")), 180_000))]);

const kinds = new Set(seen.flatMap((e) => (e.event.type === "turn-item.upserted" ? [e.event.item.kind] : [])));
const run = seen.findLast((e) => e.event.type === "run.upserted")?.event;
check(run?.type === "run.upserted" && run.run.status === "completed", `run completed (${run?.type === "run.upserted" ? run.run.status : "?"})`);
check(kinds.has("approval_request"), "approval round-trip happened");
check(kinds.has("tool_call"), "tool_call items recorded");
check(kinds.has("assistant_message"), "assistant message recorded");
check(kinds.has("checkpoint"), "checkpoint item recorded");
check(existsSync(join(repo, "hello.txt")), "agent wrote hello.txt");
check(seen.some((e) => e.event.type === "thread.upserted" && e.event.thread.nativeSessionId), "native session id captured");

const diff = await call<string>("getDiff", { threadId, fromOrdinal: 0, toOrdinal: 1 });
check(diff.includes("hello.txt"), "checkpoint diff 0→1 shows hello.txt");

await call("dispatch", { type: "checkpoint.rollback", threadId, ordinal: 0 });
check(!existsSync(join(repo, "hello.txt")), "rollback to 0 removed hello.txt");
check(existsSync(join(repo, "README.md")), "rollback kept pre-existing files");

ws.close();
