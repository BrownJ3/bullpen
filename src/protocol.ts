// Wire protocol between server and clients (T3: Effect RPC over WS; this is plain JSON).
//
// client -> server   { id, method, params }
// server -> client   { id, result } | { id, error }            (responses)
//                    { subscription, items: StoredEvent[] }      (pushes for subscribeThread)

import type { Agent, Command, Job, Lesson, Project, Run, StoredEvent, Thread, TurnItem } from "./types.ts";

export type Request =
  | { id: number; method: "dispatch"; params: Command }
  | { id: number; method: "listThreads"; params?: undefined }
  | { id: number; method: "listAgents"; params?: undefined }
  /** Ready-made agents to add with one click. */
  | { id: number; method: "listAgentTemplates"; params?: undefined }
  /** Folders to start work in: recently used ones first, then project folders found under ~. */
  | { id: number; method: "listProjects"; params?: undefined }
  | { id: number; method: "listDirs"; params: { path: string } }
  /** Stop the server (the web UI's "Stop server"). */
  | { id: number; method: "shutdown"; params?: undefined }
  /** Folders to offer in the import dialog (T3: AgentSessionScanner). */
  | { id: number; method: "importCandidates"; params?: undefined }
  /** A project folder's past Claude Code sessions, to resume one. */
  | { id: number; method: "pastSessions"; params: { path: string } }
  // ---- terminal drawer (shells live on the server and survive reloads) ----
  | { id: number; method: "terminal.list"; params: { threadId: string } }
  | { id: number; method: "terminal.open"; params: { threadId: string } }
  /** Replays recent output, then pushes { subscription, data } and { subscription, exitCode }. */
  | { id: number; method: "terminal.attach"; params: { terminalId: string } }
  | { id: number; method: "terminal.input"; params: { terminalId: string; data: string } }
  | { id: number; method: "terminal.resize"; params: { terminalId: string; cols: number; rows: number } }
  | { id: number; method: "terminal.close"; params: { terminalId: string } }
  // ---- file explorer (confined to the thread's project folder) ----
  | { id: number; method: "files.list"; params: { threadId: string; path: string } }
  | { id: number; method: "files.read"; params: { threadId: string; path: string } }
  | { id: number; method: "files.reveal"; params: { threadId: string; path: string; how: "reveal" | "open" } }
  /** For the Browser panel: running servers, dev scripts, and a static index.html if there is one. */
  | { id: number; method: "preview.info"; params: { threadId: string } }
  /** The Inbox: briefing since the last one (or the last day), plus everything waiting on the person. */
  | { id: number; method: "inbox"; params?: undefined }
  | { id: number; method: "teams"; params?: undefined }
  | { id: number; method: "worktreeStatus"; params: { threadId: string } }
  | { id: number; method: "browser.open"; params: { threadId: string; url: string } }
  | { id: number; method: "browser.frame"; params: { threadId: string } }
  | { id: number; method: "browser.input"; params: { threadId: string; event: unknown } }
  | { id: number; method: "browser.close"; params: { threadId: string } }
  | { id: number; method: "remote.info"; params?: undefined }
  | { id: number; method: "listEngines"; params?: undefined }
  | { id: number; method: "version"; params?: undefined }
  | { id: number; method: "update.run"; params?: undefined }
  | { id: number; method: "jobRuns"; params: { jobId: string } }
  | { id: number; method: "createFolder"; params: { parent: string; name: string; git: boolean } }
  /** Threads, agents and pending approvals, then live thread/agent/approval events across all threads. */
  | { id: number; method: "subscribeSidebar"; params?: undefined }
  | { id: number; method: "subscribeThread"; params: { threadId: string; afterSequence?: number } }
  | { id: number; method: "unsubscribe"; params: { subscription: number } }
  | { id: number; method: "getDiff"; params: { threadId: string; fromOrdinal: number; toOrdinal: number } };

export interface ThreadSnapshot {
  thread: Thread;
  runs: Run[];
  turnItems: TurnItem[];
  /** Resume live events after this sequence. */
  sequence: number;
}

export interface SidebarSnapshot {
  subscription: number;
  threads: Thread[];
  agents: Agent[];
  projects: Project[];
  jobs: Job[];
  lessons: Lesson[];
  settings: { briefingTime: string; briefingEnabled: boolean; notifications: boolean };
  pendingApprovals: TurnItem[];
}

export type SubscribeResult =
  | { subscription: number; mode: "snapshot"; snapshot: ThreadSnapshot }
  | { subscription: number; mode: "replay"; replayed: number };

export type Response = { id: number; result: unknown } | { id: number; error: string };
export type Push =
  | { subscription: number; items: StoredEvent[] }
  /** Terminal output / exit, for terminal.attach subscriptions. */
  | { subscription: number; data?: string; exitCode?: number };

export const DEFAULT_PORT = 4773;
