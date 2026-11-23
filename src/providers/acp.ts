// Any agent that speaks the Agent Client Protocol (ACP: Gemini CLI, OpenCode, Goose, Claude Code via its ACP
// adapter, …), the same way T3 supports "any ACP agent". One child process per thread, newline-delimited JSON-RPC
// over stdio:
//   initialize → session/new | session/load → session/prompt … session/update notifications … {stopReason}
// The agent asks for approvals with session/request_permission and reads/writes files through us (fs/*).
// Bullpen's own tools reach it as an MCP server over HTTP (src/mcp.ts) when it supports that.

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, resolve, sep } from "node:path";
import { createInterface } from "node:readline";
import { JsonRpc } from "./jsonrpc.ts";
import { shellFor } from "../engines.ts";
import { registerMcp } from "../mcp.ts";
import { isSafeCommand, localContext } from "../team-policy.ts";
import { clipOutput } from "../util.ts";
import type { AdapterEvent, Decision, OpenSessionInput, ProviderAdapter, ProviderSession, RuntimeMode, TurnItem } from "../types.ts";

const STREAM_FLUSH_MS = 50;
const MAX_TOOL_OUTPUT = 4000;
type Json = Record<string, any>;
type ApprovalItem = Extract<TurnItem, { kind: "approval_request" }>;

export interface AcpEngine {
  /** Stored on threads as their provider, e.g. "gemini". */
  id: string;
  name: string;
  command: string;
  args: string[];
  env?: Record<string, string>;
}

const text = (content: unknown): string => {
  if (!content) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map(text).join("\n");
  const c = content as Json;
  if (c.type === "text") return String(c.text ?? "");
  if (c.type === "content") return text(c.content);
  if (c.type === "diff") return `${c.path}\n${c.newText ?? ""}`.slice(0, MAX_TOOL_OUTPUT);
  if (c.type === "terminal") return `[terminal ${c.terminalId}]`;
  return "";
};
const clip = (s: string) => clipOutput(s, MAX_TOOL_OUTPUT);

class AcpSession implements ProviderSession {
  readonly #emit: (e: AdapterEvent) => void;
  readonly #threadId: string;
  readonly #cwd: string;
  readonly #mode: RuntimeMode;
  readonly #ownFolder?: string;
  readonly #proc: ChildProcessWithoutNullStreams;
  readonly #rpc: JsonRpc;
  readonly #ready: Promise<string>;
  readonly #mcp?: { url: string; revoke: () => void };
  #closed = false;
  #sessionId: string | undefined;
  #loading = false; // session/load replays history as updates: ignore those

  #runId: string | undefined;
  #turn = 0;
  #turnMode: RuntimeMode;
  #team = false;
  #workdir: string;
  #interruptRequested = false;
  readonly #pending = new Map<string, { rpcId: number | string; item: ApprovalItem; options: Json[] }>();
  readonly #tools = new Map<string, { tool: string; input: unknown }>();
  readonly #streaming = new Map<string, Extract<TurnItem, { kind: "assistant_message" | "reasoning" }>>();
  #streamKey: { kind: string; id: string } | undefined;
  #flush: NodeJS.Timeout | undefined;

  constructor(engine: AcpEngine, input: OpenSessionInput) {
    this.#emit = input.emit;
    this.#threadId = input.threadId;
    this.#cwd = input.cwd;
    this.#workdir = input.cwd;
    this.#mode = input.runtimeMode;
    this.#turnMode = input.runtimeMode;
    this.#ownFolder = input.ownFolder;
    this.#mcp = registerMcp(input.tools ?? []);
    this.#proc = spawn(engine.command, engine.args, { cwd: input.cwd, env: { ...process.env, ...engine.env }, stdio: ["pipe", "pipe", "pipe"], ...shellFor(engine.command) });
    this.#rpc = new JsonRpc(this.#proc, { request: (id, method, params) => void this.#onRequest(id, method, params), notification: (method, params) => this.#onNotification(method, params) }, { jsonrpcField: true });
    createInterface({ input: this.#proc.stderr }).on("line", (l) => {
      if (process.env.BULLPEN_DEBUG) console.error(`[${engine.id}] ${l}`);
    });
    this.#proc.on("error", (err) => this.#onExit(`couldn't start ${engine.name} (${engine.command}): ${err.message}`));
    this.#proc.on("exit", (code, signal) => this.#onExit(`${engine.name} exited (${signal ?? code})`));
    this.#ready = this.#handshake(input);
    this.#ready.catch((err) => this.#fail(String(err?.message ?? err)));
  }

