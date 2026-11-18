// Codex provider, driven through `codex app-server` (same approach as T3's CodexAdapterV2).
// One app-server child process per thread, speaking newline-delimited JSON-RPC over stdio:
//   initialize → initialized → thread/start | thread/resume → turn/start … turn/completed
// Codex asks for approvals with server→client requests (item/*/requestApproval); we park the
// JSON-RPC id until the user answers, then reply with the decision.
//
// Protocol types: `codex app-server generate-ts --out DIR` prints the full schema for your version.

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import type {
  AdapterEvent,
  Decision,
  HarnessTool,
  OpenSessionInput,
  ProviderAdapter,
  ProviderSession,
  RuntimeMode,
  TurnItem,
} from "../types.ts";

const STREAM_FLUSH_MS = 50;
const MAX_TOOL_OUTPUT = 4000;

type Json = Record<string, any>;
type ApprovalItem = Extract<TurnItem, { kind: "approval_request" }>;
type StreamItem = Extract<TurnItem, { kind: "assistant_message" | "reasoning" }>;

/** BULLPEN_CODEX_BIN, else `codex` on PATH, else the copy T3 Code downloads. */
function codexBinary(): string {
  if (process.env.BULLPEN_CODEX_BIN) return process.env.BULLPEN_CODEX_BIN;
  for (const dir of (process.env.PATH ?? "").split(":")) {
    if (dir && existsSync(join(dir, "codex"))) return join(dir, "codex");
  }
  const t3 = join(homedir(), ".t3", "tools", "codex");
  if (existsSync(t3)) {
    const versions = readdirSync(t3).sort().reverse();
    for (const v of versions) {
      const bin = join(t3, v, "bin", "codex");
      if (existsSync(bin)) return bin;
    }
  }
  return "codex";
}

/** RuntimeMode → Codex approval policy + sandbox. */
function policyFor(mode: RuntimeMode) {
  switch (mode) {
    case "approval-required": // read-only sandbox: every write or risky command asks first
      return { approvalPolicy: "untrusted", sandbox: "read-only" };
    case "auto-accept-edits": // writes inside the workspace go through; escalations ask
      return { approvalPolicy: "on-request", sandbox: "workspace-write" };
    case "full-access":
      return { approvalPolicy: "never", sandbox: "danger-full-access" };
  }
}

/** Per-turn approval policy and sandbox (Codex keeps them for later turns, so every turn sets them). */
function turnPolicy(mode: RuntimeMode, root: string, team: boolean) {
  const workspace = { type: "workspaceWrite", writableRoots: [root], networkAccess: false, excludeTmpdirEnvVar: false, excludeSlashTmp: false };
  if (mode === "full-access") return { approvalPolicy: "never", sandboxPolicy: { type: "dangerFullAccess" } };
  if (team || mode === "auto-accept-edits") return { approvalPolicy: "on-request", sandboxPolicy: workspace };
  return { approvalPolicy: "untrusted", sandboxPolicy: { type: "readOnly", networkAccess: false } };
}

function truncate(text: string): string {
  return text.length > MAX_TOOL_OUTPUT ? `${text.slice(0, MAX_TOOL_OUTPUT)}\n…[truncated]` : text;
}

/** Codex ThreadItem → our tool_call fields, or undefined for items we don't show as tools. */
function toolFields(item: Json): { tool: string; input: unknown; output?: string; failed: boolean } | undefined {
  const failed = item.status === "failed" || item.status === "declined";
  switch (item.type) {
    case "commandExecution":
      return {
        tool: "shell",
        input: { command: item.command, cwd: item.cwd },
        output: item.aggregatedOutput ?? undefined,
        failed: failed || (item.exitCode != null && item.exitCode !== 0),
      };
    case "fileChange":
      return {
        tool: "apply_patch",
        input: { files: (item.changes ?? []).map((c: Json) => `${c.kind?.type ?? "update"} ${c.path}`) },
        output: (item.changes ?? []).map((c: Json) => `--- ${c.path}\n${c.diff}`).join("\n"),
        failed,
      };
    case "mcpToolCall":
      return {
        tool: `${item.server}.${item.tool}`,
        input: item.arguments,
        output: item.error ? JSON.stringify(item.error) : item.result ? JSON.stringify(item.result) : undefined,
        failed: failed || !!item.error,
      };
    case "dynamicToolCall":
      return {
        tool: item.tool,
        input: item.arguments,
        output: (item.contentItems ?? []).map((c: Json) => c.text ?? "").join("\n") || undefined,
        failed: failed || item.success === false,
      };
    case "webSearch":
      return { tool: "web_search", input: { query: item.query }, failed: false };
    default:
      return undefined;
  }
}

