// Command handling + provider event ingestion (T3: OrchestratorV2 + RunExecutionService +
// ProviderEventIngestor). Commands validate against projections and commit domain events;
// side effects (provider calls, git snapshots) run after the commit.
//
// Crash safety (T3 uses a transactional outbox): each run stores what was asked in the same transaction that
// starts it. If Bullpen stops mid-turn, the run is marked interrupted on restart and the turn is resumed from
// the engine's saved conversation, once.

import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { HOME } from "./home.ts";
import { Jobs } from "./jobs.ts";
import { Team, isLimitError, type ConsultOutcome } from "./team.ts";
import * as checkpoints from "./checkpoints.ts";
import * as worktrees from "./worktrees.ts";
import { BrowserHub } from "./browser.ts";
import { Artifacts } from "./artifacts.ts";
import { workdirOf } from "./types.ts";
import { expandHome } from "./projects.ts";
import type { Store } from "./store.ts";
const MODE_RANK = { "approval-required": 0, "auto-accept-edits": 1, "full-access": 2 } as const;
import type {
  AdapterEvent,
  Agent,
  Checkpoint,
  Command,
  Lesson,
  Project,
  DomainEvent,
  HarnessTool,
  ProviderAdapter,
  ProviderSession,
  Run,
  RuntimeMode,
  Thread,
  TurnItem,
  ThreadWorktree,
} from "./types.ts";

export class CommandError extends Error {}

/** A text file an agent points at (for create_artifact), within reason. */
function readText(path: string): string {
  if (!existsSync(path)) throw new Error(`No file ${path}.`);
  if (statSync(path).size > 8 * 1024 * 1024) throw new Error("That file is over 8 MB.");
  return readFileSync(path, "utf8");
}