  async #handshake(input: OpenSessionInput): Promise<string> {
    const init = await this.#rpc.request("initialize", {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: false },
      clientInfo: { name: "bullpen", title: "Bullpen", version: "0.1.0" },
    });
    const caps = init.agentCapabilities ?? {};
    const mcpServers = this.#mcp && caps.mcpCapabilities?.http ? [{ type: "http", name: "bullpen", url: this.#mcp.url, headers: [] }] : [];
    if (input.resumeNativeSessionId && caps.loadSession) {
      try {
        this.#loading = true;
        await this.#rpc.request("session/load", { sessionId: input.resumeNativeSessionId, cwd: input.cwd, mcpServers });
        this.#loading = false;
        this.#sessionId = input.resumeNativeSessionId;
        this.#emit({ type: "native_session.updated", nativeSessionId: this.#sessionId });
        return this.#sessionId;
      } catch {
        this.#loading = false; // gone: start fresh
      }
    }
    const res = await this.#rpc.request("session/new", { cwd: input.cwd, mcpServers });
    this.#sessionId = String(res.sessionId);
    this.#emit({ type: "native_session.updated", nativeSessionId: this.#sessionId });
    // An agent prompt (a named agent's instructions) has nowhere else to go in ACP: send it with the first turn.
    if (input.instructions) this.#preamble = input.instructions;
    return this.#sessionId;
  }
  #preamble: string | undefined;

  startTurn({ runId, text: prompt, workdir, team, mode }: { runId: string; text: string; workdir?: string; team?: boolean; mode?: RuntimeMode }) {
    this.#runId = runId;
    this.#turn++;
    this.#interruptRequested = false;
    this.#turnMode = mode ?? this.#mode;
    this.#team = Boolean(team);
    this.#workdir = workdir ?? this.#cwd;
    const where = workdir && workdir !== this.#cwd ? `(Work in the project folder ${workdir}; use absolute paths.)\n\n` : "";
    const body = `${this.#preamble ? `${this.#preamble}\n\n---\n\n` : ""}${where}${prompt}`;
    this.#preamble = undefined;
    void (async () => {
      try {
        const sessionId = await this.#ready;
        const res = await this.#rpc.request("session/prompt", { sessionId, prompt: [{ type: "text", text: body }] });
        this.#flushNow();
        const id = this.#runId;
        if (!id) return;
        this.#runId = undefined;
        const stop = String(res.stopReason ?? "end_turn");
        const outcome = stop === "cancelled" || this.#interruptRequested ? "interrupted" : stop === "refusal" ? "failed" : "completed";
        this.#emit({ type: "turn.terminal", runId: id, outcome, error: outcome === "failed" ? `The agent stopped: ${stop}` : undefined });
      } catch (err) {
        this.#fail(String((err as Error)?.message ?? err));
      }
    })();
  }

  async interruptTurn() {
    if (!this.#runId || !this.#sessionId) return;
    this.#interruptRequested = true;
    for (const id of [...this.#pending.keys()]) this.respondToRuntimeRequest(id, "cancel");
    this.#rpc.notify("session/cancel", { sessionId: this.#sessionId });
  }

  respondToRuntimeRequest(requestId: string, decision: Decision): boolean {
    const p = this.#pending.get(requestId);
    if (!p) return false;
    this.#pending.delete(requestId);
    this.#emitItem({ ...p.item, status: "resolved", decision });
    this.#answerPermission(p.rpcId, p.options, decision);
    return true;
  }

  close() {
    this.#closed = true;
    for (const id of [...this.#pending.keys()]) this.respondToRuntimeRequest(id, "cancel");
    this.#mcp?.revoke();
    this.#proc.kill("SIGTERM");
  }

  // ---------- JSON-RPC ----------



  #onExit(reason: string) {
    if (this.#closed) return;
    this.#closed = true;
    this.#mcp?.revoke();
    this.#rpc.rejectAll(reason);
    this.#fail(reason);
  }

  #fail(error: string) {
    const id = this.#runId;
    if (!id) return;
    this.#runId = undefined;
    this.#emit({ type: "turn.terminal", runId: id, outcome: "failed", error });
  }

  // ---------- agent → client requests ----------

  async #onRequest(rpcId: number | string, method: string, params: Json) {
    try {
      switch (method) {
        case "session/request_permission":
          return this.#permission(rpcId, params);
        case "fs/read_text_file": {
          const path = this.#path(params.path);
          let content = readFileSync(path, "utf8");
          if (params.line || params.limit) {
            const lines = content.split("\n");
            const start = Math.max(0, Number(params.line ?? 1) - 1);
            content = lines.slice(start, params.limit ? start + Number(params.limit) : undefined).join("\n");
          }
          return this.#rpc.write({ id: rpcId, result: { content } });
        }
        case "fs/write_text_file": {
          const path = this.#path(params.path, true);
          mkdirSync(dirname(path), { recursive: true });
          writeFileSync(path, String(params.content ?? ""));
          return this.#rpc.write({ id: rpcId, result: null });
        }
        default:
          return this.#rpc.write({ id: rpcId, error: { code: -32601, message: `Bullpen doesn't support ${method}` } });
      }
    } catch (err) {
      this.#rpc.write({ id: rpcId, error: { code: -32000, message: (err as Error).message } });
    }
  }

  /** Files the agent reads or writes through us must be inside the folders it's working in. */
  #path(p: unknown, write = false): string {
    const raw = String(p ?? "");
    const abs = isAbsolute(raw) ? resolve(raw) : resolve(this.#workdir, raw);
    const roots = [this.#workdir, this.#cwd, this.#ownFolder].filter(Boolean) as string[];
    if (!roots.some((r) => abs === r || abs.startsWith(r + sep))) {
      throw new Error(`${write ? "Writing" : "Reading"} outside the project isn't allowed: ${abs}`);
    }
    if (!write && !existsSync(abs)) throw new Error(`No such file: ${abs}`);
    return abs;
  }

  #permission(rpcId: number | string, params: Json) {
    const call = params.toolCall ?? {};
    const options: Json[] = params.options ?? [];
    const kind = String(call.kind ?? this.#tools.get(String(call.toolCallId))?.tool ?? "other");
    const input = call.rawInput ?? this.#tools.get(String(call.toolCallId))?.input ?? { title: call.title };
    // The same rules as the built-in engines: full access allows everything; building automatically (or a team
    // task) allows edits, reads and safe commands; otherwise the person decides.
    const auto =
      this.#turnMode === "full-access" ||
      ((this.#turnMode === "auto-accept-edits" || this.#team) &&
        (["read", "search", "think", "fetch", "edit"].includes(kind) || (kind === "execute" && isSafeCommand((input as Json)?.command, localContext([this.#workdir, this.#ownFolder])))));
    if (auto) return this.#answerPermission(rpcId, options, "accept");
    const requestId = `acp:${call.toolCallId ?? rpcId}:${rpcId}`;
    const item: ApprovalItem = {
      id: `approval:${requestId}`,
      threadId: this.#threadId,
      runId: this.#runId ?? "unknown",
      kind: "approval_request",
      requestId,
      tool: toolName(kind, call.title),
      input,
      status: "pending",
    };
    this.#pending.set(requestId, { rpcId, item, options });
    this.#emitItem(item);
  }

  #answerPermission(rpcId: number | string, options: Json[], decision: Decision) {
    if (decision === "cancel") return this.#rpc.write({ id: rpcId, result: { outcome: { outcome: "cancelled" } } });
    const want = decision === "accept" ? ["allow_once", "allow_always"] : decision === "acceptForSession" ? ["allow_always", "allow_once"] : ["reject_once", "reject_always"];
    const pick = want.map((k) => options.find((o) => o.kind === k)).find(Boolean) ?? options[0];
    if (!pick) return this.#rpc.write({ id: rpcId, result: { outcome: { outcome: "cancelled" } } });
    this.#rpc.write({ id: rpcId, result: { outcome: { outcome: "selected", optionId: pick.optionId } } });
  }

  // ---------- agent → client notifications ----------

  #onNotification(method: string, params: Json) {
    if (method !== "session/update" || this.#loading || !this.#runId) return;
    const u = params.update ?? {};
    switch (u.sessionUpdate) {
      case "agent_message_chunk":
      case "agent_thought_chunk": {
        const kind = u.sessionUpdate === "agent_message_chunk" ? "assistant_message" : "reasoning";
        if (this.#streamKey?.kind !== kind) {
          this.#flushNow();
          this.#streamKey = { kind, id: `acp:${this.#runId}:${this.#turn}:${randomPart()}` };
        }
        const id = this.#streamKey.id;
        const prev = this.#streaming.get(id);
        this.#streaming.set(id, { ...this.#base(id), kind, text: (prev?.text ?? "") + text(u.content), streaming: true } as never);
        this.#flush ??= setTimeout(() => {
          this.#flush = undefined;
          for (const item of this.#streaming.values()) this.#emitItem(item);
        }, STREAM_FLUSH_MS);
        return;
      }
      case "tool_call":
      case "tool_call_update": {
        this.#flushNow();
        const id = `tool:${u.toolCallId}`;
        const prev = this.#tools.get(id);
        const tool = prev?.tool ?? toolName(String(u.kind ?? "other"), u.title);
        const input = u.rawInput ?? prev?.input ?? (u.locations?.length ? { path: u.locations[0].path } : { title: u.title });
        this.#tools.set(id, { tool, input });
        const status = u.status === "completed" ? "completed" : u.status === "failed" ? "failed" : "running";
        const output = u.content ? clip(text(u.content)) : undefined;
        this.#emitItem({ ...this.#base(id), kind: "tool_call", tool, input, status, ...(output ? { output } : {}) });
        return;
      }
      default:
        return;
    }
  }

  #flushNow() {
    if (this.#flush) clearTimeout(this.#flush);
    this.#flush = undefined;
    for (const item of this.#streaming.values()) this.#emitItem({ ...item, streaming: false });
    this.#streaming.clear();
    this.#streamKey = undefined;
  }

  #base(id: string) {
    return { id, threadId: this.#threadId, runId: this.#runId ?? "unknown" };
  }
  #emitItem(item: TurnItem) {
    this.#emit({ type: "turn_item.updated", item });
  }
}

let seq = 0;
const randomPart = () => (++seq).toString(36);

/** ACP tool kinds → names the UI already knows how to describe. */
function toolName(kind: string, title?: string): string {
  switch (kind) {
    case "read":
      return "Read";
    case "edit":
      return "Edit";
    case "delete":
      return "Delete";
    case "move":
      return "Move";
    case "search":
      return "Grep";
    case "execute":
      return "Bash";
    case "fetch":
      return "WebFetch";
    case "think":
      return "Think";
    default:
      return title ? String(title).slice(0, 60) : "tool";
  }
}

export function acpAdapter(engine: AcpEngine): ProviderAdapter {
  return { kind: engine.id, openSession: (input) => new AcpSession(engine, input) };
}