class CodexSession implements ProviderSession {
  readonly #emit: (e: AdapterEvent) => void;
  readonly #threadId: string;
  readonly #proc: ChildProcessWithoutNullStreams;
  readonly #ready: Promise<string>; // resolves to Codex's thread id
  readonly #tools: Map<string, HarnessTool>;
  readonly #cwd: string;
  readonly #mode: RuntimeMode;

  #nextId = 1;
  readonly #calls = new Map<number, { resolve: (v: Json) => void; reject: (e: Error) => void }>();
  #codexThreadId: string | undefined;
  #closed = false;

  #runId: string | undefined;
  #turnId: string | undefined;
  #interruptRequested = false;
  #lastError: string | undefined;

  /** Approval requests Codex is blocked on, keyed by our requestId → JSON-RPC id to answer. */
  readonly #pending = new Map<string, { rpcId: number | string; item: ApprovalItem }>();
  /** Tool items seen at item/started, so approvals can show what's being approved. */
  readonly #toolItems = new Map<string, { tool: string; input: unknown }>();
  readonly #streaming = new Map<string, StreamItem>();
  readonly #dirty = new Set<string>();
  #flushTimer: NodeJS.Timeout | undefined;

  constructor(input: OpenSessionInput) {
    this.#emit = input.emit;
    this.#threadId = input.threadId;
    this.#tools = new Map((input.tools ?? []).map((t) => [t.name, t]));
    this.#cwd = input.cwd;
    this.#mode = input.runtimeMode;
    this.#proc = spawn(codexBinary(), ["app-server"], { cwd: input.cwd, stdio: ["pipe", "pipe", "pipe"] });

    createInterface({ input: this.#proc.stdout }).on("line", (line) => this.#onLine(line));
    createInterface({ input: this.#proc.stderr }).on("line", (line) => {
      if (process.env.BULLPEN_DEBUG) console.error(`[codex] ${line}`);
    });
    this.#proc.on("error", (err) => this.#onExit(`failed to start codex: ${err.message}`));
    this.#proc.on("exit", (code, signal) => this.#onExit(`codex app-server exited (${signal ?? code})`));

    this.#ready = this.#handshake(input);
    this.#ready.catch((err) => this.#failRun(String(err?.message ?? err)));
  }

  async #handshake(input: OpenSessionInput): Promise<string> {
    await this.#request("initialize", {
      clientInfo: { name: "bullpen", title: "Bullpen", version: "0.1.0" },
      capabilities: { experimentalApi: true },
    });
    this.#notify("initialized");
    const params = {
      cwd: input.cwd,
      model: input.model ?? null,
      developerInstructions: input.instructions ?? null,
      ...policyFor(input.runtimeMode),
    };
    // Harness tools as Codex "dynamic tools" (experimental API): calls come back as item/tool/call requests.
    const dynamicTools = [...this.#tools.values()].map((t) => ({
      type: "function",
      name: t.name,
      description: t.description,
      inputSchema: {
        type: "object",
        properties: Object.fromEntries(Object.entries(t.params).map(([k, p]) => [k, { type: "string", description: p.description }])),
        required: Object.entries(t.params).filter(([, p]) => !p.optional).map(([k]) => k),
        additionalProperties: false,
      },
    }));
    let result: Json;
    if (input.resumeNativeSessionId) {
      try {
        result = await this.#request("thread/resume", { threadId: input.resumeNativeSessionId, excludeTurns: true, ...params });
      } catch {
        result = await this.#request("thread/start", { ...params, dynamicTools }); // rollout gone: start fresh
      }
    } else {
      result = await this.#request("thread/start", { ...params, dynamicTools });
    }
    const id: string = result.thread.id;
    this.#codexThreadId = id;
    this.#emit({ type: "native_session.updated", nativeSessionId: id });
    return id;
  }

  startTurn({ runId, text, workdir, team, mode }: { runId: string; text: string; workdir?: string; team?: boolean; mode?: RuntimeMode }) {
    this.#runId = runId;
    this.#turnId = undefined;
    this.#interruptRequested = false;
    this.#lastError = undefined;
    void (async () => {
      try {
        const threadId = await this.#ready;
        const res = await this.#request("turn/start", {
          threadId,
          input: [{ type: "text", text, text_elements: [] }],
          // Sticky in Codex, so always say where (the caller's project, or the session's own folder)
          // and which rules apply: team tasks may write inside the project without asking.
          cwd: workdir ?? this.#cwd,
          ...turnPolicy(mode ?? this.#mode, workdir ?? this.#cwd, Boolean(team)),
        });
        this.#turnId ??= res.turn?.id;
        if (this.#interruptRequested) await this.#sendInterrupt();
      } catch (err) {
        this.#failRun(String((err as Error)?.message ?? err));
      }
    })();
  }

  async interruptTurn() {
    if (!this.#runId) return;
    this.#interruptRequested = true;
    for (const id of [...this.#pending.keys()]) this.respondToRuntimeRequest(id, "cancel");
    await this.#sendInterrupt(); // no-op until turn/start has returned a turn id; retried then
  }

  respondToRuntimeRequest(requestId: string, decision: Decision): boolean {
    const pending = this.#pending.get(requestId);
    if (!pending) return false;
    this.#pending.delete(requestId);
    this.#emitItem({ ...pending.item, status: "resolved", decision });
    // Codex's ApprovalDecision uses the same four words as ours.
    this.#write({ id: pending.rpcId, result: { decision } });
    return true;
  }

  close() {
    this.#closed = true;
    for (const id of [...this.#pending.keys()]) this.respondToRuntimeRequest(id, "cancel");
    this.#proc.kill("SIGTERM");
  }

  // ---------- JSON-RPC plumbing ----------

  #write(msg: Json) {
    if (this.#proc.stdin.writable) this.#proc.stdin.write(`${JSON.stringify(msg)}\n`);
  }

  #notify(method: string, params?: Json) {
    this.#write(params ? { method, params } : { method });
  }

  #request(method: string, params: Json): Promise<Json> {
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      this.#calls.set(id, { resolve, reject });
      this.#write({ id, method, params });
    });
  }

  async #sendInterrupt() {
    if (!this.#turnId || !this.#codexThreadId) return;
    try {
      await this.#request("turn/interrupt", { threadId: this.#codexThreadId, turnId: this.#turnId });
    } catch {
      // turn already finished
    }
  }

  #onLine(line: string) {
    let msg: Json;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    if (msg.method && msg.id !== undefined) return this.#onServerRequest(msg.id, msg.method, msg.params ?? {});
    if (msg.method) return this.#onNotification(msg.method, msg.params ?? {});
    const call = this.#calls.get(msg.id);
    if (!call) return;
    this.#calls.delete(msg.id);
    if (msg.error) call.reject(new Error(msg.error.message ?? JSON.stringify(msg.error)));
    else call.resolve(msg.result ?? {});
  }

  #onExit(reason: string) {
    if (this.#closed) return;
    this.#closed = true;
    for (const call of this.#calls.values()) call.reject(new Error(reason));
    this.#calls.clear();
    this.#pending.clear();
    this.#failRun(reason);
  }

  #failRun(error: string) {
    const runId = this.#runId;
    if (!runId) return;
    this.#runId = undefined;
    this.#emit({ type: "turn.terminal", runId, outcome: "failed", error });
  }

  // ---------- server → client ----------

  #onServerRequest(rpcId: number | string, method: string, params: Json) {
    if (method === "item/tool/call") return void this.#runTool(rpcId, params);
    if (method !== "item/commandExecution/requestApproval" && method !== "item/fileChange/requestApproval") {
      // User-input prompts, MCP elicitations, permission grants etc. aren't modelled here.
      this.#write({ id: rpcId, error: { code: -32601, message: `bullpen does not handle ${method}` } });
      return;
    }
    const started = this.#toolItems.get(params.itemId);
    const isCommand = method === "item/commandExecution/requestApproval";
    const requestId = `codex:${params.itemId}:${params.approvalId ?? rpcId}`;
    const item: ApprovalItem = {
      ...this.#base(`approval:${requestId}`),
      kind: "approval_request",
      requestId,
      tool: started?.tool ?? (isCommand ? "shell" : "apply_patch"),
      input: isCommand
        ? { command: params.command, cwd: params.cwd, reason: params.reason ?? undefined }
        : { ...(started?.input as Json | undefined), reason: params.reason ?? undefined },
      status: "pending",
    };
    this.#pending.set(requestId, { rpcId, item });
    this.#emitItem(item);
  }

  async #runTool(rpcId: number | string, params: Json) {
    const t = this.#tools.get(params.tool);
    let res: { text: string; isError?: boolean };
    try {
      res = t ? await t.run((params.arguments ?? {}) as Record<string, string>) : { text: `Unknown tool ${params.tool}`, isError: true };
    } catch (err) {
      res = { text: String((err as Error)?.message ?? err), isError: true };
    }
    this.#write({ id: rpcId, result: { contentItems: [{ type: "inputText", text: res.text }], success: !res.isError } });
  }

  #onNotification(method: string, p: Json) {
    // Ignore other threads (e.g. Codex subagents) and stale turns.
    if (p.threadId && p.threadId !== this.#codexThreadId) return;

    switch (method) {
      case "turn/started":
        this.#turnId ??= p.turn?.id;
        return;

      case "item/agentMessage/delta":
        return this.#appendStream(p.itemId, "assistant_message", p.delta);
      case "item/reasoning/summaryTextDelta":
      case "item/reasoning/textDelta":
        return this.#appendStream(p.itemId, "reasoning", p.delta);

      case "item/started":
      case "item/completed":
        return this.#onItem(p.item, method === "item/completed");

      case "serverRequest/resolved": {
        // Codex resolved a request itself (e.g. turn interrupted): drop our pending copy.
        for (const [id, pending] of this.#pending) {
          if (pending.rpcId === p.requestId) {
            this.#pending.delete(id);
            this.#emitItem({ ...pending.item, status: "resolved", decision: "cancel" });
          }
        }
        return;
      }

      case "error":
        if (!p.willRetry) this.#lastError = p.error?.message;
        return;

      case "turn/completed": {
        const runId = this.#runId;
        if (!runId || (this.#turnId && p.turn?.id !== this.#turnId)) return;
        this.#flushNow();
        this.#runId = undefined;
        this.#turnId = undefined;
        const status: string = p.turn?.status;
        const outcome =
          status === "interrupted" || this.#interruptRequested ? "interrupted" : status === "completed" ? "completed" : "failed";
        this.#emit({
          type: "turn.terminal",
          runId,
          outcome,
          error: outcome === "failed" ? (p.turn?.error?.message ?? this.#lastError ?? status) : undefined,
        });
        return;
      }
    }
  }

  #onItem(item: Json, completed: boolean) {
    if (!this.#runId) return;
    switch (item.type) {
      case "agentMessage":
      case "reasoning": {
        const kind = item.type === "agentMessage" ? "assistant_message" : "reasoning";
        const text: string =
          kind === "assistant_message" ? item.text : [...(item.summary ?? []), ...(item.content ?? [])].join("\n");
        if (!completed) return; // deltas carry the live text
        this.#streaming.delete(item.id);
        this.#dirty.delete(item.id);
        if (text) this.#emitItem({ ...this.#base(item.id), kind, text, streaming: false });
        return;
      }
      default: {
        const fields = toolFields(item);
        if (!fields) return; // userMessage (orchestrator records it), plan, compaction, …
        const id = `tool:${item.id}`;
        if (!completed) {
          this.#toolItems.set(item.id, { tool: fields.tool, input: fields.input });
          this.#emitItem({ ...this.#base(id), kind: "tool_call", tool: fields.tool, input: fields.input, status: "running" });
        } else {
          this.#toolItems.delete(item.id);
          this.#emitItem({
            ...this.#base(id),
            kind: "tool_call",
            tool: fields.tool,
            input: fields.input,
            status: fields.failed ? "failed" : "completed",
            output: fields.output !== undefined ? truncate(fields.output) : undefined,
          });
        }
      }
    }
  }

  // ---------- streaming (coalesced like the Claude adapter) ----------

  #appendStream(itemId: string, kind: StreamItem["kind"], delta: string) {
    if (!this.#runId || !delta) return;
    const prev = this.#streaming.get(itemId);
    this.#streaming.set(itemId, { ...this.#base(itemId), kind, text: (prev?.text ?? "") + delta, streaming: true });
    this.#dirty.add(itemId);
    this.#flushTimer ??= setTimeout(() => this.#flushNow(), STREAM_FLUSH_MS);
  }

  #flushNow() {
    if (this.#flushTimer) clearTimeout(this.#flushTimer);
    this.#flushTimer = undefined;
    for (const id of this.#dirty) {
      const item = this.#streaming.get(id);
      if (item) this.#emitItem(item);
    }
    this.#dirty.clear();
  }

  #emitItem(item: TurnItem) {
    this.#emit({ type: "turn_item.updated", item });
  }

  #base(id: string) {
    return { id, threadId: this.#threadId, runId: this.#runId ?? "unknown" };
  }
}

export const codexAdapter: ProviderAdapter = {
  kind: "codex",
  openSession: (input) => new CodexSession(input),
};