/** "Code Reviewer 🐛" → "code-reviewer": the @handle used to mention an agent. */
function toHandle(text: string): string {
  let h = text
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/^@/, "")
    .replace(/['’]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32)
    .replace(/-+$/, "");
  if (/^[0-9]/.test(h)) h = `a-${h}`.slice(0, 32);
  return h.length >= 2 ? h : "agent";
}
const MENTION = /(?:^|[^\w@])@([a-z][a-z0-9-]{1,31})(?![\w-])/g;
/** How many agents deep a chain of ask_agent calls may go. */
const MAX_CONSULT_DEPTH = 3;
/** How much of the calling thread an @mentioned agent gets to see. */
const MENTION_CONTEXT_CHARS = 8000;
/** Messages that sound like the person correcting how an agent works (a lesson may be worth keeping). */
const CORRECTION = /\b(no[,.!]|nope|don'?t|do not|never|always|instead|stop|wrong|not like that|we use|we don'?t|i prefer|prefer|please use|should (be|use)|from now on|remember)\b/i;
const RESUME_NOTE =
  "Bullpen restarted while you were in the middle of this turn. Your conversation so far is intact and files you changed are still changed. " +
  "Check where you got to, then continue the request below from there (don't redo finished steps).";
const LESSON_HINT =
  "(If this message corrects how you work in a way worth remembering beyond this task, call propose_lesson with a one-line rule; the person approves it.)";

type ConsultResult = ConsultOutcome;

export class Orchestrator {
  readonly #store: Store;
  readonly #adapters: Map<string, ProviderAdapter>;
  readonly #sessions = new Map<string, ProviderSession>();
  /** Per-thread serialization of async work (T3: ThreadCommandExecutor keyed lock). */
  readonly #locks = new Map<string, Promise<unknown>>();
  /** Agent ids already waiting further up the consult chain of each thread's active run. */
  readonly #runChains = new Map<string, string[]>();
  /** For agents' home threads: the project the current run was called into. */
  readonly #runProjects = new Map<string, string>();
  /** Sessions to reopen (new agent settings) once their current run ends. */
  readonly #staleSessions = new Set<string>();

  readonly #team: Team;
  readonly #jobs: Jobs;
  /** One real browser tab per thread, shared by its agent's browser tools and the Browser panel. */
  readonly browser = new BrowserHub();
  /** Pages and reports agents make here, plus your claude.ai artifacts. */
  readonly artifacts: Artifacts;
  /** Hooks for a run that a team task is waiting on (to time it out and map its approvals). */
  readonly #runHooks = new Map<string, (homeThreadId: string, runId: string) => void>();

  constructor(store: Store, adapters: ProviderAdapter[]) {
    this.#store = store;
    this.#adapters = new Map(adapters.map((a) => [a.kind, a]));
    this.#recoverInterruptedRuns();
    this.#team = new Team(store, {
      consult: (agent, prompt, chain, project, opts) => this.#consult(agent, prompt, chain, project, opts),
      interrupt: async (homeThreadId, runId) => {
        const thread = this.#store.getThread(homeThreadId);
        if (thread?.activeRunId === runId) await this.#sessions.get(homeThreadId)?.interruptTurn();
      },
      transcript: (threadId) => this.#transcript(threadId),
      isolation: async (dir) => {
        const project = this.#projectFor(dir);
        if (project?.isolateTasks === false || !(await checkpoints.isGitRepo(dir))) return undefined;
        return { setup: project?.worktreeSetup };
      },
      proposeLesson: (agentId, text, source) => this.#proposeLesson(agentId, text, source),
    });
    this.#team.start();
    this.#jobs = new Jobs(store, {
      consult: (agent, prompt, chain, project, opts) => this.#consult(agent, prompt, chain, project, opts),
      startTeamGoal: (thread, lead, request, reply) => this.#team.startGoal(thread, lead, request, reply),
      createJobThread: (project, title, jobId) => {
        const { threadId } = this.#createThread({ type: "thread.create", cwd: project, title });
        const thread = this.#requireThread(threadId);
        this.#store.commit(threadId, [{ type: "thread.upserted", thread: { ...thread, jobId } }]);
        return this.#requireThread(threadId);
      },
    });
    this.#jobs.start();
    this.artifacts = new Artifacts(store);
    this.artifacts.start();
  }

  async dispatch(command: Command): Promise<unknown> {
    switch (command.type) {
      case "thread.create": {
        const created = this.#createThread(command);
        if (command.worktree) {
          try {
            await this.#addWorktree(created.threadId, command.worktree);
          } catch (err) {
            throw new CommandError(`The thread was created, but its worktree wasn't: ${(err as Error).message}`);
          }
        }
        return created;
      }
      case "worktree.create":
        return this.#serial(command.threadId, async () => {
          const thread = this.#requireThread(command.threadId);
          if (thread.worktree) throw new CommandError("This thread already has its own branch.");
          if (thread.status === "running") throw new CommandError("Wait for the current turn to finish.");
          if (thread.agentId || thread.jobId) throw new CommandError("Only project threads can have their own branch.");
          return this.#addWorktree(thread.id, command);
        });
      case "worktree.merge":
        return this.#serial(command.threadId, async () => {
          const { thread, wt } = this.#requireWorktree(command.threadId);
          if (thread.status === "running") throw new CommandError("Wait for the current turn to finish.");
          const res = await worktrees.mergeIntoBase(wt, thread.title);
          if (!res.ok) throw new CommandError(res.error);
          this.#note(thread.id, res.how === "nothing" ? `Nothing to merge: ${wt.branch} has no changes beyond ${wt.base}.` : `Merged ${wt.branch} into ${wt.base}.`);
          return res;
        });
      case "worktree.update":
        return this.#serial(command.threadId, async () => {
          const { thread, wt } = this.#requireWorktree(command.threadId);
          if (thread.status === "running") throw new CommandError("Wait for the current turn to finish.");
          const res = await worktrees.updateFromBase(wt);
          if (res.error) throw new CommandError(res.error);
          if (res.conflicts.length) {
            // Hand the conflicts to the thread's agent right away.
            void this.dispatch({
              type: "message.send",
              threadId: thread.id,
              text: `I merged the latest ${wt.base} into this branch and it conflicts in: ${res.conflicts.join(", ")}. Resolve the conflict markers in those files (keep both sides' intent), run the checks, then commit the merge with git.`,
            });
          } else this.#note(thread.id, `Brought in the latest ${wt.base}.`);
          return res;
        });
      case "worktree.pr":
        return this.#serial(command.threadId, async () => {
          const { thread, wt } = this.#requireWorktree(command.threadId);
          if (thread.status === "running") throw new CommandError("Wait for the current turn to finish.");
          try {
            const { url } = await worktrees.openPullRequest(wt, command.title?.trim() || thread.title, command.body?.trim() || this.#prBody(thread));
            this.#store.commit(thread.id, [{ type: "thread.upserted", thread: { ...this.#requireThread(thread.id), worktree: { ...wt, prUrl: url } } }]);
            this.#note(thread.id, `Opened a pull request: ${url}`);
            return { url };
          } catch (err) {
            throw new CommandError((err as Error).message);
          }
        });
      case "worktree.remove":
        return this.#serial(command.threadId, async () => {
          const { thread, wt } = this.#requireWorktree(command.threadId);
          if (thread.status === "running") throw new CommandError("Wait for the current turn to finish.");
          this.#closeSession(thread.id);
          await worktrees.removeThreadWorktree(wt, Boolean(command.deleteBranch));
          // The engine's conversation was keyed to the worktree folder; start fresh in the project folder.
          this.#store.commit(thread.id, [{ type: "thread.upserted", thread: { ...this.#requireThread(thread.id), worktree: undefined, nativeSessionId: undefined } }]);
          this.#note(thread.id, command.deleteBranch ? `Removed the worktree and deleted ${wt.branch}.` : `Removed the worktree (branch ${wt.branch} is kept).`);
          return { ok: true };
        });
      case "message.send":
        return this.#serial(command.threadId, () => this.#handleMessage(command.threadId, command.text));
      case "run.interrupt": {
        const thread = this.#requireThread(command.threadId);
        if (thread.status !== "running") throw new CommandError("No active run to interrupt.");
        await this.#sessions.get(thread.id)?.interruptTurn();
        return { ok: true };
      }
      case "runtime-request.respond": {
        const session = this.#sessions.get(command.threadId);
        if (!session?.respondToRuntimeRequest(command.requestId, command.decision)) {
          throw new CommandError("Unknown or already-resolved request (the session may have restarted).");
        }
        this.#team.onApprovalChange(command.threadId);
        return { ok: true };
      }
      case "checkpoint.rollback":
        return this.#serial(command.threadId, () => this.#rollback(command.threadId, command.ordinal));
      case "project.add": {
        const project = this.#ensureProject(this.#resolveDir(command.path), command.title);
        // Added by hand: treat as just used, so it shows near the top.
        this.#store.commit(`project:${project.id}`, [{ type: "project.upserted", project: { ...project, lastUsedAt: new Date().toISOString() } }]);
        return { projectId: project.id };
      }
      case "project.import": {
        let added = 0;
        for (const item of command.projects) {
          try {
            const dir = this.#resolveDir(item.path);
            const existing = this.#store.getProjectByPath(dir);
            const project = existing ?? this.#ensureProject(dir);
            if (!existing) added++;
            if (item.lastUsedAt && (!project.lastUsedAt || item.lastUsedAt > project.lastUsedAt)) {
              this.#store.commit(`project:${project.id}`, [{ type: "project.upserted", project: { ...project, lastUsedAt: item.lastUsedAt } }]);
            }
          } catch {
            // folder gone since the scan: skip it
          }
        }
        this.#store.commit("settings", [{ type: "setting.upserted", key: "projects.onboarded", value: true }]);
        return { added };
      }
      case "projects.dismissSuggestions": {
        const dismissed = new Set(this.#store.getSetting<string[]>("projects.dismissed", []));
        for (const p of command.paths) dismissed.add(p);
        this.#store.commit("settings", [
          { type: "setting.upserted", key: "projects.dismissed", value: [...dismissed].slice(-2000) },
          { type: "setting.upserted", key: "projects.onboarded", value: true },
        ]);
        return { ok: true };
      }
      case "project.update": {
        const project = this.#store.getProject(command.projectId);
        if (!project) throw new CommandError("Unknown project.");
        const next: Project = { ...project };
        if (command.title !== undefined) next.title = command.title.trim() || project.title;
        if (command.pinned !== undefined) next.pinnedAt = command.pinned ? new Date().toISOString() : undefined;
        if (command.archived !== undefined) next.archivedAt = command.archived ? new Date().toISOString() : undefined;
        if (command.runtimeMode !== undefined) next.runtimeMode = command.runtimeMode ?? undefined;
        if (command.worktreeSetup !== undefined) next.worktreeSetup = command.worktreeSetup?.trim() || undefined;
        if (command.isolateTasks !== undefined) next.isolateTasks = command.isolateTasks;
        this.#store.commit(`project:${project.id}`, [{ type: "project.upserted", project: next }]);
        return { ok: true };
      }
      case "job.create":
        try {
          return { jobId: this.#jobs.create(command).id };
        } catch (err) {
          throw new CommandError((err as Error).message);
        }
      case "job.update":
        try {
          this.#jobs.update(command);
          return { ok: true };
        } catch (err) {
          throw new CommandError((err as Error).message);
        }
      case "job.delete":
        this.#jobs.delete(command.jobId);
        return { ok: true };
      case "job.run":
        try {
          this.#jobs.runNow(command.jobId);
          return { ok: true };
        } catch (err) {
          throw new CommandError((err as Error).message);
        }
      case "lesson.add": {
        const text = command.text?.trim();
        if (!text) throw new CommandError("Write the lesson.");
        const lesson: Lesson = {
          id: randomUUID(),
          agentId: command.agentId || undefined,
          text: text.slice(0, 400),
          status: "approved",
          source: { kind: "manual" },
          createdAt: new Date().toISOString(),
          decidedAt: new Date().toISOString(),
        };
        this.#store.commit(`lesson:${lesson.id}`, [{ type: "lesson.upserted", lesson }]);
        return { lessonId: lesson.id };
      }
      case "lesson.decide": {
        const lesson = this.#store.getLesson(command.lessonId);
        if (!lesson) throw new CommandError("Unknown lesson.");
        const next: Lesson = {
          ...lesson,
          text: command.text?.trim() ? command.text.trim().slice(0, 400) : lesson.text,
          status: command.decision === "approve" ? "approved" : "rejected",
          decidedAt: new Date().toISOString(),
        };
        this.#store.commit(`lesson:${lesson.id}`, [{ type: "lesson.upserted", lesson: next }]);
        return { ok: true };
      }
      case "artifact.import":
        try {
          return { artifact: this.artifacts.import(command) };
        } catch (err) {
          throw new CommandError((err as Error).message);
        }
      case "artifact.delete":
        this.artifacts.delete(command.artifactId);
        return { ok: true };
      case "artifacts.sync": {
        const r = await this.artifacts.sync();
        if (!r.ok) throw new CommandError(r.error ?? "Couldn't reach claude.ai.");
        return r;
      }
      case "artifact.fetch":
        try {
          return { artifact: await this.artifacts.fetch(command.artifactId) };
        } catch (err) {
          throw new CommandError((err as Error).message);
        }
      case "lesson.delete":
        this.#store.commit(`lesson:${command.lessonId}`, [{ type: "lesson.deleted", lessonId: command.lessonId }]);
        return { ok: true };
      case "settings.update": {
        const events: DomainEvent[] = [];
        if (command.briefingTime !== undefined) {
          if (!/^([01]?\d|2[0-3]):[0-5]\d$/.test(command.briefingTime)) throw new CommandError("Use a time like 08:00.");
          events.push({ type: "setting.upserted", key: "briefing.time", value: command.briefingTime });
        }
        if (command.briefingEnabled !== undefined) events.push({ type: "setting.upserted", key: "briefing.enabled", value: command.briefingEnabled });
        if (command.notifications !== undefined) events.push({ type: "setting.upserted", key: "notifications", value: command.notifications });
        if (command.claudeArtifacts !== undefined) events.push({ type: "setting.upserted", key: "artifacts.claude", value: command.claudeArtifacts });
        this.#store.commit("settings", events);
        return { ok: true };
      }
      case "goal.cancel":
        this.#team.cancelGoal(command.goalId);
        return { ok: true };
      case "task.retry":
        this.#team.retryTask(command.taskId);
        return { ok: true };
      case "project.bulk": {
        const now = new Date().toISOString();
        const flip = (ids: string[], archivedAt: string | undefined) => {
          for (const id of ids) {
            const project = this.#store.getProject(id);
            if (project && Boolean(project.archivedAt) !== Boolean(archivedAt)) {
              this.#store.commit(`project:${id}`, [{ type: "project.upserted", project: { ...project, archivedAt } }]);
            }
          }
        };
        flip(command.archive, now);
        flip(command.unarchive, undefined);
        return { ok: true };
      }
      case "project.remove":
        this.#store.commit(`project:${command.projectId}`, [{ type: "project.removed", projectId: command.projectId }]);
        return { ok: true };
      case "agent.create":
        return this.#createAgent(command);
      case "agent.update":
        return this.#updateAgent(command);
      case "agent.reset": {
        const agent = this.#requireAgent(command.agentId);
        return this.#serial(agent.homeThreadId, async () => {
          const home = this.#requireThread(agent.homeThreadId);
          if (home.status === "running") throw new CommandError(`@${agent.name} is busy; interrupt it first.`);
          this.#closeSession(home.id);
          this.#store.commit(home.id, [{ type: "thread.upserted", thread: { ...home, nativeSessionId: undefined } }]);
          return { ok: true };
        });
      }
      case "agent.delete": {
        const agent = this.#requireAgent(command.agentId);
        const home = this.#requireThread(agent.homeThreadId);
        if (home.status === "running") throw new CommandError(`@${agent.name} is busy; interrupt it first.`);
        this.#closeSession(home.id);
        this.#store.commit(home.id, [
          { type: "agent.deleted", agentId: agent.id },
          { type: "thread.upserted", thread: { ...home, agentId: undefined } },
        ]);
        return { ok: true };
      }
    }
  }

  async diff(threadId: string, fromOrdinal: number, toOrdinal: number): Promise<string> {
    const thread = this.#requireThread(threadId);
    const from = this.#store.getCheckpoint(threadId, fromOrdinal);
    const to = this.#store.getCheckpoint(threadId, toOrdinal);
    if (!from || !to) throw new CommandError(`Missing checkpoint ${!from ? fromOrdinal : toOrdinal}.`);
    return checkpoints.diff(workdirOf(thread), from.ref, to.ref);
  }

  /** Branch state for a thread on its own worktree (and its pull request, if any). */
  async worktreeStatus(threadId: string) {
    const { wt } = this.#requireWorktree(threadId);
    const [st, pr] = await Promise.all([worktrees.status(wt), worktrees.pullRequestFor(wt)]);
    return { ...st, path: wt.path, root: wt.root, pr };
  }

  /** Morning briefing contents (latest, or live for the last day). */
  /** The Teams page: every open goal, plus the ones that ended in the last week. */
  teams() {
    const week = new Date(Date.now() - 7 * 24 * 3600_000).toISOString();
    const goals = this.#store.allGoals().filter((g) => ["planning", "working", "paused", "stuck"].includes(g.status) || (g.endedAt ?? g.updatedAt) >= week);
    return goals.slice(0, 40).map((g) => ({ ...this.#team.card(g), threadId: g.threadId, project: g.project }));
  }

  briefing(since?: string) {
    return this.#jobs.briefing(since);
  }

  shutdown() {
    void this.browser.shutdown();
    this.artifacts.stop();
    this.#jobs.stop();
    this.#team.stop();
    for (const s of this.#sessions.values()) s.close();
    this.#sessions.clear();
  }

  // ---------------------------------------------------------------------------

  #resolveDir(path: string): string {
    try {
      return realpathSync(expandHome(path.trim()));
    } catch {
      throw new CommandError(`Directory not found: ${path}`);
    }
  }

  /** The project for a folder, adding it if it's new (T3 adds a project the first time you work in a folder). */
  #ensureProject(path: string, title?: string): Project {
    const existing = this.#store.getProjectByPath(path);
    if (existing) return existing;
    const project: Project = {
      id: randomUUID(),
      path,
      title: title?.trim() || path.split("/").filter(Boolean).pop() || path,
      createdAt: new Date().toISOString(),
    };
    this.#store.commit(`project:${project.id}`, [{ type: "project.upserted", project }]);
    return project;
  }

  #createThread(cmd: Extract<Command, { type: "thread.create" }>, asProject = true) {
    const cwd = this.#resolveDir(cmd.cwd);
    if (asProject) {
      const project = this.#ensureProject(cwd);
      if (project.archivedAt) {
        this.#store.commit(`project:${project.id}`, [{ type: "project.upserted", project: { ...project, archivedAt: undefined } }]);
      }
    }
    const resume = cmd.resumeClaudeSession;
    if (resume && (cmd.provider ?? "claude") !== "claude") throw new CommandError("Only Claude sessions can be resumed.");
    const provider = cmd.provider ?? "claude";
    if (!this.#adapters.has(provider)) throw new CommandError(`Unknown provider "${provider}" (have: ${[...this.#adapters.keys()].join(", ")}).`);
    const thread: Thread = {
      id: randomUUID(),
      title: cmd.title ?? "New thread",
      cwd,
      provider,
      runtimeMode: cmd.runtimeMode ?? "approval-required",
      model: cmd.model,
      status: "idle",
      runCount: 0,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      ...(resume
        ? {
            title: resume.title,
            nativeSessionId: resume.id,
            importedFrom: { tool: "claude" as const, title: resume.title, at: resume.updatedAt },
          }
        : {}),
    };
    this.#store.commit(thread.id, [{ type: "thread.upserted", thread }]);
    return { threadId: thread.id };
  }

  async #addWorktree(threadId: string, opts: { base?: string; branch?: string }) {
    const thread = this.#requireThread(threadId);
    if (!(await checkpoints.isGitRepo(thread.cwd))) throw new CommandError("This folder isn't a git repository, so it can't have branches.");
    const project = this.#store.getProjectByPath(thread.cwd);
    let wt: ThreadWorktree;
    try {
      wt = await worktrees.createThreadWorktree(thread.cwd, {
        title: thread.title === "New thread" ? "thread" : thread.title,
        base: opts.base,
        branch: opts.branch,
        setup: project?.worktreeSetup,
      });
    } catch (err) {
      throw new CommandError((err as Error).message);
    }
    this.#closeSession(threadId);
    const latest = this.#requireThread(threadId);
    // A new folder means a new engine conversation (they're keyed by folder).
    this.#store.commit(threadId, [{ type: "thread.upserted", thread: { ...latest, worktree: wt, nativeSessionId: latest.runCount ? latest.nativeSessionId : undefined } }]);
    this.#note(threadId, `Working on branch ${wt.branch} (from ${wt.base}) in its own folder. Your checkout isn't touched until you merge.` + (wt.setupError ? `\n${wt.setupError}` : ""));
    return { worktree: wt };
  }

  #requireWorktree(threadId: string): { thread: Thread; wt: ThreadWorktree } {
    const thread = this.#requireThread(threadId);
    if (!thread.worktree) throw new CommandError("This thread doesn't have its own branch.");
    return { thread, wt: thread.worktree };
  }

  /** A short note from Bullpen in a thread's timeline. */
  #note(threadId: string, text: string) {
    const id = randomUUID();
    this.#store.commit(threadId, [{ type: "turn-item.upserted", item: { id: `note:${id}`, threadId, runId: `note:${id}`, kind: "note", text } }]);
  }

  #prBody(thread: Thread): string {
    const asks = this.#store
      .listTurnItems(thread.id, 200)
      .filter((i) => i.kind === "user_message")
      .map((i) => (i.kind === "user_message" ? `- ${i.text.split("\n")[0].slice(0, 200)}` : ""));
    return [`Work from the Bullpen thread "${thread.title}".`, asks.length ? `\nRequests:\n${asks.join("\n")}` : ""].join("\n");
  }

  // ---------- agents ----------

  #createAgent(cmd: Extract<Command, { type: "agent.create" }>) {
    const displayName = cmd.name.trim().slice(0, 60);
    if (!displayName) throw new CommandError("Give the agent a name.");
    if (!cmd.instructions?.trim()) throw new CommandError("An agent needs instructions.");
    const name = this.#uniqueHandle(toHandle(cmd.handle?.trim() || displayName));
    // The agent's own folder: its memory file and scratch space. Projects come from whoever calls it.
    const folder = join(HOME, "agents", name);
    mkdirSync(folder, { recursive: true });
    const memory = join(folder, "MEMORY.md");
    if (!existsSync(memory)) {
      writeFileSync(memory, `# @${name} memory\n\nDurable notes this agent keeps for itself: preferences, decisions, how things work.\n`);
    }
    const { threadId } = this.#createThread({
      type: "thread.create",
      cwd: folder,
      provider: cmd.provider,
      model: cmd.model,
      runtimeMode: cmd.runtimeMode,
      title: displayName,
    }, false);
    const now = new Date().toISOString();
    const home = this.#requireThread(threadId);
    const agent: Agent = {
      id: randomUUID(),
      name,
      displayName,
      templateId: cmd.templateId,
      canLead: cmd.canLead ?? cmd.templateId === "lead",
      description: cmd.description?.trim() ?? "",
      instructions: cmd.instructions.trim(),
      provider: home.provider,
      model: home.model,
      cwd: home.cwd,
      runtimeMode: home.runtimeMode,
      homeThreadId: threadId,
      createdAt: now,
      updatedAt: now,
    };
    this.#store.commit(threadId, [
      { type: "agent.upserted", agent },
      { type: "thread.upserted", thread: { ...home, agentId: agent.id } },
    ]);
    return { agentId: agent.id, threadId };
  }

  #updateAgent(cmd: Extract<Command, { type: "agent.update" }>) {
    const agent = this.#requireAgent(cmd.agentId);
    const home = this.#requireThread(agent.homeThreadId);
    const displayName = cmd.displayName?.trim().slice(0, 60) || agent.displayName;
    let name = agent.name;
    if (cmd.handle !== undefined && toHandle(cmd.handle) !== agent.name) name = this.#uniqueHandle(toHandle(cmd.handle), agent.id);
    const next: Agent = {
      ...agent,
      name,
      displayName,
      canLead: cmd.canLead ?? agent.canLead,
      description: cmd.description?.trim() ?? agent.description,
      instructions: cmd.instructions?.trim() || agent.instructions,
      model: cmd.model === undefined ? agent.model : cmd.model.trim() || undefined,
      runtimeMode: cmd.runtimeMode ?? agent.runtimeMode,
      updatedAt: new Date().toISOString(),
    };
    this.#store.commit(home.id, [
      { type: "agent.upserted", agent: next },
      { type: "thread.upserted", thread: { ...home, title: displayName ?? `@${name}`, model: next.model, runtimeMode: next.runtimeMode } },
    ]);
    // Reopen the session with the new settings; the conversation resumes from the native session.
    if (home.status === "running") this.#staleSessions.add(home.id);
    else this.#closeSession(home.id);
    return { ok: true };
  }

  /** Approved lessons for an agent (and the ones for everyone). */
  #lessonsFor(agentId: string | undefined): string[] {
    return this.#store
      .listLessons()
      .filter((l) => l.status === "approved" && (!l.agentId || l.agentId === agentId))
      .slice(-40)
      .map((l) => l.text);
  }

  #proposeLesson(agentId: string | undefined, text: string, source: Lesson["source"]): Lesson | undefined {
    const clean = text.trim().replace(/\s+/g, " ").slice(0, 400);
    if (!clean) return undefined;
    const dup = this.#store
      .listLessons()
      .find((l) => l.agentId === agentId && l.status !== "rejected" && l.text.toLowerCase() === clean.toLowerCase());
    if (dup) return undefined;
    const lesson: Lesson = { id: randomUUID(), agentId, text: clean, status: "proposed", source, createdAt: new Date().toISOString() };
    this.#store.commit(`lesson:${lesson.id}`, [{ type: "lesson.upserted", lesson }]);
    return lesson;
  }

  /** `base`, or base-2, base-3… if another agent already has it. */
  #uniqueHandle(base: string, selfId?: string): string {
    const taken = (h: string) => {
      const other = this.#store.getAgentByName(h);
      return other !== undefined && other.id !== selfId;
    };
    if (!taken(base)) return base;
    for (let i = 2; ; i++) {
      const candidate = `${base.slice(0, 29)}-${i}`;
      if (!taken(candidate)) return candidate;
    }
  }

  /** Agents @mentioned in `text`, minus the thread's own agent. */
  #mentionedAgents(text: string, thread: Thread): Agent[] {
    const found = new Map<string, Agent>();
    for (const m of text.matchAll(MENTION)) {
      const agent = this.#store.getAgentByName(m[1]);
      if (agent && agent.homeThreadId !== thread.id) found.set(agent.id, agent);
    }
    return [...found.values()];
  }

  async #handleMessage(threadId: string, text: string) {
    const thread = this.#requireThread(threadId);
    if (!text.trim()) throw new CommandError("Empty message.");
    let mentioned = this.#mentionedAgents(text, thread);
    // Mentioning a lead in a project thread starts (or steers) a team goal. Other @names in the same message
    // are suggestions for the lead to assign, not separate requests, so only the lead receives it.
    if (!thread.agentId && mentioned.some((a) => a.canLead)) mentioned = mentioned.filter((a) => a.canLead).slice(0, 1);
    if (mentioned.length) return this.#mention(thread, text, mentioned);
    return this.#sendMessage(threadId, text, thread.agentId ? [thread.agentId] : [], undefined, undefined, CORRECTION.test(text));
  }

  /**
   * A message that @mentions agents goes to them, not to the thread's own agent: each mentioned
   * agent gets the recent conversation plus the message, and its answer is posted here as an
   * agent_reply. The thread's own agent sees those replies at the start of its next turn.
   */
  #mention(thread: Thread, text: string, agents: Agent[]) {
    const mentionId = randomUUID();
    const runId = `mention:${mentionId}`;
    const context = this.#transcript(thread.id);
    const events: DomainEvent[] = [
      { type: "turn-item.upserted", item: { id: `user:${runId}`, threadId: thread.id, runId, kind: "user_message", text } },
    ];
    if (thread.runCount === 0 && thread.title === "New thread") {
      events.push({ type: "thread.upserted", thread: { ...thread, title: text.slice(0, 60) } });
    }
    const replies = agents.map((agent) => {
      const item: Extract<TurnItem, { kind: "agent_reply" }> = {
        id: `reply:${mentionId}:${agent.id}`,
        threadId: thread.id,
        runId,
        kind: "agent_reply",
        agentId: agent.id,
        agentName: agent.name,
        status: "running",
        text: "",
        delivered: false,
      };
      events.push({ type: "turn-item.upserted", item });
      return { agent, item };
    });
    this.#store.commit(thread.id, events);

    const chain = thread.agentId ? [thread.agentId] : [];
    const project = this.#projectOf(thread.id);
    for (const { agent, item } of replies) {
      // Leads in a project thread run a team goal instead of a plain consult.
      if (agent.canLead && !thread.agentId) {
        const open = this.#team.openGoalFor(thread.id, agent.id);
        if (open) this.#team.userMessage(open, text, item);
        else this.#team.startGoal(this.#store.getThread(thread.id) ?? thread, agent, text, item);
        continue;
      }
      const prompt = [
        `You were @mentioned in the thread "${thread.title === "New thread" ? text.slice(0, 60) : thread.title}".` +
          (project ? ` Its project folder is ${project}; you have access to it for this request.` : ""),
        context ? `Recent conversation in that thread:\n\n${context}` : "That thread has no earlier conversation.",
        `The message that mentions you:\n\n${text}`,
        "Reply to it. Your final message is posted back into that thread." + (CORRECTION.test(text) ? `\n${LESSON_HINT}` : ""),
      ].join("\n\n---\n\n");
      const withRetry = { ...item, retry: { prompt, project, chain } };
      this.#store.commit(thread.id, [{ type: "turn-item.upserted", item: withRetry }]);
      this.#runMention(withRetry);
    }
    return { mentionId, agents: agents.map((a) => a.name) };
  }

  #runMention(item: Extract<TurnItem, { kind: "agent_reply" }>) {
    const agent = this.#store.getAgent(item.agentId);
    if (!agent || !item.retry) return;
    void this.#consult(agent, item.retry.prompt, item.retry.chain, item.retry.project).then(({ ok, text: answer }) => {
      const latest = this.#store.getTurnItem(item.id) ?? item;
      this.#store.commit(item.threadId, [
        { type: "turn-item.upserted", item: { ...(latest as typeof item), status: ok ? "completed" : "failed", text: answer, retry: undefined } },
      ]);
    });
  }

  /** Plain-text tail of a thread's conversation, for an @mentioned agent. */
  #transcript(threadId: string): string {
    const lines: string[] = [];
    for (const item of this.#store.listTurnItems(threadId, 80)) {
      if (item.kind === "user_message") lines.push(`user: ${item.text}`);
      else if (item.kind === "assistant_message" && !item.streaming) lines.push(`assistant: ${item.text}`);
      else if (item.kind === "agent_reply" && item.status !== "running") lines.push(`@${item.agentName}: ${item.text}`);
    }
    const all = lines.join("\n\n");
    return all.length > MENTION_CONTEXT_CHARS ? `…${all.slice(-MENTION_CONTEXT_CHARS)}` : all;
  }

  /**
   * Run one request on an agent's home thread and wait for its answer. Requests to the same
   * agent queue up; the chain stops A→B→A loops, which would otherwise wait on each other forever.
   */
  #consult(
    agent: Agent,
    prompt: string,
    chain: string[],
    project?: string,
    opts: { team?: boolean; onRun?: (homeThreadId: string, runId: string) => void } = {},
  ): Promise<ConsultResult> {
    if (chain.includes(agent.id)) {
      return Promise.resolve({
        ok: false,
        text: `@${agent.name} is already waiting further up this chain of requests; asking it again would deadlock.`,
      });
    }
    if (chain.length >= MAX_CONSULT_DEPTH) {
      return Promise.resolve({ ok: false, text: `Too many nested agent consultations (limit ${MAX_CONSULT_DEPTH}).` });
    }
    return this.#serial(`consult:${agent.id}`, async (): Promise<ConsultResult> => {
      const home = agent.homeThreadId;
      for (;;) {
        await this.#waitFor(home, () => this.#store.getThread(home)?.status !== "running");
        let runId: string;
        try {
          ({ runId } = await this.#serial(home, () => this.#sendMessage(home, prompt, [...chain, agent.id], project, opts.team)));
          opts.onRun?.(home, runId);
        } catch (err) {
          if (err instanceof CommandError && err.message.startsWith("A run is already active")) continue; // you were chatting with it
          return { ok: false, text: `@${agent.name} could not start: ${(err as Error).message}` };
        }
        await this.#waitFor(home, () => this.#store.getThread(home)?.activeRunId !== runId);
        const run = this.#store.getRun(runId);
        const answer = this.#store
          .listRunItems(home, runId)
          .filter((i) => i.kind === "assistant_message" && i.text.trim())
          .at(-1);
        const text = answer?.kind === "assistant_message" ? answer.text : "";
        if (run?.status === "completed") return { ok: true, text: text || "(no answer)", runId, homeThreadId: home };
        const failure = `${run?.error ?? ""} ${text}`;
        return {
          ok: false,
          text: `@${agent.name} ${run?.status ?? "failed"}${run?.error ? `: ${run.error}` : ""}${text ? `\nPartial answer: ${text}` : ""}`,
          runId,
          homeThreadId: home,
          limited: run?.status === "failed" && isLimitError(failure),
        };
      }
    });
  }

  /** Resolve once `done()` holds, re-checking after every event on the thread. */
  #waitFor(threadId: string, done: () => boolean): Promise<void> {
    if (done()) return Promise.resolve();
    return new Promise((resolve) => {
      const unsubscribe = this.#store.subscribe(threadId, () => {
        if (!done()) return;
        unsubscribe();
        resolve();
      });
    });
  }

  /** Tools every session gets: list the agents, and consult one. */
  #harnessTools(threadId: string): HarnessTool[] {
    const others = () => {
      const self = this.#store.getThread(threadId)?.agentId;
      return this.#store.listAgents().filter((a) => a.id !== self);
    };
    const roster = () =>
      others()
        .map((a) => `@${a.name}${a.displayName ? ` (${a.displayName})` : ""}${a.description ? ` — ${a.description}` : ""}`)
        .join("\n") || "(no other agents yet)";
    const self = this.#store.getThread(threadId)?.agentId;
    const leadTools = self && this.#store.getAgent(self)?.canLead ? this.#team.tools(threadId) : [];
    return [
      ...leadTools,
      ...this.#threadTools(threadId),
      ...this.#artifactTools(threadId),
      ...this.#browserTools(threadId),
      {
        name: "propose_lesson",
        description:
          "Suggest a lasting lesson: a one-line rule about how you should work from now on, learned from the person correcting you " +
          "(e.g. 'Rock RMS reports use views, never raw tables'). Only for durable preferences or facts, not task details. The person approves it before it applies.",
        params: { lesson: { description: "The rule, one line, written as an instruction." } },
        run: async ({ lesson }) => {
          const self = this.#store.getThread(threadId)?.agentId;
          const created = this.#proposeLesson(self, lesson ?? "", { kind: "agent", threadId });
          return created
            ? { text: "Proposed. The person will approve or edit it; mention briefly that you suggested it." }
            : { isError: true, text: "That lesson is empty or already exists." };
        },
      },
      {
        name: "list_agents",
        description: "List the named long-running agents you can consult with ask_agent.",
        params: {},
        run: async () => ({ text: roster() }),
      },
      {
        name: "ask_agent",
        description:
          "Consult a named long-running agent and wait for its answer. Each agent keeps its own context and " +
          "instructions across calls, but sees nothing of your conversation: put everything it needs in the question. " +
          `Agents available when this session started:\n${roster()}`,
        params: {
          agent: { description: "The agent's name, e.g. reviewer or @reviewer." },
          question: { description: "What you want from it, with the context it needs." },
        },
        run: async ({ agent: name, question }) => {
          const target = this.#store.getAgentByName((name ?? "").replace(/^@/, "").trim().toLowerCase());
          if (!target) return { isError: true, text: `No agent named "${name}". Available:\n${roster()}` };
          if (this.#team.isLeadingGoal(threadId)) {
            return {
              isError: true,
              text: `You're leading a team goal: hand this to @${target.name} with delegate instead, so it's tracked on the team card, runs without approval prompts, and comes back to you for review.`,
            };
          }
          if (!question?.trim()) return { isError: true, text: "Pass a question." };
          const thread = this.#requireThread(threadId);
          const caller = thread.agentId ? this.#store.getAgent(thread.agentId) : undefined;
          const who = caller ? `@${caller.name}` : `The agent working in thread "${thread.title}"`;
          const chain = this.#runChains.get(threadId) ?? (thread.agentId ? [thread.agentId] : []);
          const project = this.#projectOf(threadId);
          const where = project ? ` (project folder: ${project}; you have access to it for this request)` : "";
          const res = await this.#consult(target, `${who}${where} asks you:\n\n${question}`, chain, project);
          return { text: res.text, isError: !res.ok };
        },
      },
    ];
  }

  /** Threads as tools (T3: t3_thread_launch/list/read/send/wait): agents can start and follow other threads. */
  #threadTools(threadId: string): HarnessTool[] {
    const find = (ref: string | undefined) => {
      const r = (ref ?? "").trim();
      const all = this.#store.listThreads();
      return all.find((t) => t.id === r) ?? all.find((t) => t.id.startsWith(r) && r.length >= 6);
    };
    const line = (t: Thread) =>
      `${t.id.slice(0, 8)}  ${t.status === "running" ? "working" : "idle"}  "${t.title}"  ${t.worktree ? `branch ${t.worktree.branch}` : t.cwd}`;
    const lastAnswer = (t: Thread) => {
      const items = this.#store.listTurnItems(t.id, 60);
      const a = items.filter((i) => i.kind === "assistant_message" && !i.streaming).at(-1);
      return a?.kind === "assistant_message" ? a.text : "";
    };
    return [
      {
        name: "list_threads",
        description: "List recent project threads (id, status, title, folder or branch). Use the id with read_thread, message_thread and wait_for_thread.",
        params: { project: { description: "Only threads in this project folder (absolute path). Default: the project you're working in.", optional: true } },
        run: async ({ project }) => {
          const dir = project?.trim() || this.#projectOf(threadId);
          const main = dir ? worktrees.mainCheckoutOf(dir) ?? dir : undefined;
          const list = this.#store
            .listThreads()
            .filter((t) => !t.agentId && !t.jobId && (!main || t.cwd === main || t.cwd === dir))
            .sort((a, b) => (b.updatedAt ?? b.createdAt).localeCompare(a.updatedAt ?? a.createdAt))
            .slice(0, 25);
          return { text: list.map(line).join("\n") || "(no threads)" };
        },
      },
      {
        name: "read_thread",
        description: "Read the recent conversation in another thread.",
        params: { thread: { description: "Thread id (or its first 8 characters)." } },
        run: async ({ thread: ref }) => {
          const t = find(ref);
          if (!t) return { isError: true, text: `No thread ${ref}.` };
          return { text: `${line(t)}\n\n${this.#transcript(t.id) || "(empty)"}` };
        },
      },
      {
        name: "start_thread",
        description:
          "Start a new thread in a project with its own agent, for a separate piece of work that should run on its own (in parallel with yours). " +
          "With branch 'yes' it works on its own git branch and folder, so it can't collide with you. Returns its id; follow it with wait_for_thread or read_thread. " +
          "The new thread is visible to the person in the sidebar.",
        params: {
          prompt: { description: "The complete request: the new agent sees nothing of your conversation." },
          title: { description: "Short title for the sidebar.", optional: true },
          project: { description: "Project folder (absolute path). Default: the project you're working in.", optional: true },
          branch: { description: "'yes' to work on its own branch (git worktree), 'no' to work in the project folder. Default: yes in git repos.", optional: true },
          engine: { description: "'claude' or 'codex'. Default: same as yours.", optional: true },
        },
        run: async (a) => {
          const caller = this.#requireThread(threadId);
          const project = a.project?.trim() || this.#projectOf(threadId);
          if (!project) return { isError: true, text: "Say which project folder (project)." };
          const root = worktrees.mainCheckoutOf(project) ?? project;
          if (!a.prompt?.trim()) return { isError: true, text: "Pass the prompt." };
          const live = this.#store.listThreads().filter((t) => t.startedBy && t.status === "running").length;
          if (live >= 4) return { isError: true, text: "Four agent-started threads are already working; wait for one to finish first." };
          if (caller.startedBy && this.#store.getThread(caller.startedBy.threadId)?.startedBy) {
            return { isError: true, text: "Threads started by agents can't keep starting more beyond two levels." };
          }
          const git = await checkpoints.isGitRepo(root);
          const wantBranch = a.branch ? /^y/i.test(a.branch) : git;
          try {
            const { threadId: id } = this.#createThread({
              type: "thread.create",
              cwd: root,
              provider: a.engine?.trim() || caller.provider,
              model: !a.engine?.trim() || a.engine.trim() === caller.provider ? caller.model : undefined,
              title: a.title?.trim().slice(0, 60) || a.prompt.trim().slice(0, 60),
              runtimeMode: caller.agentId ? (this.#store.getProjectByPath(root)?.runtimeMode ?? "approval-required") : caller.runtimeMode,
            });
            const t = this.#requireThread(id);
            this.#store.commit(id, [{ type: "thread.upserted", thread: { ...t, startedBy: { threadId, title: caller.title } } }]);
            if (wantBranch && git) await this.#addWorktree(id, {});
            await this.#serial(id, () => this.#sendMessage(id, a.prompt, [], undefined));
            const created = this.#requireThread(id);
            return { text: `Started ${line(created)}.` };
          } catch (err) {
            return { isError: true, text: (err as Error).message };
          }
        },
      },
      {
        name: "message_thread",
        description: "Send a message to another thread's agent (it starts a turn there). Fails if that thread is working; wait_for_thread first.",
        params: { thread: { description: "Thread id." }, message: { description: "What to say; it sees nothing of your conversation." } },
        run: async ({ thread: ref, message }) => {
          const t = find(ref);
          if (!t) return { isError: true, text: `No thread ${ref}.` };
          if (t.id === threadId) return { isError: true, text: "That's your own thread." };
          if (!message?.trim()) return { isError: true, text: "Pass the message." };
          try {
            await this.dispatch({ type: "message.send", threadId: t.id, text: message });
            return { text: `Sent. ${line(this.#requireThread(t.id))}` };
          } catch (err) {
            return { isError: true, text: (err as Error).message };
          }
        },
      },
      {
        name: "wait_for_thread",
        description: "Wait until another thread's agent finishes its turn, then return its final answer.",
        params: {
          thread: { description: "Thread id." },
          minutes: { description: "Give up after this many minutes (default 10, max 30).", optional: true },
        },
        run: async ({ thread: ref, minutes }) => {
          const t = find(ref);
          if (!t) return { isError: true, text: `No thread ${ref}.` };
          const ms = Math.min(30, Math.max(1, Number(minutes) || 10)) * 60_000;
          const idle = this.#waitFor(t.id, () => this.#store.getThread(t.id)?.status !== "running");
          const timedOut = await Promise.race([idle.then(() => false), new Promise<boolean>((r) => setTimeout(() => r(true), ms))]);
          const now = this.#requireThread(t.id);
          if (timedOut) return { text: `Still working after ${ms / 60_000} minutes. ${line(now)}` };
          const run = this.#store.listRuns(t.id).at(-1);
          return { text: `${line(now)}\nLast turn: ${run?.status ?? "?"}\n\n${lastAnswer(now) || "(no answer)"}` };
        },
      },
      {
        name: "propose_pull_request",
        description:
          "When this thread's work (on its own branch) is ready: propose a pull request. The person sees a button to push the branch and open it; you can't push yourself.",
        params: { title: { description: "PR title." }, body: { description: "PR description: what changed, why, how to verify." } },
        run: async ({ title, body }) => {
          const t = this.#requireThread(threadId);
          if (!t.worktree) return { isError: true, text: "This thread works in the project folder, not on its own branch; there's nothing to open a pull request from." };
          if (!title?.trim()) return { isError: true, text: "Pass a title." };
          const id = randomUUID();
          this.#store.commit(threadId, [
            {
              type: "turn-item.upserted",
              item: { id: `note:${id}`, threadId, runId: t.activeRunId ?? `note:${id}`, kind: "note", text: `Proposed a pull request: **${title.trim()}**`, action: { kind: "open_pr", title: title.trim(), body: body?.trim() ?? "" } },
            },
          ]);
          return { text: "Proposed. The person will open it with one click; tell them briefly." };
        },
      },
    ];
  }

  /** Artifacts: agents publish pages and reports to the person's Artifacts list (and read the ones there). */
  #artifactTools(threadId: string): HarnessTool[] {
    const posted = (a: { id: string; title: string; version: number }, verb: string) => {
      const t = this.#store.getThread(threadId);
      const id = randomUUID();
      this.#store.commit(threadId, [
        {
          type: "turn-item.upserted",
          item: { id: `note:${id}`, threadId, runId: t?.activeRunId ?? `note:${id}`, kind: "note", text: `${verb} the artifact **${a.title}**${a.version > 1 ? ` (version ${a.version})` : ""}.`, action: { kind: "open_artifact", artifactId: a.id } },
        },
      ]);
    };
    const line = (a: { id: string; title: string; source: string; kind: string; version: number; updatedAt: string }) =>
      `${a.id.slice(0, 8)}  ${a.source === "claude" ? "claude.ai" : "bullpen"}  ${a.kind}${a.version ? ` v${a.version}` : ""}  "${a.title}"  ${a.updatedAt.slice(0, 10)}`;
    return [
      {
        name: "create_artifact",
        description:
          "Publish a page for the person: an HTML page (report, dashboard, diagram, prototype, slides) or a Markdown document. It appears in their Artifacts list and opens beside the chat. " +
          "Make HTML self-contained (inline CSS/JS; libraries only from a CDN). Use this for anything they'll look at rather than files for the project.",
        params: {
          title: { description: "Short name, e.g. 'Q3 latency report'." },
          content: { description: "The full HTML page or Markdown text. Or leave empty and pass file.", optional: true },
          file: { description: "Absolute path of an .html or .md file you wrote, instead of content.", optional: true },
          description: { description: "One sentence on what it is.", optional: true },
        },
        run: async (a) => {
          try {
            const content = a.content?.trim() ? a.content : a.file ? readText(a.file) : "";
            if (!content.trim()) return { isError: true, text: "Pass content or file." };
            const t = this.#requireThread(threadId);
            const art = this.artifacts.create({
              title: a.title ?? "",
              content,
              kind: a.file?.endsWith(".md") ? "markdown" : undefined,
              description: a.description,
              threadId,
              agentId: t.agentId,
              project: this.#projectOf(threadId),
            });
            posted(art, "Made");
            return { text: `Published as artifact ${art.id.slice(0, 8)} ("${art.title}"). Update it with update_artifact; tell the person it's in Artifacts.` };
          } catch (err) {
            return { isError: true, text: (err as Error).message };
          }
        },
      },
      {
        name: "update_artifact",
        description: "Replace an artifact's content with a new version (the old ones are kept).",
        params: {
          artifact: { description: "Its id (or first 8 characters)." },
          content: { description: "The full new content. Or pass file.", optional: true },
          file: { description: "Absolute path of the new .html or .md file.", optional: true },
          title: { description: "New title, if it changes.", optional: true },
        },
        run: async (a) => {
          try {
            const content = a.content?.trim() ? a.content : a.file ? readText(a.file) : "";
            if (!content.trim()) return { isError: true, text: "Pass content or file." };
            const art = this.artifacts.update(a.artifact ?? "", content, a.title);
            posted(art, "Updated");
            return { text: `Artifact ${art.id.slice(0, 8)} is now version ${art.version}.` };
          } catch (err) {
            return { isError: true, text: (err as Error).message };
          }
        },
      },
      {
        name: "list_artifacts",
        description: "List the person's artifacts: ones made in Bullpen and ones from their claude.ai account.",
        params: { search: { description: "Only titles containing this.", optional: true } },
        run: async ({ search }) => {
          const q = (search ?? "").toLowerCase();
          const list = this.#store.listArtifacts().filter((x) => !q || x.title.toLowerCase().includes(q)).slice(0, 40);
          return { text: list.map(line).join("\n") || "(no artifacts)" };
        },
      },
      {
        name: "read_artifact",
        description: "Read an artifact's content (HTML or Markdown). claude.ai artifacts must be copied into Bullpen first (the person can do that from Artifacts).",
        params: { artifact: { description: "Its id (or first 8 characters)." } },
        run: async ({ artifact }) => {
          try {
            const { artifact: x, content, version } = this.artifacts.content(artifact ?? "");
            const clipped = content.length > 60_000 ? `${content.slice(0, 60_000)}\n…[truncated]` : content;
            return { text: `${line(x)} (showing version ${version})\n\n${clipped}` };
          } catch (err) {
            const x = this.#store.listArtifacts().find((y) => y.id.startsWith(artifact ?? "-"));
            return { isError: true, text: x?.url ? `${(err as Error).message} It's on claude.ai at ${x.url}.` : (err as Error).message };
          }
        },
      },
    ];
  }

  /** A real browser (T3: preview_open/act/snapshot). The person sees the same page in the Browser panel. */
  #browserTools(threadId: string): HarnessTool[] {
    const b = this.browser;
    const wrap = (fn: (a: Record<string, string>) => Promise<string>) => async (a: Record<string, string>) => {
      try {
        return { text: await fn(a) };
      } catch (err) {
        return { isError: true, text: (err as Error).message.split("\n")[0] };
      }
    };
    return [
      {
        name: "browser_open",
        description:
          "Open a page in your browser (a real Chrome tab; the person sees it live in the Browser panel). Works for localhost dev servers and public sites. Then use browser_snapshot to read it.",
        params: { url: { description: "e.g. localhost:3000, http://localhost:5173/login, https://example.com" } },
        run: wrap(async ({ url }) => {
          const r = await b.open(threadId, url ?? "");
          return `Opened ${r.url} — "${r.title}". Use browser_snapshot to read it.`;
        }),
      },
      {
        name: "browser_snapshot",
        description: "Read the open page: its URL, title, and an accessibility tree of what's on it (headings, text, links, buttons, inputs).",
        params: {},
        run: wrap(() => b.snapshot(threadId)),
      },
      {
        name: "browser_click",
        description: "Click something on the open page.",
        params: { target: { description: "Visible text, 'button \"Save\"' / 'link \"Docs\"', or a CSS selector." } },
        run: wrap(({ target }) => b.click(threadId, target ?? "")),
      },
      {
        name: "browser_type",
        description: "Type into a field on the open page (replaces what's there).",
        params: {
          target: { description: "The field's label, placeholder, or a CSS selector." },
          text: { description: "What to type." },
          submit: { description: "'yes' to press Enter after typing.", optional: true },
        },
        run: wrap(({ target, text, submit }) => b.type(threadId, target ?? "", text ?? "", /^y/i.test(submit ?? ""))),
      },
      {
        name: "browser_press",
        description: "Press a key on the open page, e.g. Enter, Escape, Tab, ArrowDown, Meta+A.",
        params: { key: { description: "The key." } },
        run: wrap(({ key }) => b.press(threadId, key ?? "Enter")),
      },
      {
        name: "browser_screenshot",
        description: "Save a screenshot of the open page and return its file path; read that image file to see the page.",
        params: {},
        run: wrap(async () => `Saved ${await b.screenshot(threadId)}`),
      },
    ];
  }

  /**
   * The project a thread's current work is about: a normal thread's own folder, or for an agent's
   * home thread, the project it was called into (none when you're just talking to it).
   */
  #projectOf(threadId: string): string | undefined {
    const thread = this.#store.getThread(threadId);
    if (!thread) return undefined;
    return thread.agentId ? this.#runProjects.get(threadId) : workdirOf(thread);
  }

  #agentInstructions(agent: Agent): string {
    return [
      `You are ${agent.displayName ? `${agent.displayName} (@${agent.name})` : `@${agent.name}`}, a named long-running agent in Bullpen.${agent.description ? ` Role: ${agent.description}` : ""}`,
      "People talk to you directly, and other threads and agents consult you; each message says who is asking. " +
        "Your final message in a turn is returned to whoever asked, so make it a complete answer.",
      `You aren't tied to one project. When a request names a project folder, work in that folder using absolute ` +
        `paths (your shell starts in your own folder, ${agent.cwd}). Without one, just answer.`,
      `Your memory is ${join(agent.cwd, "MEMORY.md")}. Read it with your file-reading tool when a conversation starts. When you learn something ` +
        "worth keeping across projects (the user's preferences, decisions and their reasons, how a system works), " +
        "add a short line to it. Keep it tidy; don't store anything secret.",
      agent.instructions,
    ].join("\n\n");
  }

  #closeSession(threadId: string) {
    this.#sessions.get(threadId)?.close();
    this.#sessions.delete(threadId);
    this.#staleSessions.delete(threadId);
  }

  #requireAgent(agentId: string): Agent {
    const agent = this.#store.getAgent(agentId);
    if (!agent) throw new CommandError(`Unknown agent ${agentId}.`);
    return agent;
  }

  // ---------- turns ----------

  async #sendMessage(threadId: string, text: string, chain: string[], project?: string, team?: boolean, lessonHint?: boolean, resumed = 0) {
    const thread = this.#requireThread(threadId);
    if (thread.status === "running") throw new CommandError("A run is already active; interrupt it first.");
    if (!text.trim()) throw new CommandError("Empty message.");

    const ordinal = thread.runCount + 1;
    const run: Run = {
      id: randomUUID(),
      threadId,
      ordinal,
      status: "running",
      startedAt: new Date().toISOString(),
      request: { text, chain, project, team, resumed: resumed || undefined },
    };
    const userItem: TurnItem = { id: `user:${run.id}`, threadId, runId: run.id, kind: "user_message", text };
    const title = thread.runCount === 0 && thread.title === "New thread" ? text.slice(0, 60) : thread.title;

    // Hand over answers from agents @mentioned here since this agent's last turn.
    const replies = this.#store.undeliveredReplies(threadId);
    let agentText = text;
    if (replies.length) {
      const notes = replies.map((r) =>
        r.kind === "agent_reply" ? `@${r.agentName}${r.status === "failed" ? " (failed)" : ""}:\n${r.text}` : "",
      );
      agentText = `Answers from agents @mentioned in this thread since your last turn:\n\n${notes.join("\n\n")}\n\n---\n\n${text}`;
    }

    this.#store.commit(threadId, [
      ...replies.map((item): DomainEvent => ({ type: "turn-item.upserted", item: { ...item, delivered: true } as TurnItem })),
      { type: "run.upserted", run },
      { type: "turn-item.upserted", item: userItem },
      { type: "thread.upserted", thread: { ...thread, title, status: "running", activeRunId: run.id, runCount: ordinal, updatedAt: run.startedAt } },
    ]);

    // Baseline snapshot before the agent touches anything (only needed once per thread,
    // since checkpoint N doubles as the baseline for turn N+1).
    if (!this.#store.getCheckpoint(threadId, ordinal - 1)) {
      await this.#captureCheckpoint(threadId, run.id, ordinal - 1, false);
    }

    // Approved lessons ride along with every turn (they apply in every project), plus a nudge to propose one
    // when the person sounds like they're correcting how the agent works.
    const lessons = this.#lessonsFor(thread.agentId);
    if (lessons.length) agentText = `Lessons from the person (always follow these):\n${lessons.map((l) => `- ${l}`).join("\n")}\n\n---\n\n${agentText}`;
    if (lessonHint) agentText = `${agentText}\n\n${LESSON_HINT}`;
    if (resumed) agentText = `${RESUME_NOTE}\n\n---\n\n${agentText}`;
    this.#runChains.set(threadId, chain);
    if (project) this.#runProjects.set(threadId, project);
    else this.#runProjects.delete(threadId);
    this.#session(threadId).startTurn({ runId: run.id, text: agentText, workdir: project, team, mode: this.#turnMode(thread, project) });
    return { runId: run.id, ordinal };
  }

  /** The project's permission level reaches every agent working there; a thread or agent set higher keeps its own. */
  #turnMode(thread: Thread, workdir?: string): RuntimeMode {
    const projectMode = this.#projectFor(workdir ?? thread.cwd)?.runtimeMode;
    return projectMode && MODE_RANK[projectMode] > MODE_RANK[thread.runtimeMode] ? projectMode : thread.runtimeMode;
  }

  /** The project a folder belongs to, including worktrees made from it. */
  #projectFor(dir: string): Project | undefined {
    const direct = this.#store.getProjectByPath(dir);
    if (direct) return direct;
    const main = worktrees.mainCheckoutOf(dir);
    return main ? this.#store.getProjectByPath(main) : undefined;
  }

  #session(threadId: string): ProviderSession {
    let session = this.#sessions.get(threadId);
    if (session) return session;
    const thread = this.#requireThread(threadId);
    const adapter = this.#adapters.get(thread.provider);
    if (!adapter) throw new CommandError(`No adapter for provider "${thread.provider}".`);
    const agent = thread.agentId ? this.#store.getAgent(thread.agentId) : undefined;
    session = adapter.openSession({
      threadId,
      cwd: workdirOf(thread),
      runtimeMode: thread.runtimeMode,
      model: thread.model,
      resumeNativeSessionId: thread.nativeSessionId,
      rewind: thread.rewind,
      instructions: agent ? this.#agentInstructions(agent) : undefined,
      ownFolder: agent ? agent.cwd : undefined,
      tools: this.#harnessTools(threadId),
      emit: (event) => this.#ingest(threadId, event),
    });
    this.#sessions.set(threadId, session);
    return session;
  }

  /** Provider events -> domain events. */
  #ingest(threadId: string, event: AdapterEvent) {
    const thread = this.#store.getThread(threadId);
    if (!thread) return;
    switch (event.type) {
      case "native_session.updated":
        if (thread.nativeSessionId !== event.nativeSessionId || thread.rewind) {
          // A rewind is applied once the engine has reopened on it.
          this.#store.commit(threadId, [
            { type: "thread.upserted", thread: { ...thread, nativeSessionId: event.nativeSessionId, rewind: undefined } },
          ]);
        }
        return;
      case "turn_item.updated":
        // Ownership guard: drop late events from a run that is no longer active (T3: writeIfRunCurrent).
        if (event.item.runId !== thread.activeRunId) return;
        this.#store.commit(threadId, [{ type: "turn-item.upserted", item: event.item }]);
        if (event.item.kind === "approval_request" && thread.agentId) this.#team.onApprovalChange(threadId);
        return;
      case "turn.terminal":
        void this.#serial(threadId, () => this.#finishRun(threadId, event));
        return;
    }
  }

  async #finishRun(threadId: string, event: Extract<AdapterEvent, { type: "turn.terminal" }>) {
    const run = this.#store.getRun(event.runId);
    const thread = this.#store.getThread(threadId);
    if (!run || !thread || run.status !== "running") return;

    const events: DomainEvent[] = [
      {
        type: "run.upserted",
        run: {
          ...run,
          status: event.outcome,
          error: event.error,
          costUsd: event.costUsd,
          tokens: event.tokens,
          nativeTurnId: event.nativeTurnId,
          request: undefined, // done: nothing to resume
          endedAt: new Date().toISOString(),
        },
      },
    ];
    if (event.error) {
      events.push({
        type: "turn-item.upserted",
        item: { id: `error:${run.id}`, threadId, runId: run.id, kind: "error", message: event.error },
      });
    }
    this.#store.commit(threadId, events);
    await this.#captureCheckpoint(threadId, run.id, run.ordinal, true);
    this.#runChains.delete(threadId);
    this.#runProjects.delete(threadId);
    if (this.#staleSessions.has(threadId)) this.#closeSession(threadId);
    const latest = this.#store.getThread(threadId) ?? thread;
    this.#store.commit(threadId, [
      { type: "thread.upserted", thread: { ...latest, status: "idle", activeRunId: undefined, updatedAt: new Date().toISOString() } },
    ]);
  }

  async #captureCheckpoint(threadId: string, runId: string, ordinal: number, announce: boolean) {
    const thread = this.#requireThread(threadId);
    const dir = workdirOf(thread);
    if (!(await checkpoints.isGitRepo(dir))) return;
    try {
      const ref = checkpoints.checkpointRef(threadId, ordinal);
      const commit = await checkpoints.capture(dir, ref, `checkpoint ${ordinal} for thread ${threadId}`);
      const checkpoint: Checkpoint = { threadId, ordinal, ref, commit, capturedAt: new Date().toISOString() };
      const events: DomainEvent[] = [{ type: "checkpoint.captured", checkpoint }];
      const previous = this.#store.getCheckpoint(threadId, ordinal - 1);
      if (announce && previous) {
        const files = await checkpoints.changedFiles(dir, previous.ref, ref);
        events.push({
          type: "turn-item.upserted",
          item: { id: `checkpoint:${runId}`, threadId, runId, kind: "checkpoint", ordinal, ref, filesChanged: files.length },
        });
      }
      this.#store.commit(threadId, events);
    } catch (err) {
      console.error(`[checkpoint] capture failed for ${threadId}#${ordinal}:`, err);
    }
  }

  async #rollback(threadId: string, ordinal: number) {
    const thread = this.#requireThread(threadId);
    if (thread.status === "running") throw new CommandError("Interrupt the active run before rolling back.");
    const target = this.#store.getCheckpoint(threadId, ordinal);
    if (!target) throw new CommandError(`No checkpoint ${ordinal} for this thread.`);
    const safetyRef = `${checkpoints.checkpointRef(threadId, ordinal)}-undo-${Date.now()}`;
    await checkpoints.restore(workdirOf(thread), target.ref, safetyRef);

    // Rewind the conversation too (T3 does), so the agent forgets the undone turns.
    const runs = this.#store.listRuns(threadId).filter((r) => !r.rewound && !r.id.startsWith("mention:"));
    const dropped = runs.filter((r) => r.ordinal > ordinal);
    const kept = runs.filter((r) => r.ordinal <= ordinal).sort((a, b) => b.ordinal - a.ordinal)[0];
    let rewind: Thread["rewind"];
    let conversation: "rewound" | "unchanged" | "restarted" = "unchanged";
    if (dropped.length) {
      if (ordinal === 0 || !kept) conversation = "restarted";
      else if (thread.provider === "claude" && kept.nativeTurnId) {
        rewind = { keepThrough: kept.nativeTurnId };
        conversation = "rewound";
      } else if (thread.provider === "codex" && dropped.sort((a, b) => a.ordinal - b.ordinal)[0].nativeTurnId) {
        rewind = { dropFrom: dropped[0].nativeTurnId };
        conversation = "rewound";
      }
    }
    const events: DomainEvent[] = [];
    if (conversation !== "unchanged") {
      this.#closeSession(threadId);
      for (const r of dropped) events.push({ type: "run.upserted", run: { ...r, rewound: true } });
      const latest = this.#requireThread(threadId);
      events.push({
        type: "thread.upserted",
        thread: { ...latest, rewind, nativeSessionId: conversation === "restarted" ? undefined : latest.nativeSessionId },
      });
    }
    if (events.length) this.#store.commit(threadId, events);
    // The next turn's "before" snapshot must be the restored files, not what was there before the rollback.
    const latest = this.#requireThread(threadId);
    if (latest.runCount > ordinal) await this.#captureCheckpoint(threadId, `rollback:${Date.now()}`, latest.runCount, false);
    this.#note(
      threadId,
      conversation === "unchanged"
        ? `Files restored to after turn ${ordinal}. The agent still remembers the later turns (this engine can't rewind them).`
        : `Restored files and conversation to ${ordinal === 0 ? "the start" : `after turn ${ordinal}`}. The agent no longer remembers the turns after that.`,
    );
    return { restoredTo: ordinal, undoRef: safetyRef, conversation };
  }

  #requireThread(threadId: string): Thread {
    const thread = this.#store.getThread(threadId);
    if (!thread) throw new CommandError(`Unknown thread ${threadId}.`);
    return thread;
  }

  #serial<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.#locks.get(key) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    this.#locks.set(key, next.catch(() => {}));
    return next;
  }

  /** On startup, any run still marked running was orphaned by a crash/restart. */
  #recoverInterruptedRuns() {
    // Threads from before projects existed: give each normal thread's folder a project.
    for (const thread of this.#store.listThreads()) {
      if (!thread.agentId && !this.#store.getProjectByPath(thread.cwd)) this.#ensureProject(thread.cwd);
    }
    // Prompts and @mention replies that were in flight died with the old process.
    for (const item of this.#store.pendingApprovals()) {
      this.#store.commit(item.threadId, [{ type: "turn-item.upserted", item: { ...item, status: "resolved", decision: "cancel" } as TurnItem }]);
    }
    for (const item of this.#store.runningReplies()) {
      if (item.kind === "agent_reply" && item.retry) {
        this.#resumeQueue.push(() => this.#runMention(item)); // ask again once everything is up
        continue;
      }
      this.#store.commit(item.threadId, [
        { type: "turn-item.upserted", item: { ...item, status: "failed", text: "Server restarted before the agent answered." } as TurnItem },
      ]);
    }
    for (const thread of this.#store.listThreads()) {
      if (thread.status !== "running") continue;
      const run = thread.activeRunId ? this.#store.getRun(thread.activeRunId) : undefined;
      const events: DomainEvent[] = [
        { type: "thread.upserted", thread: { ...thread, status: "idle", activeRunId: undefined } },
      ];
      if (run && run.status === "running") {
        events.unshift({
          type: "run.upserted",
          run: { ...run, status: "interrupted", error: "Server restarted", endedAt: new Date().toISOString() },
        });
      }
      this.#store.commit(thread.id, events);
      // Pick the turn back up, once. Agents' own threads are driven by whoever called them (team tasks requeue
      // themselves, @mentions are asked again above, an ask_agent caller resumes its own turn).
      const req = run?.request;
      if (run?.status === "running" && req && !thread.agentId && !thread.jobId && !req.resumed) {
        this.#resumeQueue.push(() => {
          void this.#serial(thread.id, () => this.#sendMessage(thread.id, req.text, req.chain, req.project, req.team, false, 1)).catch((err) =>
            console.error(`[resume] ${thread.id}:`, err),
          );
        });
      }
    }
  }

  /** Work to restart after a crash, run once the team and jobs are up. */
  readonly #resumeQueue: Array<() => void> = [];

  /** Call after construction: resumes turns and @mention answers that a restart interrupted. */
  resumeInterrupted() {
    for (const fn of this.#resumeQueue.splice(0)) fn();
  }
}
