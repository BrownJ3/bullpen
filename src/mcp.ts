// Bullpen's own tools over MCP (T3 injects an HTTP /mcp server into every agent session).
// Claude gets the harness tools in-process and Codex as dynamic tools; other engines (ACP agents) get them here:
// a per-session URL with an unguessable path, revoked when the session closes. Streamable HTTP, JSON responses only.

import { randomBytes } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { HarnessTool } from "./types.ts";

const sessions = new Map<string, HarnessTool[]>();
let base = "";

/** Called once by the server with its own address. */
export function setMcpBase(url: string) {
  base = url.replace(/\/$/, "");
}

/** Expose tools at a new secret URL. */
export function registerMcp(tools: HarnessTool[]): { url: string; revoke: () => void } | undefined {
  if (!base || !tools.length) return undefined;
  const key = randomBytes(24).toString("hex");
  sessions.set(key, tools);
  return { url: `${base}/mcp/${key}`, revoke: () => sessions.delete(key) };
}

/** Handle POST /mcp/<key>. Returns false if it isn't an MCP request. */
export async function handleMcp(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  const m = req.url?.match(/^\/mcp\/([0-9a-f]{48})$/);
  if (!m) return false;
  const tools = sessions.get(m[1]);
  if (!tools) {
    res.writeHead(404).end();
    return true;
  }
  if (req.method === "DELETE") {
    res.writeHead(200).end();
    return true;
  }
  if (req.method !== "POST") {
    // No server-initiated stream.
    res.writeHead(405, { allow: "POST" }).end();
    return true;
  }
  let raw = "";
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 4 * 1024 * 1024) {
      res.writeHead(413).end();
      return true;
    }
  }
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    res.writeHead(400, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }));
    return true;
  }
  const batch = Array.isArray(body) ? body : [body];
  const replies = (await Promise.all(batch.map((msg) => answer(tools, msg as Rpc)))).filter((r) => r !== undefined);
  if (!replies.length) {
    res.writeHead(202).end();
    return true;
  }
  res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(Array.isArray(body) ? replies : replies[0]));
  return true;
}

interface Rpc {
  jsonrpc: "2.0";
  id?: string | number;
  method: string;
  params?: Record<string, unknown>;
}

async function answer(tools: HarnessTool[], msg: Rpc): Promise<unknown> {
  if (msg.id === undefined) return undefined; // notification
  const ok = (result: unknown) => ({ jsonrpc: "2.0", id: msg.id, result });
  switch (msg.method) {
    case "initialize":
      return ok({
        protocolVersion: typeof msg.params?.protocolVersion === "string" ? msg.params.protocolVersion : "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "bullpen", version: "0.1.0" },
      });
    case "ping":
      return ok({});
    case "tools/list":
      return ok({
        tools: tools.map((t) => ({
          name: t.name,
          description: t.description,
          inputSchema: {
            type: "object",
            properties: Object.fromEntries(Object.entries(t.params).map(([k, p]) => [k, { type: "string", description: p.description }])),
            required: Object.entries(t.params).filter(([, p]) => !p.optional).map(([k]) => k),
          },
        })),
      });
    case "tools/call": {
      const name = String(msg.params?.name ?? "");
      const tool = tools.find((t) => t.name === name);
      if (!tool) return { jsonrpc: "2.0", id: msg.id, error: { code: -32602, message: `Unknown tool ${name}` } };
      const args = Object.fromEntries(Object.entries((msg.params?.arguments ?? {}) as Record<string, unknown>).map(([k, v]) => [k, typeof v === "string" ? v : JSON.stringify(v)]));
      try {
        const r = await tool.run(args);
        return ok({ content: [{ type: "text", text: r.text }], isError: Boolean(r.isError) });
      } catch (err) {
        return ok({ content: [{ type: "text", text: (err as Error).message }], isError: true });
      }
    }
    default:
      return { jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: `Method not found: ${msg.method}` } };
  }
}
