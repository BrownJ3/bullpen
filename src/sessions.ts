// Past Claude Code and Codex sessions (T3: AgentSessionScanner + external session imports): find them per folder and
// read their recent conversation, so an imported thread shows its history and continues the same session.
//
// Session files can be huge (100 MB+), so only the end of a file is read: enough for the last few hundred items.

import { existsSync, readdirSync, statSync } from "node:fs";
import { clipOutput, readRange, unescapeJson } from "./util.ts";
import { homedir } from "node:os";
import { join } from "node:path";

const HOME = homedir(); // the user's home, where Claude Code and Codex keep sessions
const TAIL_BYTES = 8 * 1024 * 1024;
const MAX_ITEMS = 400;
const MAX_TEXT = 20_000;
const MAX_OUTPUT = 2_000;

export interface PastSession {
  tool: "claude" | "codex";
  id: string;
  title: string;
  updatedAt: string;
  sizeKb: number;
  file: string;
  /** The model it was last using (Codex records it), so the thread keeps using it. */
  model?: string;
}

/** What an imported thread shows: the conversation, with tool calls summarised. */
export type HistoryItem =
  | { kind: "user_message"; text: string }
  | { kind: "assistant_message"; text: string }
  | { kind: "tool_call"; tool: string; input: unknown; output?: string; failed?: boolean };


/** Parsed JSON lines from the end of a file (the first, partial line dropped when it starts mid-file). */
function tailLines(file: string): { lines: any[]; truncated: boolean } {
  const size = statSync(file).size;
  const from = Math.max(0, size - TAIL_BYTES);
  let text = readRange(file, from, size - from);
  if (from > 0) text = text.slice(text.indexOf("\n") + 1);
  const lines: any[] = [];
  for (const l of text.split("\n")) {
    if (!l) continue;
    try {
      lines.push(JSON.parse(l));
    } catch {}
  }
  return { lines, truncated: from > 0 };
}

const clip = clipOutput;
/** Text the tools inject into "user" turns (system reminders, notifications, skill bodies), not things you typed. */
const injected = (t: string) =>
  /^\s*</.test(t) || /^(Base directory for this skill|Caveat: The messages below|Context handoff|\[Historical user;|This session is being continued)/.test(t.trim());

// ---------------------------------------------------------------- Claude Code

function claudeDir(path: string): string {
  return join(HOME, ".claude", "projects", path.replace(/[^a-zA-Z0-9]/g, "-"));
}

export function claudeSessions(path: string, limit = 30): PastSession[] {
  const dir = claudeDir(path);
  let files: string[];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith(".jsonl"));
  } catch {
    return [];
  }
  return files
    .map((f) => ({ f, st: statSync(join(dir, f)) }))
    .sort((a, b) => b.st.mtimeMs - a.st.mtimeMs)
    .slice(0, limit)
    .flatMap(({ f, st }) => {
      const file = join(dir, f);
      const tail = readRange(file, Math.max(0, st.size - 256 * 1024), Math.min(st.size, 256 * 1024));
      const head = readRange(file, 0, Math.min(st.size, 256 * 1024));
      // The folder name is lossy; check the session really ran here.
      const cwd = head.match(/"cwd":"((?:[^"\\]|\\.)*)"/)?.[1];
      if (cwd && unescapeJson(cwd) !== path) return [];
      const custom = [...tail.matchAll(/"customTitle":"((?:[^"\\]|\\.)*)"/g)].at(-1)?.[1] ?? [...tail.matchAll(/"type":"ai-title"[^}]*"title":"((?:[^"\\]|\\.)*)"/g)].at(-1)?.[1];
      let first: string | undefined;
      for (const l of head.split("\n")) {
        let x: any;
        try {
          x = JSON.parse(l);
        } catch {
          continue;
        }
        if (x.type !== "user" || x.isMeta || x.isSidechain) continue;
        const c = x.message?.content;
        const t = typeof c === "string" ? c : Array.isArray(c) ? c.filter((b: any) => b.type === "text").map((b: any) => b.text).join(" ") : "";
        if (t.trim() && !injected(t)) {
          first = t;
          break;
        }
      }
      const title = (custom ? unescapeJson(custom) : first) ?? "Claude Code session";
      return [{ tool: "claude" as const, id: f.replace(/\.jsonl$/, ""), title: title.replace(/\s+/g, " ").slice(0, 90), updatedAt: st.mtime.toISOString(), sizeKb: Math.round(st.size / 1024), file }];
    });
}

function claudeHistory(file: string): { items: HistoryItem[]; truncated: boolean } {
  const { lines, truncated } = tailLines(file);
  const items: HistoryItem[] = [];
  const tools = new Map<string, Extract<HistoryItem, { kind: "tool_call" }>>();
  for (const x of lines) {
    if ((x.type !== "user" && x.type !== "assistant") || x.isSidechain || x.isMeta) continue;
    const c = x.message?.content;
    if (x.type === "user") {
      if (typeof c === "string") {
        if (!injected(c)) items.push({ kind: "user_message", text: clip(c, MAX_TEXT) });
        continue;
      }
      for (const b of Array.isArray(c) ? c : []) {
        if (b.type === "text" && !injected(b.text ?? "")) items.push({ kind: "user_message", text: clip(b.text, MAX_TEXT) });
        if (b.type === "tool_result") {
          const t = tools.get(b.tool_use_id);
          if (t) {
            const out = typeof b.content === "string" ? b.content : (b.content ?? []).map((p: any) => p.text ?? "").join("\n");
            t.output = clip(out, MAX_OUTPUT);
            t.failed = Boolean(b.is_error);
          }
        }
      }
    } else {
      for (const b of Array.isArray(c) ? c : []) {
        if (b.type === "text" && b.text?.trim()) {
          const prev = items.at(-1);
          // Streaming writes the same message in several lines; merge consecutive text from one message.
          if (prev?.kind === "assistant_message" && (prev as any)._id === x.message?.id) prev.text += `\n\n${b.text}`;
          else items.push(Object.assign({ kind: "assistant_message" as const, text: clip(b.text, MAX_TEXT) }, { _id: x.message?.id }));
        }
        if (b.type === "tool_use") {
          const t = { kind: "tool_call" as const, tool: String(b.name), input: b.input };
          tools.set(b.id, t);
          items.push(t);
        }
      }
    }
  }
  return { items: items.slice(-MAX_ITEMS).map(({ _id, ...i }: any) => i), truncated: truncated || items.length > MAX_ITEMS };
}

