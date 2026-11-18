// Shared vocabulary. Mirrors T3 Code's split:
//   - provider adapters emit AdapterEvents (normalized from each agent's native protocol)
//   - the orchestrator turns them into DomainEvents (full-row upserts) stored in SQLite
//   - clients read projections (Thread, Run, TurnItem) + live DomainEvents

export type RuntimeMode = "approval-required" | "auto-accept-edits" | "full-access";
export type Decision = "accept" | "acceptForSession" | "decline" | "cancel";

// ---------- Projections ----------

export interface Thread {
  id: string;
  title: string;
  cwd: string;
  provider: string;
  runtimeMode: RuntimeMode;
  model?: string;
  /** The agent's own session id. App ids are primary; this is only a ref used to resume. */
  nativeSessionId?: string;
  /** Set when this is a named agent's home thread (its long-lived conversation). */
  agentId?: string;
  status: "idle" | "running";
  activeRunId?: string;
  runCount: number;
  createdAt: string;
  /** Last time anything happened (a message, a finished run); sidebar ordering. */
  updatedAt?: string;
  /** A team is working on a goal started in this thread (for sidebar status). */
  team?: { active: number; needsYou: number };
  /** Set when this thread continues a session started outside Bullpen (e.g. in Claude Code). */
  importedFrom?: { tool: "claude"; title: string; at: string };
}

/** A folder you work in (T3: OrchestrationProjectShell). Threads belong to the project at their cwd. */
export interface Project {
  id: string;
  path: string;
  title: string;
  pinnedAt?: string;
  /** Hidden from the sidebar (T3: archivedAt). Threads and files are kept. */
  archivedAt?: string;
  createdAt: string;
  /** Last time you worked here outside Bullpen (newest Claude Code session), for ordering. */
  lastUsedAt?: string;
}

export interface Run {
  id: string;
  threadId: string;
  ordinal: number; // 1-based, = "turn N"
  status: "running" | "completed" | "interrupted" | "failed";
  error?: string;
  costUsd?: number;
  startedAt: string;
  endedAt?: string;
}

interface TurnItemBase {
  id: string;
  threadId: string;
  runId: string;
}

/** One ordered, upsertable unit of what happened in a turn (T3: OrchestrationV2TurnItem). */
export type TurnItem = TurnItemBase &
  (
    | { kind: "user_message"; text: string }
    | { kind: "assistant_message"; text: string; streaming: boolean }
    | { kind: "reasoning"; text: string; streaming: boolean }
    | {
        kind: "tool_call";
        tool: string;
        input: unknown;
        status: "running" | "completed" | "failed";
        output?: string;
      }
    | {
        kind: "approval_request";
        requestId: string;
        tool: string;
        input: unknown;
        status: "pending" | "resolved";
        decision?: Decision;
      }
    | { kind: "checkpoint"; ordinal: number; ref: string; filesChanged: number }
    | {
        /** A named agent's answer, brought into this thread by an @mention. */
        kind: "agent_reply";
        agentId: string;
        agentName: string;
        status: "running" | "completed" | "failed";
        text: string;
        /** Passed to this thread's own agent at the start of its next turn. */
        delivered: boolean;
      }
    | { kind: "error"; message: string }
    | ({ kind: "team_goal" } & GoalCard)
  );

/**
 * A named, long-running agent: its own instructions, provider and model, and a home thread
 * whose native session carries its context across every conversation it is pulled into.
 */
export interface Agent {
  id: string;
  /** Lowercase handle used in @mentions and ask_agent (made from the display name). */
  name: string;
  /** What you call it: any text. Older agents may not have one; show "@name" then. */
  displayName?: string;
  /** The ready-made agent it was created from, if any. */
  templateId?: string;
  /** May start team goals: hand tracked tasks to other agents and review them. */
  canLead?: boolean;
  description: string;
  instructions: string;
  provider: string;
  model?: string;
  /** The agent's own folder (~/.bullpen/agents/<name>): its memory and scratch space. */
  cwd: string;
  runtimeMode: RuntimeMode;
  homeThreadId: string;
  createdAt: string;
  updatedAt: string;
}

