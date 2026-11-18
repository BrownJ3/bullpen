// A minimal ACP agent for testing Bullpen's ACP adapter: on each prompt it thinks, asks to write hello.txt,
// writes it through the client, lists the MCP tools it was given, calls one, and answers.
import { createInterface } from "node:readline";
let id = 1000;
const calls = new Map();
const send = (m) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...m }) + "\n");
const request = (method, params) => new Promise((resolve, reject) => { const i = id++; calls.set(i, { resolve, reject }); send({ id: i, method, params }); });
const update = (sessionId, update) => send({ method: "session/update", params: { sessionId, update } });
let mcp, cwd;
createInterface({ input: process.stdin }).on("line", async (line) => {
  const msg = JSON.parse(line);
  if (msg.id !== undefined && !msg.method) { const c = calls.get(msg.id); calls.delete(msg.id); msg.error ? c.reject(new Error(msg.error.message)) : c.resolve(msg.result); return; }
  const { method, params } = msg;
  if (method === "initialize") return send({ id: msg.id, result: { protocolVersion: 1, agentCapabilities: { loadSession: false, mcpCapabilities: { http: true } } } });
  if (method === "session/new") { mcp = params.mcpServers?.[0]; cwd = params.cwd; return send({ id: msg.id, result: { sessionId: "mock-1" } }); }
  if (method === "session/cancel") return;
  if (method === "session/prompt") {
    const sid = params.sessionId;
    update(sid, { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "Planning the file." } });
    const path = `${cwd}/hello.txt`;
    update(sid, { sessionUpdate: "tool_call", toolCallId: "t1", title: "Write hello.txt", kind: "edit", status: "pending", rawInput: { path, content: "hi" } });
    const perm = await request("session/request_permission", { sessionId: sid, toolCall: { toolCallId: "t1", title: "Write hello.txt", kind: "edit", rawInput: { path } },
      options: [{ optionId: "yes", name: "Allow", kind: "allow_once" }, { optionId: "no", name: "Reject", kind: "reject_once" }] });
    let wrote = false;
    if (perm.outcome?.optionId === "yes") { await request("fs/write_text_file", { sessionId: sid, path, content: "hi\n" }); wrote = true; }
    update(sid, { sessionUpdate: "tool_call_update", toolCallId: "t1", status: wrote ? "completed" : "failed", content: [{ type: "content", content: { type: "text", text: wrote ? "written" : "rejected" } }] });
    let tools = 0, agents = "";
    if (mcp?.url) {
      const post = (body) => fetch(mcp.url, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify(body) }).then((r) => r.json());
      await post({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "mock", version: "0" } } });
      tools = (await post({ jsonrpc: "2.0", id: 2, method: "tools/list" })).result.tools.length;
      agents = (await post({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "list_agents", arguments: {} } })).result.content[0].text;
    }
    update(sid, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: `Done (${wrote ? "wrote" : "didn't write"} hello.txt). ` } });
    update(sid, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: `MCP tools: ${tools}; agents: ${agents}` } });
    return send({ id: msg.id, result: { stopReason: "end_turn" } });
  }
  if (msg.id !== undefined) send({ id: msg.id, error: { code: -32601, message: "nope" } });
});
