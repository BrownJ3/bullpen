// End-to-end test of named agents against a running server.
//   BULLPEN_HOME=... BULLPEN_PORT=... node scripts/agents-smoke.ts <dir> [threadProvider] [agentProvider]
// Set CODEX_MODEL to pick the model for any Codex side. Costs about four short turns.
//  1. creates an agent with distinctive instructions
//  2. @mentions it from a thread and checks the reply lands in that thread
//  3. asks the thread's own agent to consult it with ask_agent, and checks the answer comes back
//     and that the earlier @mention reply was handed to the thread's agent

import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { WebSocket } from "ws";
import { HOME, readToken } from "../src/home.ts";
import { DEFAULT_PORT, type Push, type Response } from "../src/protocol.ts";
import type { StoredEvent, Thread, TurnItem } from "../src/types.ts";

const [dir, threadProvider = "claude", agentProvider = "claude"] = process.argv.slice(2);
if (!dir) throw new Error("usage: agents-smoke.ts <dir> [threadProvider] [agentProvider]");
const PORT = Number(process.env.BULLPEN_PORT ?? DEFAULT_PORT);
const modelFor = (p: string) => (p === "codex" ? process.env.CODEX_MODEL : undefined);

const ws = new WebSocket(`ws://127.0.0.1:${PORT}`, { headers: { authorization: `Bearer ${readToken()}` } });
let id = 1;
const waiters = new Map<number, (r: Response) => void>();
const listeners = new Set<(e: StoredEvent) => void>();
ws.on("message", (raw) => {
  const msg = JSON.parse(String(raw)) as Response | Push;
  if ("subscription" in msg) { if ("items" in msg) for (const e of msg.items) for (const l of listeners) l(e); }
  else waiters.get(msg.id)?.(msg);
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
function until<T>(pick: (e: StoredEvent) => T | undefined, ms = 240_000): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timed out")), ms);
    const l = (e: StoredEvent) => {
      const v = pick(e);
      if (v === undefined) return;
      clearTimeout(timer);
      listeners.delete(l);
      resolve(v);
    };
    listeners.add(l);
  });
}
// Approve anything an agent asks for, once each (the sidebar and thread feeds both carry approvals).
const approved = new Set<string>();
listeners.add((e) => {
  if (e.event.type === "turn-item.upserted" && e.event.item.kind === "approval_request" && e.event.item.status === "pending") {
    const { threadId, requestId, tool } = e.event.item;
    if (approved.has(requestId)) return;
    approved.add(requestId);
    console.log(`      approving ${tool}`);
    void call("dispatch", { type: "runtime-request.respond", threadId, requestId, decision: "accept" });
  }
});

await new Promise((r) => ws.once("open", r));
const sidebar = await call<{ subscription: number }>("subscribeSidebar");
void sidebar;

const name = `poet-${Date.now().toString(36).slice(-4)}`;
const { threadId: homeId } = await call<{ agentId: string; threadId: string }>("dispatch", {
  type: "agent.create",
  name,
  description: "Writes one-line greetings",
  instructions: "Answer every request with exactly one line that starts with 'POET:'. Only use tools to read files you're asked about.",
  provider: agentProvider,
  model: modelFor(agentProvider),
});
check(existsSync(join(HOME, "agents", name, "MEMORY.md")), "agent got its own folder with a MEMORY.md");
const word = `kiwi${Date.now().toString(36).slice(-3)}`;
writeFileSync(join(dir, "secret.txt"), `${word}\n`);
await call("subscribeThread", { threadId: homeId });
const { threadId } = await call<{ threadId: string }>("dispatch", {
  type: "thread.create",
  cwd: dir,
  provider: threadProvider,
  model: modelFor(threadProvider),
});
await call("subscribeThread", { threadId });
console.log(`agent @${name} on ${agentProvider}, thread on ${threadProvider}`);

// 1. @mention
const replyDone = until((e) =>
  e.event.type === "turn-item.upserted" && e.event.item.kind === "agent_reply" && e.event.item.status !== "running"
    ? e.event.item
    : undefined,
);
await call("dispatch", {
  type: "message.send",
  threadId,
  text: `@${name} read secret.txt in this project and greet my team in five words that include the word in that file`,
});
const reply = (await replyDone) as Extract<TurnItem, { kind: "agent_reply" }>;
check(reply.status === "completed", `@mention reply completed (${reply.status})`);
check(reply.text.includes("POET:"), `reply follows the agent's instructions: ${JSON.stringify(reply.text.slice(0, 80))}`);
check(reply.text.toLowerCase().includes(word), `agent worked in the caller's project (read "${word}")`);
check(reply.threadId === threadId, "reply posted in the calling thread");

// 2. ask_agent from the thread's own agent
const items = new Map<string, TurnItem>();
listeners.add((e) => {
  if (e.event.type === "turn-item.upserted" && e.event.item.threadId === threadId) items.set(e.event.item.id, e.event.item);
});
const idle = until((e) => (e.event.type === "thread.upserted" && e.event.thread.id === threadId && e.event.thread.status === "idle" ? true : undefined));
await call("dispatch", {
  type: "message.send",
  threadId,
  text: `First, in one short sentence, say what the poet agent told us earlier. Then use your ask_agent tool to ask the agent "${name}" for a two-word greeting, and finish by quoting its answer exactly.`,
});
await idle;
const all = [...items.values()];
const ask = all.find((i) => i.kind === "tool_call" && i.tool.endsWith("ask_agent"));
check(ask?.kind === "tool_call" && ask.status === "completed", `thread's agent called ask_agent (${ask?.kind === "tool_call" ? ask.status : "not called"})`);
check(ask?.kind === "tool_call" && (ask.output ?? "").includes("POET:"), "ask_agent returned the agent's answer");
const final = all.filter((i) => i.kind === "assistant_message").at(-1);
const greeting = ask?.kind === "tool_call" ? (ask.output ?? "").replace(/^.*POET:\s*/s, "").split(/\s+/)[0]?.replace(/[^\w]/g, "") : "";
check(greeting && final?.kind === "assistant_message" && final.text.includes(greeting), `thread's agent used the answer (${JSON.stringify(final?.kind === "assistant_message" ? final.text.slice(-60) : "")})`);
const delivered = all.find((i) => i.kind === "agent_reply" && i.id === reply.id) ?? reply;
check(delivered.kind === "agent_reply" && delivered.delivered, "earlier @mention reply was handed to the thread's agent");

const threads = await call<Thread[]>("listThreads");
const home = threads.find((t) => t.id === homeId);
check(home?.runCount === 2 && home.nativeSessionId, `agent kept one conversation across both calls (${home?.runCount} turns)`);

// 3. self-consult is refused instead of deadlocking
const loop = await call<{ agents: string[] } | undefined>("dispatch", { type: "message.send", threadId: homeId, text: `@${name} hi` })
  .then(() => "accepted")
  .catch((e: Error) => e.message);
check(loop === "accepted", "a message mentioning the agent in its own thread goes to it directly");
await until((e) => (e.event.type === "thread.upserted" && e.event.thread.id === homeId && e.event.thread.status === "idle" ? true : undefined));

ws.close();
