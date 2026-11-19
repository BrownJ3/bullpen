// Shared vocabulary. Mirrors T3 Code's split:
//   - provider adapters emit AdapterEvents (normalized from each agent's native protocol)
//   - the orchestrator turns them into DomainEvents (full-row upserts) stored in SQLite
//   - clients read projections (Thread, Run, TurnItem) + live DomainEvents

import type { ThreadWorktree, TaskWorkspace } from "./worktrees.ts";
import type { Activity } from "./activity.ts";
export type { Activity };
export type { ThreadWorktree, TaskWorkspace };

/** Where a thread's agent actually works: its worktree, or the project folder. */
export const workdirOf = (thread: { cwd: string; worktree?: { path: string } }): string => thread.worktree?.path ?? thread.cwd;

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
  /** Set on a standing job's thread (its runs and results live there). */
  jobId?: string;
  /** A team is working on a goal started in this thread (for sidebar status). */
  team?: { active: number; needsYou: number; runs?: string[] };
  /** Works on its own branch in its own folder (a git worktree); cwd stays the project it belongs to. */
  worktree?: ThreadWorktree;
  /** A spare copy of a named agent, used when the agent itself is busy (same instructions and memory). Hidden. */
  cloneOf?: string;
  /** Started by an agent with start_thread. */
  startedBy?: { threadId: string; title: string };
  /** A rollback to apply to the engine's conversation the next time it opens. */
  rewind?: { keepThrough?: string; dropFrom?: string };
  /** Set when this thread continues a session started outside Bullpen (e.g. in Claude Code). */
  importedFrom?: { tool: "claude" | "codex"; title: string; at: string; history?: { items: number; truncated: boolean } };
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
  /**
   * What every agent working here may do without asking. Applies to the project's own threads and to any agent
   * pulled in (mentions, team tasks, jobs); an agent or thread set to more than this keeps its own setting.
   */
  runtimeMode?: RuntimeMode;
  /** Run in every new worktree before an agent starts there (e.g. "npm install"). */
  worktreeSetup?: string;
  /** Team tasks each get their own worktree, merged back when accepted (default on in git repos). */
  isolateTasks?: boolean;
}

export interface Run {
  id: string;
  threadId: string;
  ordinal: number; // 1-based, = "turn N"
  status: "running" | "completed" | "interrupted" | "failed";
  error?: string;
  costUsd?: number;
  /** Tokens this turn used against your plan (input incl. cache writes, plus output; cache reads not counted). */
  tokens?: number;
  startedAt: string;
  endedAt?: string;
  /** The engine's own id for the end of this turn (Claude: last message uuid; Codex: turn id), to rewind to. */
  nativeTurnId?: string;
  /** Rolled back: later turns were undone and the agent no longer remembers them. */
  rewound?: boolean;
  /** What this turn could do without asking, and what decided it (shown on running work: "why?"). */
  access?: { mode: RuntimeMode; team?: boolean; reasons: string[] };
  /** What was asked, kept so the turn can be resumed if Bullpen stops mid-turn (the outbox). */
  request?: { text: string; chain: string[]; project?: string; team?: boolean; resumed?: number };
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
        /** Set on steps a sub-agent took: the tool call (e.g. Claude's Task) that started it. */
        parentId?: string;
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
        /** While running: what to ask again if Bullpen restarts before the answer comes. */
        retry?: { prompt: string; project?: string; chain: string[] };
        /** While running: what the agent is doing (live progress). */
        activity?: Activity;
        /** The thread doing the work (the agent's own, or a spare copy). */
        runThreadId?: string;
      }
    | { kind: "note"; text: string; progress?: boolean; team?: boolean; agentId?: string; action?: { kind: "open_pr"; title: string; body: string } | { kind: "open_artifact"; artifactId: string } }
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

// ---------- Standing jobs (agents that work on a schedule or on events) ----------

export type JobTrigger =
  | { kind: "daily"; time: string; days?: number[] } // "HH:MM", days 0=Sun..6=Sat (all when omitted)
  | { kind: "interval"; hours: number }
  | { kind: "commit"; branch: string } // new commits on a branch
  | { kind: "manual" };

