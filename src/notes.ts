// Bullpen's own lines in a chat: notes (a branch was made, a pull request proposed, a progress update, a team
// update) and filling in an agent's reply. One place, so they all look and behave the same.

import { randomUUID } from "node:crypto";
import type { Store } from "./store.ts";
import type { TurnItem } from "./types.ts";

type Note = Extract<TurnItem, { kind: "note" }>;

/**
 * Post a note. It joins the chat's current turn when one is running (so it sits with that turn's steps), unless
 * `runId` says where it belongs (a team's notes go with its card).
 */
export function postNote(
  store: Store,
  threadId: string,
  text: string,
  opts: { runId?: string; progress?: boolean; team?: boolean; agentId?: string; action?: Note["action"] } = {},
): void {
  const id = randomUUID();
  const runId = opts.runId ?? store.getThread(threadId)?.activeRunId ?? `note:${id}`;
  const item: Note = { id: `note:${id}`, threadId, runId, kind: "note", text, ...opts };
  store.commit(threadId, [{ type: "turn-item.upserted", item }]);
}

/** Fill in an agent's reply (an @mention answer, a lead's message) once it's done. */
export function finishReply(store: Store, item: Extract<TurnItem, { kind: "agent_reply" }>, ok: boolean, text: string): void {
  const latest = store.getTurnItem(item.id);
  const base = latest?.kind === "agent_reply" ? latest : item;
  store.commit(item.threadId, [
    { type: "turn-item.upserted", item: { ...base, status: ok ? "completed" : "failed", text: text || "(no answer)", retry: undefined, activity: undefined } },
  ]);
}