// ---------------------------------------------------------------- Codex

export function codexFiles(): string[] {
  const root = join(process.env.CODEX_HOME ?? join(HOME, ".codex"), "sessions");
  const out: string[] = [];
  const walk = (dir: string, depth: number) => {
    let names: string[];
    try {
      names = readdirSync(dir).sort().reverse();
    } catch {
      return;
    }
    for (const n of names) {
      if (out.length >= 3000) return;
      if (depth < 3) walk(join(dir, n), depth + 1);
      else if (n.endsWith(".jsonl")) out.push(join(dir, n));
    }
  };
  walk(root, 0);
  return out;
}

export function codexSessions(path: string, limit = 30): PastSession[] {
  const out: PastSession[] = [];
  for (const file of codexFiles()) {
    if (out.length >= limit) break;
    const head = readRange(file, 0, 64 * 1024);
    let meta: any;
    try {
      meta = JSON.parse(head.slice(0, head.indexOf("\n")));
    } catch {
      continue;
    }
    if (meta?.type !== "session_meta" || meta.payload?.cwd !== path) continue;
    const st = statSync(file);
    const tail = readRange(file, Math.max(0, st.size - 512 * 1024), Math.min(st.size, 512 * 1024));
    const model = [...tail.matchAll(/"type":"turn_context","payload":\{[^\n]*?"model":"([^"]+)"/g)].at(-1)?.[1] ?? [...head.matchAll(/"model":"([^"]+)"/g)].at(-1)?.[1];
    let first: string | undefined;
    for (const l of readRange(file, 0, 512 * 1024).split("\n")) {
      let x: any;
      try {
        x = JSON.parse(l);
      } catch {
        continue;
      }
      if (x.type === "event_msg" && x.payload?.type === "user_message" && x.payload.message && !injected(x.payload.message)) first = x.payload.message;
      else if (x.type === "response_item" && x.payload?.role === "user") {
        const t = (x.payload.content ?? []).map((c: any) => c.text ?? "").join("");
        if (t.trim() && !injected(t)) first = t;
      }
      if (first) break;
    }
    out.push({
      tool: "codex",
      id: String(meta.payload.id ?? meta.payload.session_id),
      title: (first ?? "Codex session").replace(/\s+/g, " ").slice(0, 90),
      updatedAt: st.mtime.toISOString(),
      sizeKb: Math.round(st.size / 1024),
      file,
      model,
    });
  }
  return out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

function codexHistory(file: string): { items: HistoryItem[]; truncated: boolean } {
  const { lines, truncated } = tailLines(file);
  const items: HistoryItem[] = [];
  const calls = new Map<string, Extract<HistoryItem, { kind: "tool_call" }>>();
  for (const x of lines) {
    if (x.type !== "response_item") continue;
    const p = x.payload ?? {};
    if (p.type === "message" && (p.role === "user" || p.role === "assistant")) {
      const text = (p.content ?? []).map((c: any) => c.text ?? "").join("");
      if (!text.trim() || (p.role === "user" && injected(text))) continue;
      items.push({ kind: p.role === "user" ? "user_message" : "assistant_message", text: clip(text, MAX_TEXT) });
    } else if (p.type === "function_call" || p.type === "custom_tool_call") {
      let input: unknown = p.arguments ?? p.input;
      try {
        if (typeof input === "string") input = JSON.parse(input);
      } catch {}
      const cmd = (input as any)?.cmd ?? (input as any)?.command;
      const t = { kind: "tool_call" as const, tool: cmd ? "shell" : String(p.name), input: cmd ? { command: Array.isArray(cmd) ? cmd.join(" ") : cmd } : input };
      calls.set(p.call_id ?? p.id, t);
      items.push(t);
    } else if (p.type === "function_call_output" || p.type === "custom_tool_call_output") {
      const t = calls.get(p.call_id);
      if (t) t.output = clip(typeof p.output === "string" ? p.output : JSON.stringify(p.output), MAX_OUTPUT);
    }
  }
  return { items: items.slice(-MAX_ITEMS), truncated: truncated || items.length > MAX_ITEMS };
}

// ---------------------------------------------------------------- both

export function pastSessions(path: string, limit = 20): PastSession[] {
  return [...claudeSessions(path, limit), ...codexSessions(path, limit)].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, limit);
}

export function findSession(tool: "claude" | "codex", id: string, path: string): PastSession | undefined {
  return (tool === "claude" ? claudeSessions(path, 500) : codexSessions(path, 500)).find((s) => s.id === id);
}

export function sessionHistory(s: PastSession): { items: HistoryItem[]; truncated: boolean } {
  if (!existsSync(s.file)) return { items: [], truncated: false };
  return s.tool === "claude" ? claudeHistory(s.file) : codexHistory(s.file);
}