export interface Job {
  id: string;
  name: string;
  agentId: string;
  project: string;
  /** What to do each time, in the person's words. */
  instructions: string;
  trigger: JobTrigger;
  /** "team": the agent leads a team goal (needs canLead); "solo": it does the work itself. */
  mode: "solo" | "team";
  enabled: boolean;
  threadId: string;
  nextRunAt?: string;
  lastRunAt?: string;
  lastStatus?: JobRunStatus;
  /** For commit triggers: the last commit already handled. */
  lastCommit?: string;
  runCount: number;
  createdAt: string;
  updatedAt: string;
}

export type JobRunStatus = "running" | "done" | "needs-you" | "failed" | "paused";

export interface JobRun {
  id: string;
  jobId: string;
  /** Why it ran: "schedule", "commit abc123", "manual". */
  reason: string;
  status: JobRunStatus;
  summary?: string;
  /** Lines the agent marked "NEEDS YOU:". */
  needsYou: string[];
  goalId?: string;
  startedAt: string;
  endedAt?: string;
}

// ---------- Lessons (agents learn from your corrections) ----------

export interface Lesson {
  id: string;
  /** The agent it applies to; undefined = every agent and thread. */
  agentId?: string;
  text: string;
  status: "proposed" | "approved" | "rejected";
  source: { kind: "agent" | "review" | "manual"; threadId?: string; note?: string };
  createdAt: string;
  decidedAt?: string;
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
  /** Open-ended goals ("keep improving until…"): what "done" means, and improvement rounds. */
  criteria?: string;
  round?: number;
  maxRounds?: number;
  /** One short report per finished round. */
  roundReports?: string[];
  roundStartedAt?: string;
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
  /** Its own worktree (when the project isolates tasks); merged into the goal's folder on accept. */
  workspace?: TaskWorkspace;
  /** Files that conflicted the last time it was merged in. */
  conflicts?: string[];
  /** Notes the agent posted while working (report_progress), newest last. */
  progress?: Array<{ at: string; text: string }>;
  /** Submitted at its time budget: done as far as it got, with what's left listed. */
  partial?: boolean;
  /** Its last run was cut short by a restart; the next run continues it. */
  resumed?: boolean;
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
    /** Live, while working. */
    activity?: Activity;
    /** Time budget per run, so the card can show how much is left. */
    budgetMs?: number;
    /** Out of time: finishing up and submitting what it has. */
    wrapping?: boolean;
    partial?: boolean;
  }>;
  /** What the lead itself is doing (planning, reviewing), live. */
  lead?: { busy: boolean; activity?: Activity; threadId?: string };
  rounds?: { round: number; max: number; criteria?: string; reports: string[] };
}

// ---------- Artifacts (pages, reports and diagrams: made by agents here, or pulled in from claude.ai) ----------