// ---------- Teams (modeled on AgentOffice: delegate → submit → one-round review → report) ----------

export type GoalStatus = "planning" | "working" | "paused" | "stuck" | "done" | "cancelled" | "failed";
export type TaskStatus =
  | "queued" // ready, waiting for a free slot or for its agent
  | "waiting" // depends on tasks that aren't accepted yet
  | "working"
  | "submitted" // waiting for the lead's review
  | "changes" // sent back once, being reworked
  | "accepted"
  | "parked" // failed twice; needs a decision (Retry, or the lead reassigns)
  | "paused" // usage limit hit; resumes on its own
  | "cancelled";

export interface Goal {
  id: string;
  /** The thread it was started from; the team card and the final report live there. */
  threadId: string;
  project: string;
  leadAgentId: string;
  title: string;
  /** What the person asked for, verbatim. */
  request: string;
  status: GoalStatus;
  /** Lead turns so far (guardrail). */
  leadTurns: number;
  report?: string;
  note?: string;
  /** When a paused goal will try again. */
  resumeAt?: string;
  createdAt: string;
  updatedAt: string;
  endedAt?: string;
}

export interface TeamTask {
  id: string;
  goalId: string;
  /** "T1", "T2"… short handle the lead and the UI use. */
  ref: string;
  agentId: string;
  title: string;
  brief: string;
  deliverable: string;
  /** Files or folders this task may change; shown to the agent so parallel work doesn't collide. */
  files?: string;
  dependsOn: string[]; // task ids
  /** Accept on submission without a lead review turn (routine work; the lead sees it at the end). */
  autoAccept?: boolean;
  status: TaskStatus;
  attempts: number;
  /** 0 = first submission; 1 = after being sent back once (one-round review). */
  round: number;
  result?: string;
  reviewNotes?: string;
  filesTouched?: string[];
  error?: string;
  /** The agent's home thread + run doing the work right now. */
  runThreadId?: string;
  runId?: string;
  resumeAt?: string;
  createdAt: string;
  startedAt?: string;
  endedAt?: string;
}

/** What the team card in a thread shows (a full snapshot, upserted on every change). */
export interface GoalCard {
  goalId: string;
  title: string;
  status: GoalStatus;
  leadAgentId: string;
  leadName: string;
  note?: string;
  resumeAt?: string;
  startedAt: string;
  endedAt?: string;
  tasks: Array<{
    id: string;
    ref: string;
    agentId: string;
    agentName: string;
    title: string;
    status: TaskStatus;
    autoAccept?: boolean;
    dependsOn: string[]; // refs
    summary?: string;
    reviewNotes?: string;
    filesTouched?: string[];
    error?: string;
    round: number;
    startedAt?: string;
    endedAt?: string;
    runThreadId?: string;
    approvals: Array<{ requestId: string; threadId: string; tool: string; input: unknown }>;
  }>;
}

export interface Checkpoint {
  threadId: string;
  ordinal: number; // 0 = baseline before turn 1, N = after turn N
  ref: string;
  commit: string;
  capturedAt: string;
}

// ---------- Domain events (persisted, streamed to clients) ----------

export type DomainEvent =
  | { type: "thread.upserted"; thread: Thread }
  | { type: "run.upserted"; run: Run }
  | { type: "turn-item.upserted"; item: TurnItem }
  | { type: "checkpoint.captured"; checkpoint: Checkpoint }
  | { type: "agent.upserted"; agent: Agent }
  | { type: "agent.deleted"; agentId: string }
  | { type: "project.upserted"; project: Project }
  | { type: "goal.upserted"; goal: Goal }
  | { type: "task.upserted"; task: TeamTask }
  | { type: "project.removed"; projectId: string };

