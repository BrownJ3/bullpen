// Terminal client. Keeps a local projection of one thread (T3: client-runtime reducers)
// and renders turn items as they upsert.
//
//   npm run client -- ui            (open the web UI)
//   npm run client -- list
//   npm run client -- chat [--cwd DIR] [--provider claude|codex] [--model M] [--mode approval-required|auto-accept-edits|full-access]
//   npm run client -- chat <threadId>
//
// In chat:  /interrupt  /diff [from] [to]  /rollback <n>  /quit

import { createInterface } from "node:readline/promises";
import { WebSocket } from "ws";
import { readToken } from "./home.ts";
import { DEFAULT_PORT, type Push, type Request, type Response, type SubscribeResult } from "./protocol.ts";
import type { Decision, RuntimeMode, StoredEvent, Thread, TurnItem } from "./types.ts";

const PORT = Number(process.env.BULLPEN_PORT ?? DEFAULT_PORT);
const c = {
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
  cyan: (s: string) => `\x1b[36m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
};

// ---------- RPC ----------

const ws = new WebSocket(`ws://127.0.0.1:${PORT}`, { headers: { authorization: `Bearer ${readToken()}` } });
let nextId = 1;
const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
let onPush: (items: StoredEvent[]) => void = () => {};

ws.on("message", (raw) => {
  const msg = JSON.parse(String(raw)) as Response | Push;
  if ("subscription" in msg) return "items" in msg ? onPush(msg.items) : undefined;
  const p = pending.get(msg.id);
  if (!p) return;
  pending.delete(msg.id);
  if ("error" in msg) p.reject(new Error(msg.error));
  else p.resolve(msg.result);
});
ws.on("close", () => {
  console.log(c.dim("\n[disconnected]"));
  process.exit(0);
});

function call<T>(method: Request["method"], params?: unknown): Promise<T> {
  const id = nextId++;
  ws.send(JSON.stringify({ id, method, params }));
  return new Promise<T>((resolve, reject) => pending.set(id, { resolve: resolve as (v: unknown) => void, reject }));
}

// ---------- rendering ----------

const items = new Map<string, TurnItem>();
const printed = new Map<string, number>(); // streamed chars already written, per item
let thread: Thread | undefined;
let lastSequence = 0;
let streamingId: string | undefined;
const approvals: Extract<TurnItem, { kind: "approval_request" }>[] = [];

function out(s: string) {
  if (streamingId) {
    process.stdout.write("\n");
    streamingId = undefined;
  }
  console.log(s);
}

function summarize(input: unknown): string {
  const s = typeof input === "string" ? input : JSON.stringify(input);
  return s.length > 160 ? `${s.slice(0, 160)}…` : s;
}

function render(item: TurnItem, prev: TurnItem | undefined) {
  switch (item.kind) {
    case "user_message":
      if (!prev) out(`\n${c.bold("you ›")} ${item.text}`);
      return;
    case "assistant_message": {
      const done = printed.get(item.id) ?? 0;
      if (item.text.length > done) {
        if (streamingId !== item.id) {
          if (streamingId) process.stdout.write("\n");
          process.stdout.write(`${c.cyan("agent ›")} `);
          streamingId = item.id;
        }
        process.stdout.write(item.text.slice(done));
        printed.set(item.id, item.text.length);
      }
      if (!item.streaming && streamingId === item.id) {
        process.stdout.write("\n");
        streamingId = undefined;
      }
      return;
    }
    case "reasoning":
      if (!item.streaming && (!prev || (prev.kind === "reasoning" && prev.streaming))) {
        out(c.dim(`  (thinking: ${summarize(item.text)})`));
      }
      return;
    case "tool_call":
      if (!prev) out(c.yellow(`  ⚙ ${item.tool} ${c.dim(summarize(item.input))}`));
      else if (item.status !== "running" && prev.kind === "tool_call" && prev.status === "running") {
        const mark = item.status === "completed" ? c.green("✓") : c.red("✗");
        out(`  ${mark} ${item.tool} ${c.dim(summarize(item.output ?? ""))}`);
      }
      return;
    case "approval_request":
      if (item.status === "pending" && !prev) {
        approvals.push(item);
        out(c.yellow(`\n  ⚠ approve ${c.bold(item.tool)}? ${summarize(item.input)}`));
        out(c.yellow("    [a]llow  allow for [s]ession  [d]eny  [c]ancel turn"));
      } else if (item.status === "resolved") {
        const i = approvals.findIndex((a) => a.requestId === item.requestId);
        if (i >= 0) approvals.splice(i, 1);
      }
      return;
    case "checkpoint":
      out(c.dim(`  ◆ checkpoint ${item.ordinal} — ${item.filesChanged} file(s) changed  (/diff ${item.ordinal - 1} ${item.ordinal})`));
      return;
    case "agent_reply":
      if (item.status !== "running") out(`${c.green(`@${item.agentName} ›`)} ${item.status === "failed" ? c.red(item.text) : item.text}`);
      else if (!prev) out(c.dim(`  … asking @${item.agentName}`));
      return;
    case "error":
      out(c.red(`  ✗ ${item.message}`));
      return;
  }
}

function apply(stored: StoredEvent) {
  if (stored.sequence <= lastSequence) return;
  lastSequence = stored.sequence;
  const e = stored.event;
  if (e.type === "turn-item.upserted") {
    const prev = items.get(e.item.id);
    items.set(e.item.id, e.item);
    render(e.item, prev);
  } else if (e.type === "thread.upserted") {
    const wasRunning = thread?.status === "running";
    thread = e.thread;
    if (wasRunning && thread.status === "idle") out(c.dim("  — turn finished —"));
  } else if (e.type === "run.upserted" && e.run.status !== "running") {
    if (e.run.costUsd !== undefined) out(c.dim(`  ${e.run.status} · $${e.run.costUsd.toFixed(4)}`));
  }
}

// ---------- commands ----------

async function chat(threadId: string) {
  const sub = await call<SubscribeResult>("subscribeThread", { threadId });
  onPush = (batch) => batch.forEach(apply);
  if (sub.mode === "snapshot") {
    thread = sub.snapshot.thread;
    for (const item of sub.snapshot.turnItems) {
      items.set(item.id, item);
      if (item.kind === "assistant_message") printed.set(item.id, item.text.length);
    }
    lastSequence = sub.snapshot.sequence;
    console.log(c.dim(`thread ${threadId}\ncwd ${thread.cwd} · mode ${thread.runtimeMode} · ${thread.runCount} turn(s)`));
    for (const item of sub.snapshot.turnItems) {
      if (item.kind === "user_message") console.log(`${c.bold("you ›")} ${item.text}`);
      if (item.kind === "assistant_message") console.log(`${c.cyan("agent ›")} ${item.text}`);
    }
  }
  console.log(c.dim("commands: /interrupt  /diff [from] [to]  /rollback <n>  /quit\n"));

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  rl.on("close", () => process.exit(0));
  for await (const line of rl) {
    const text = line.trim();
    if (!text) continue;
    try {
      if (approvals.length && /^[asdc]$/i.test(text)) {
        const map: Record<string, Decision> = { a: "accept", s: "acceptForSession", d: "decline", c: "cancel" };
        const req = approvals[0];
        await call("dispatch", {
          type: "runtime-request.respond",
          threadId,
          requestId: req.requestId,
          decision: map[text.toLowerCase()],
        });
      } else if (text === "/quit") {
        process.exit(0);
      } else if (text === "/interrupt") {
        await call("dispatch", { type: "run.interrupt", threadId });
      } else if (text.startsWith("/diff")) {
        const [, a, b] = text.split(/\s+/);
        const to = b !== undefined ? Number(b) : (thread?.runCount ?? 1);
        const from = a !== undefined ? Number(a) : to - 1;
        console.log(await call<string>("getDiff", { threadId, fromOrdinal: from, toOrdinal: to }) || c.dim("(no changes)"));
      } else if (text.startsWith("/rollback")) {
        const n = Number(text.split(/\s+/)[1]);
        const r = await call<{ undoRef: string }>("dispatch", { type: "checkpoint.rollback", threadId, ordinal: n });
        console.log(c.dim(`files restored to checkpoint ${n} (undo: git checkout ${r.undoRef} -- .)`));
      } else {
        await call("dispatch", { type: "message.send", threadId, text });
      }
    } catch (err) {
      console.log(c.red(`! ${(err as Error).message}`));
    }
  }
}

async function main() {
  await new Promise<void>((resolve, reject) => {
    ws.once("open", resolve);
    ws.once("error", reject);
  });
  const [cmd = "chat", ...rest] = process.argv.slice(2);
  const flag = (name: string) => {
    const i = rest.indexOf(name);
    return i >= 0 ? rest[i + 1] : undefined;
  };

  if (cmd === "ui") {
    // The token travels in the URL fragment, which the browser never sends to the server.
    const url = `http://127.0.0.1:${PORT}/#token=${readToken()}`;
    if (process.platform === "darwin" && !rest.includes("--print")) {
      const { execFile } = await import("node:child_process");
      execFile("open", [url]);
      console.log(`opened the web UI on http://127.0.0.1:${PORT}`);
    } else {
      console.log(url);
    }
    process.exit(0);
  }
  if (cmd === "list") {
    for (const t of await call<Thread[]>("listThreads")) {
      console.log(`${t.id}  ${t.status.padEnd(7)} ${String(t.runCount).padStart(3)} turns  ${t.title}  ${c.dim(t.cwd)}`);
    }
    process.exit(0);
  }
  if (cmd === "chat") {
    let threadId = rest.find((a) => !a.startsWith("--") && a !== flag("--cwd") && a !== flag("--mode") && a !== flag("--provider") && a !== flag("--model"));
    if (!threadId) {
      const created = await call<{ threadId: string }>("dispatch", {
        type: "thread.create",
        cwd: flag("--cwd") ?? process.cwd(),
        provider: flag("--provider") ?? "claude",
        model: flag("--model"),
        runtimeMode: (flag("--mode") as RuntimeMode | undefined) ?? "approval-required",
      });
      threadId = created.threadId;
    }
    return chat(threadId);
  }
  console.log("usage: client ui | client list | client chat [threadId] [--cwd DIR] [--provider claude|codex] [--model M] [--mode MODE]");
  process.exit(1);
}

main().catch((err) => {
  console.error(c.red(String(err?.message ?? err)));
  process.exit(1);
});