export interface Artifact {
  id: string;
  /** "bullpen": made by an agent here (content stored locally); "claude": one of your claude.ai artifacts. */
  source: "bullpen" | "claude";
  title: string;
  /** What's stored locally: a web page, a Markdown document, or (claude.ai, not loaded yet) only a link. */
  kind: "html" | "markdown" | "link";
  description?: string;
  /** claude.ai address. */
  url?: string;
  /** claude.ai: yours, or shared with you. */
  owner?: "mine" | "shared";
  /** You brought it in (pasted or from a file). */
  imported?: boolean;
  /** Local content versions (1 = first). 0 = none stored. */
  version: number;
  /** Secret part of the view address (pages are served sandboxed at /av/<key>/<version>). */
  key: string;
  threadId?: string;
  agentId?: string;
  project?: string;
  createdAt: string;
  updatedAt: string;
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
  | { type: "job.upserted"; job: Job }
  | { type: "job.deleted"; jobId: string }
  | { type: "jobrun.upserted"; run: JobRun }
  | { type: "lesson.upserted"; lesson: Lesson }
  | { type: "lesson.deleted"; lessonId: string }
  | { type: "setting.upserted"; key: string; value: unknown }
  | { type: "task.upserted"; task: TeamTask }
  | { type: "project.removed"; projectId: string }
  | { type: "artifact.upserted"; artifact: Artifact }
  | { type: "artifact.deleted"; artifactId: string };

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
      /** Work on a new branch in its own folder. */
      worktree?: { base?: string; branch?: string };
    }
  | { type: "project.add"; path: string; title?: string }
  | {
      type: "project.import";
      projects: Array<{ path: string; lastUsedAt?: string }>;
      /** Also bring in each project's recent Claude Code / Codex sessions (from the last 30 days), up to this many. */
      sessions?: number;
    }
  /** Bring a past Claude Code or Codex session in as a thread, with its recent history; it continues that session. */
  | { type: "session.import"; path: string; tool: "claude" | "codex"; id: string }
  /** Load the earlier conversation into a thread that continues an outside session (threads imported before history existed). */
  | { type: "thread.backfill"; threadId: string }
  /** Stop suggesting these folders (the "found your projects" prompt). */
  | { type: "projects.dismissSuggestions"; paths: string[] }
  | {
      type: "project.update";
      projectId: string;
      title?: string;
      pinned?: boolean;
      archived?: boolean;
      runtimeMode?: RuntimeMode | null;
      worktreeSetup?: string | null;
      isolateTasks?: boolean;
    }
  /** Move a thread onto its own branch and folder (only before its first turn, or when it has no changes). */
  | { type: "worktree.create"; threadId: string; base?: string; branch?: string }
  /** Merge the thread's branch into its base. */
  | { type: "worktree.merge"; threadId: string }
  /** Merge the latest base into the thread's branch (conflicts are left for the agent). */
  | { type: "worktree.update"; threadId: string }
  /** Push the branch and open a pull request. */
  | { type: "worktree.pr"; threadId: string; title?: string; body?: string }
  /** Delete the worktree folder (and the branch, if asked). The thread goes back to the project folder. */
  | { type: "worktree.remove"; threadId: string; deleteBranch?: boolean }
  /** Show/hide many projects at once (the project manager dialog). */
  | { type: "project.bulk"; archive: string[]; unarchive: string[] }
  /** Removes it from the sidebar; its threads and files are kept. */
  | { type: "project.remove"; projectId: string }
  /** Stop a team: interrupts running tasks and cancels the rest. */
  | { type: "goal.cancel"; goalId: string }
  /** Try a parked or paused task again. */
  | { type: "task.retry"; taskId: string }
  | {
      type: "job.create";
      name: string;
      agentId: string;
      project: string;
      instructions: string;
      trigger: JobTrigger;
      mode?: "solo" | "team";
      enabled?: boolean;
    }
  | {
      type: "job.update";
      jobId: string;
      name?: string;
      agentId?: string;
      instructions?: string;
      trigger?: JobTrigger;
      mode?: "solo" | "team";
      enabled?: boolean;
    }
  | { type: "job.delete"; jobId: string }
  | { type: "job.run"; jobId: string }
  | { type: "lesson.add"; agentId?: string; text: string }
  | { type: "lesson.decide"; lessonId: string; decision: "approve" | "reject"; text?: string }
  | { type: "lesson.delete"; lessonId: string }
  | { type: "artifact.delete"; artifactId: string }
  /** Bring in a page: pasted or from a file, optionally with its claude.ai link. */
  | { type: "artifact.import"; content: string; title?: string; url?: string; kind?: "html" | "markdown" }
  /** Pull your claude.ai artifacts in now (also happens on its own every 30 minutes, when turned on). */
  | { type: "artifacts.sync" }

  | { type: "settings.update"; briefingTime?: string; briefingEnabled?: boolean; notifications?: boolean; claudeArtifacts?: boolean }
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
      tokens?: number;
      nativeTurnId?: string;
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
  /** Resume the conversation only up to the end of an earlier turn (a rollback), dropping what came after. */
  rewind?: { keepThrough?: string; dropFrom?: string };
  /** A named agent's own folder (memory, scratch): it may always edit files there without asking. */
  ownFolder?: string;
  /** Extra system/developer instructions (a named agent's prompt). */
  instructions?: string;
  tools?: HarnessTool[];
  emit: (event: AdapterEvent) => void;
}

export interface ProviderSession {
  /** `workdir`: the project to work in this turn, when it isn't the session's own folder. */
  /** `team`: a team task, so edits inside the project and safe commands run without asking. */
  /** `mode`: the permission level for this turn (the project's, when it allows more than the session's own). */
  startTurn(input: { runId: string; text: string; workdir?: string; team?: boolean; mode?: RuntimeMode }): void;
  interruptTurn(): Promise<void>;
  respondToRuntimeRequest(requestId: string, decision: Decision): boolean;
  close(): void;
}

export interface ProviderAdapter {
  readonly kind: string;
  openSession(input: OpenSessionInput): ProviderSession;
}
