// What a run is doing right now, for live progress in the chat: how long it's been going, how many steps it has
// taken, and its latest step. Computed from the run's own items, so it's always current.

import type { Store } from "./store.ts";

export interface Activity {
  startedAt: string;
  /** Tool calls so far. */
  steps: number;
  /** The latest tool call (the UI words it, e.g. "Editing src/app.ts"). */
  last?: { tool: string; input: unknown; running: boolean };
  /** The agent's latest progress note (report_progress), if any. */
  note?: string;
}

export function runActivity(store: Store, threadId: string, runId: string, note?: string): Activity | undefined {
  const run = store.getRun(runId);
  if (!run) return undefined;
  let steps = 0;
  let last: Activity["last"];
  for (const item of store.listRunItems(threadId, runId)) {
    if (item.kind !== "tool_call" || item.parentId) continue;
    steps++;
    last = { tool: item.tool, input: compact(item.input), running: item.status === "running" };
  }
  return { startedAt: run.startedAt, steps, last, note };
}

/** Keep only what's needed to describe a step (no file contents). */
function compact(input: unknown): unknown {
  if (!input || typeof input !== "object") return input;
  const keep = ["command", "file_path", "notebook_path", "path", "pattern", "url", "query", "description", "target", "key", "title", "agent", "question", "thread", "message", "note"];
  const out: Record<string, unknown> = {};
  for (const k of keep) {
    const v = (input as Record<string, unknown>)[k];
    if (v !== undefined) out[k] = typeof v === "string" ? v.slice(0, 200) : v;
  }
  return out;
}

export const activitySig = (a: Activity | undefined) => (a ? `${a.steps}|${a.last?.tool}|${a.last?.running}|${a.note ?? ""}` : "");
