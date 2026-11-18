// Claude Code provider, driven through the Claude Agent SDK (same approach as T3's ClaudeAdapterV2).
// One long-lived query() per thread, fed by a streaming-input queue so follow-up turns,
// interrupts and permission prompts all go through the same live session.

import {
  createSdkMcpServer,
  query,
  tool,
  type Options,
  type PermissionMode,
  type PermissionResult,
  type Query,
  type SDKMessage,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { resolve, sep } from "node:path";
import { EDIT_TOOLS, isSafeCommand } from "../team-policy.ts";
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

const STREAM_FLUSH_MS = 50; // T3 coalesces live deltas at 50ms too
const MAX_TOOL_OUTPUT = 4000;

function permissionModeFor(mode: RuntimeMode): PermissionMode {
  switch (mode) {
    case "approval-required":
      return "default";
    case "auto-accept-edits":
      return "acceptEdits";
    case "full-access":
      return "bypassPermissions";
  }
}

/** Harness tools → an in-process MCP server named "harness" (tools appear as mcp__harness__<name>). */
function harnessMcp(tools: HarnessTool[]) {
  return createSdkMcpServer({
    name: "harness",
    version: "0.1.0",
    alwaysLoad: true,
    tools: tools.map((t) => {
      const shape: Record<string, z.ZodType<string | undefined>> = {};
      for (const [key, p] of Object.entries(t.params)) {
        shape[key] = p.optional ? z.string().optional().describe(p.description) : z.string().describe(p.description);
      }
      return tool(t.name, t.description, shape, async (args) => {
        const res = await t.run(args as Record<string, string>);
        return { content: [{ type: "text" as const, text: res.text }], isError: res.isError };
      });
    }),
  });
}

/** Minimal async queue used as the SDK's streaming prompt input. */
class InputQueue implements AsyncIterable<SDKUserMessage> {
  #items: SDKUserMessage[] = [];
  #waiters: Array<(r: IteratorResult<SDKUserMessage>) => void> = [];
  #closed = false;

  push(item: SDKUserMessage) {
    const waiter = this.#waiters.shift();
    if (waiter) waiter({ value: item, done: false });
    else this.#items.push(item);
  }

  close() {
    this.#closed = true;
    for (const w of this.#waiters.splice(0)) w({ value: undefined, done: true });
  }

  [Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
    return {
      next: () => {
        const item = this.#items.shift();
        if (item) return Promise.resolve({ value: item, done: false });
        if (this.#closed) return Promise.resolve({ value: undefined, done: true });
        return new Promise((resolve) => this.#waiters.push(resolve));
      },
    };
  }
}

function truncate(text: string): string {
  return text.length > MAX_TOOL_OUTPUT ? `${text.slice(0, MAX_TOOL_OUTPUT)}\n…[truncated]` : text;
}

function toolResultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((b) => (b && typeof b === "object" && "text" in b ? String(b.text) : ""))
      .join("\n");
  }
  return JSON.stringify(content);
}

class ClaudeSession implements ProviderSession {
  #input!: InputQueue;
  #query!: Query;
  readonly #options: Options;
  readonly #cwd: string;
  readonly #baseMode: PermissionMode;
  /** The current turn is a team task: edits in the project and safe commands don't need approval. */
  #teamTurn = false;
  readonly #ownFolder: string | undefined;
  #sessionId: string | undefined;
  /** Project folder added for the current turn (consults run in the caller's project). */
  #extraDir: string | undefined;
  readonly #emit: (e: AdapterEvent) => void;
  readonly #threadId: string;

  #runId: string | undefined;
  #interruptRequested = false;
  /** Parked permission prompts: the agent is blocked until the user answers (T3 parks a Deferred). */
  readonly #pending = new Map<
    string,
    { resolve: (d: Decision) => void; item: Extract<TurnItem, { kind: "approval_request" }> }
  >();

  // Streaming state: items being built from stream_event deltas.
  readonly #streaming = new Map<string, Extract<TurnItem, { kind: "assistant_message" | "reasoning" }>>();
  readonly #dirty = new Set<string>();
  /** Tool calls awaiting their result, so the completed upsert keeps name + input. */
  readonly #tools = new Map<string, { tool: string; input: unknown }>();
  #flushTimer: NodeJS.Timeout | undefined;
  #currentMessageId: string | undefined;
  #lastBlockIndex = 0;

  constructor(input: OpenSessionInput) {
    this.#emit = input.emit;
    this.#threadId = input.threadId;
    this.#cwd = input.cwd;
    this.#baseMode = permissionModeFor(input.runtimeMode);
    this.#ownFolder = input.ownFolder;
    this.#sessionId = input.resumeNativeSessionId;
    this.#options = {
      cwd: input.cwd,
      model: input.model,
      permissionMode: permissionModeFor(input.runtimeMode),
      includePartialMessages: true,
      systemPrompt: input.instructions
        ? { type: "preset", preset: "claude_code", append: input.instructions }
        : undefined,
      ...(input.tools?.length
        ? {
            mcpServers: { harness: harnessMcp(input.tools) },
            // The harness's own tools never need an approval prompt.
            allowedTools: input.tools.map((t) => `mcp__harness__${t.name}`),
          }
        : {}),
      canUseTool: (toolName, toolInput, { signal, suggestions }) =>
        this.#teamAllows(toolName, toolInput)
          ? Promise.resolve<PermissionResult>({ behavior: "allow", updatedInput: toolInput })
          : this.#askPermission(toolName, toolInput, signal).then((decision): PermissionResult => {
          switch (decision) {
            case "accept":
              return { behavior: "allow", updatedInput: toolInput };
            case "acceptForSession":
              return { behavior: "allow", updatedInput: toolInput, updatedPermissions: suggestions };
            case "decline":
              return { behavior: "deny", message: "The user declined this tool call." };
            case "cancel":
              return { behavior: "deny", message: "The user cancelled the turn.", interrupt: true };
          }
        }),
    };
    this.#open();
  }

  /**
   * (Re)start the SDK query. The session's cwd never changes (Claude keys saved conversations by
   * folder); a project it's working in for a turn is added as an extra directory instead.
   */
  #open() {
    this.#input = new InputQueue();
    this.#query = query({
      prompt: this.#input,
      options: {
        ...this.#options,
        resume: this.#sessionId,
        additionalDirectories: this.#extraDir ? [this.#extraDir] : undefined,
      },
    });
    void this.#pump(this.#query);
  }

  startTurn({ runId, text, workdir, team }: { runId: string; text: string; workdir?: string; team?: boolean }) {
    const extra = workdir && workdir !== this.#cwd ? workdir : undefined;
    if (extra !== this.#extraDir) {
      // Between turns, so nothing is in flight: reopen on the same conversation with the new folder.
      this.#extraDir = extra;
      this.#input.close();
      this.#query.close();
      this.#open();
    }
    this.#runId = runId;
    this.#interruptRequested = false;
    const wasTeam = this.#teamTurn;
    this.#teamTurn = Boolean(team);
    const push = () =>
      this.#input.push({
        type: "user",
        message: { role: "user", content: text },
        parent_tool_use_id: null,
      } as SDKUserMessage);
    // Team tasks auto-accept file edits; other turns go back to the agent's own setting.
    const want: PermissionMode = this.#teamTurn && this.#baseMode === "default" ? "acceptEdits" : this.#baseMode;
    if (this.#teamTurn !== wasTeam || want !== this.#baseMode) {
      this.#query.setPermissionMode(want).then(push, push);
    } else {
      push();
    }
  }

  /** Team mode: edits inside the project folder and read-only/test/build commands run without asking. */
  #teamAllows(tool: string, input: Record<string, unknown>): boolean {
    // An agent's own folder (its MEMORY.md and scratch files) is always writable without asking.
    if (this.#ownFolder && EDIT_TOOLS.has(tool)) {
      const target = String(input.file_path ?? input.notebook_path ?? "");
      const abs = target ? resolve(this.#ownFolder, target) : "";
      if (abs && abs.startsWith(this.#ownFolder + sep)) return true;
    }
    if (process.env.BULLPEN_DEBUG) console.error(`[team] ${tool} team=${this.#teamTurn} root=${this.#extraDir ?? this.#cwd} input=${JSON.stringify(input).slice(0, 120)}`);
    if (!this.#teamTurn) return false;
    if (tool === "Bash") return isSafeCommand(input.command);
    if (EDIT_TOOLS.has(tool)) {
      const target = String(input.file_path ?? input.notebook_path ?? "");
      const root = this.#extraDir ?? this.#cwd;
      const abs = resolve(root, target);
      return Boolean(target) && (abs === root || abs.startsWith(root + sep));
    }
    return ["Read", "Glob", "Grep", "LS", "TodoWrite"].includes(tool);
  }

  async interruptTurn() {
    if (!this.#runId) return;
    this.#interruptRequested = true;
    for (const id of [...this.#pending.keys()]) this.respondToRuntimeRequest(id, "cancel");
    await this.#query.interrupt();
  }

  respondToRuntimeRequest(requestId: string, decision: Decision): boolean {
    const pending = this.#pending.get(requestId);
    if (!pending) return false;
    this.#pending.delete(requestId);
    this.#emitItem({ ...pending.item, status: "resolved", decision });
    pending.resolve(decision);
    return true;
  }

  close() {
    for (const id of [...this.#pending.keys()]) this.respondToRuntimeRequest(id, "cancel");
    this.#input.close();
    this.#query.close();
  }

  // ---------------------------------------------------------------------------

  #askPermission(tool: string, input: Record<string, unknown>, signal: AbortSignal): Promise<Decision> {
    const requestId = randomUUID();
    const item: Extract<TurnItem, { kind: "approval_request" }> = {
      id: `approval:${requestId}`,
      threadId: this.#threadId,
      runId: this.#runId ?? "unknown",
      kind: "approval_request",
      requestId,
      tool,
      input,
      status: "pending",
    };
    return new Promise<Decision>((resolve) => {
      this.#pending.set(requestId, { resolve, item });
      signal.addEventListener("abort", () => this.respondToRuntimeRequest(requestId, "cancel"), { once: true });
      this.#emitItem(item);
    });
  }

  #emitItem(item: TurnItem) {
    this.#emit({ type: "turn_item.updated", item });
  }

  #base(id: string) {
    return { id, threadId: this.#threadId, runId: this.#runId ?? "unknown" };
  }

  #scheduleFlush() {
    if (this.#flushTimer) return;
    this.#flushTimer = setTimeout(() => {
      this.#flushTimer = undefined;
      for (const id of this.#dirty) {
        const item = this.#streaming.get(id);
        if (item) this.#emitItem(item);
      }
      this.#dirty.clear();
    }, STREAM_FLUSH_MS);
  }

  async #pump(q: Query) {
    try {
      for await (const message of q) this.#handle(message);
    } catch (err) {
      if (q === this.#query && this.#runId) {
        this.#emit({ type: "turn.terminal", runId: this.#runId, outcome: "failed", error: String(err) });
        this.#runId = undefined;
      }
    }
  }

  #handle(message: SDKMessage) {
    switch (message.type) {
      case "system":
        if (message.subtype === "init") {
          this.#sessionId = message.session_id;
          this.#emit({ type: "native_session.updated", nativeSessionId: message.session_id });
        }
        return;

      case "stream_event": {
        if (message.parent_tool_use_id) return; // subagent internals: skip in this minimal harness
        const ev = message.event;
        if (ev.type === "message_start") {
          this.#currentMessageId = ev.message.id;
        } else if (ev.type === "content_block_start") {
          this.#lastBlockIndex = ev.index;
        } else if (ev.type === "content_block_delta") {
          const id = `${this.#currentMessageId}:${ev.index}`;
          if (ev.delta.type === "text_delta") {
            const prev = this.#streaming.get(id);
            this.#streaming.set(id, {
              ...this.#base(id),
              kind: "assistant_message",
              text: (prev?.text ?? "") + ev.delta.text,
              streaming: true,
            });
          } else if (ev.delta.type === "thinking_delta") {
            const prev = this.#streaming.get(id);
            this.#streaming.set(id, {
              ...this.#base(id),
              kind: "reasoning",
              text: (prev?.text ?? "") + ev.delta.thinking,
              streaming: true,
            });
          } else {
            return;
          }
          this.#dirty.add(id);
          this.#scheduleFlush();
        }
        return;
      }

      case "assistant": {
        if (message.parent_tool_use_id) return;
        const blocks = message.message.content;
        blocks.forEach((block, i) => {
          // With partial messages on, each assistant frame usually carries the one block that just finished.
          const index = blocks.length === 1 ? this.#lastBlockIndex : i;
          const id = `${message.message.id}:${index}`;
          if (block.type === "text") {
            this.#streaming.delete(id);
            this.#dirty.delete(id);
            this.#emitItem({ ...this.#base(id), kind: "assistant_message", text: block.text, streaming: false });
          } else if (block.type === "thinking") {
            const streamed = this.#streaming.get(id);
            this.#streaming.delete(id);
            this.#dirty.delete(id);
            const text = block.thinking || streamed?.text || "";
            if (text) this.#emitItem({ ...this.#base(id), kind: "reasoning", text, streaming: false });
          } else if (block.type === "tool_use") {
            const tool = { tool: block.name, input: block.input };
            this.#tools.set(`tool:${block.id}`, tool);
            this.#emitItem({ ...this.#base(`tool:${block.id}`), kind: "tool_call", ...tool, status: "running" });
          }
        });
        return;
      }

      case "user": {
        if (message.parent_tool_use_id) return;
        const content = message.message.content;
        if (!Array.isArray(content)) return;
        for (const block of content) {
          if (block.type !== "tool_result") continue;
          const id = `tool:${block.tool_use_id}`;
          const started = this.#tools.get(id);
          this.#tools.delete(id);
          this.#emitItem({
            ...this.#base(id),
            kind: "tool_call",
            tool: started?.tool ?? "unknown",
            input: started?.input,
            status: block.is_error ? "failed" : "completed",
            output: truncate(toolResultText(block.content)),
          });
        }
        return;
      }

      case "result": {
        const runId = this.#runId;
        if (!runId) return;
        this.#runId = undefined;
        const outcome = this.#interruptRequested
          ? "interrupted"
          : message.subtype === "success" && !message.is_error
            ? "completed"
            : "failed";
        this.#emit({
          type: "turn.terminal",
          runId,
          outcome,
          costUsd: message.total_cost_usd,
          error: outcome === "failed" ? (message.subtype === "success" ? message.result : message.subtype) : undefined,
        });
        return;
      }
    }
  }
}

export const claudeAdapter: ProviderAdapter = {
  kind: "claude",
  openSession: (input) => new ClaudeSession(input),
};