export interface StoredEvent {
  sequence: number;
  threadId: string;
  event: DomainEvent;
}

// ---------- Commands (client -> server) ----------

export type Command =
  | {
      type: "thread.create";
      cwd: string;
      provider?: string;
      title?: string;
      runtimeMode?: RuntimeMode;
      model?: string;
      /** Continue this Claude Code session instead of starting a new conversation. */
      resumeClaudeSession?: { id: string; title: string; updatedAt: string };
    }
  | { type: "project.add"; path: string; title?: string }
  | { type: "project.import"; projects: Array<{ path: string; lastUsedAt?: string }> }
  | { type: "project.update"; projectId: string; title?: string; pinned?: boolean; archived?: boolean }
  /** Show/hide many projects at once (the project manager dialog). */
  | { type: "project.bulk"; archive: string[]; unarchive: string[] }
  /** Removes it from the sidebar; its threads and files are kept. */
  | { type: "project.remove"; projectId: string }
  /** Stop a team: interrupts running tasks and cancels the rest. */
  | { type: "goal.cancel"; goalId: string }
  /** Try a parked or paused task again. */
  | { type: "task.retry"; taskId: string }
  | { type: "message.send"; threadId: string; text: string }
  | { type: "run.interrupt"; threadId: string }
  | { type: "runtime-request.respond"; threadId: string; requestId: string; decision: Decision }
  | { type: "checkpoint.rollback"; threadId: string; ordinal: number }
  | {
      type: "agent.create";
      /** Display name: anything. */
      name: string;
      /** @handle for mentions; made from the name when omitted. */
      handle?: string;
      templateId?: string;
      canLead?: boolean;
      description?: string;
      instructions: string;
      provider?: string;
      model?: string;
      runtimeMode?: RuntimeMode;
    }
  | {
      type: "agent.update";
      agentId: string;
      displayName?: string;
      handle?: string;
      canLead?: boolean;
      description?: string;
      instructions?: string;
      model?: string;
      runtimeMode?: RuntimeMode;
    }
  /** Start the agent's conversation over (keeps its settings and visible history). */
  | { type: "agent.reset"; agentId: string }
  /** Removes the agent; its home thread stays as an ordinary thread. */
  | { type: "agent.delete"; agentId: string };

// ---------- Provider adapter contract (T3: ProviderAdapterV2) ----------

export type AdapterEvent =
  | { type: "native_session.updated"; nativeSessionId: string }
  | { type: "turn_item.updated"; item: TurnItem }
  | {
      type: "turn.terminal";
      runId: string;
      outcome: "completed" | "interrupted" | "failed";
      error?: string;
      costUsd?: number;
    };

/**
 * A tool the harness itself provides to the agent (T3 does this with its /mcp server).
 * Parameters are all strings to keep the adapters' schema conversion trivial.
 */
export interface HarnessTool {
  name: string;
  description: string;
  params: Record<string, { description: string; optional?: boolean }>;
  run(args: Record<string, string>): Promise<{ text: string; isError?: boolean }>;
}

export interface OpenSessionInput {
  threadId: string;
  cwd: string;
  runtimeMode: RuntimeMode;
  model?: string;
  resumeNativeSessionId?: string;
  /** Extra system/developer instructions (a named agent's prompt). */
  instructions?: string;
  tools?: HarnessTool[];
  emit: (event: AdapterEvent) => void;
}

export interface ProviderSession {
  /** `workdir`: the project to work in this turn, when it isn't the session's own folder. */
  /** `team`: a team task, so edits inside the project and safe commands run without asking. */
  startTurn(input: { runId: string; text: string; workdir?: string; team?: boolean }): void;
  interruptTurn(): Promise<void>;
  respondToRuntimeRequest(requestId: string, decision: Decision): boolean;
  close(): void;
}

export interface ProviderAdapter {
  readonly kind: string;
  openSession(input: OpenSessionInput): ProviderSession;
}
