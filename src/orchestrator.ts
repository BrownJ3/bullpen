// Command handling + provider event ingestion (T3: OrchestratorV2 + RunExecutionService +
// ProviderEventIngestor). Commands validate against projections and commit domain events;
// side effects (provider calls, git snapshots) run after the commit.
//
// Crash safety (T3 uses a transactional outbox): each run stores what was asked in the same transaction that
// starts it. If Bullpen stops mid-turn, the run is marked interrupted on restart and the turn is resumed from
// the engine's saved conversation, once.

import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { HOME } from "./home.ts";
import { Jobs } from "./jobs.ts";
import { Team, type ConsultOutcome } from "./team.ts";
import { isLimitError, LIMITS } from "./limits.ts";
import { AGENT_TEMPLATES } from "./agent-templates.ts";
import * as checkpoints from "./checkpoints.ts";
import * as worktrees from "./worktrees.ts";
import { BrowserHub } from "./browser.ts";
import { claudeSessions, codexSessions, findSession, sessionHistory, type PastSession } from "./sessions.ts";
import { Artifacts } from "./artifacts.ts";
import { activitySig, runActivity } from "./activity.ts";
import { finishReply, postNote } from "./notes.ts";
import type { ToolContext } from "./tools/context.ts";
import { threadTools } from "./tools/threads.ts";
import { artifactTools } from "./tools/artifacts.ts";
import { browserTools } from "./tools/browser.ts";
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
/** Spare copies an agent may have running at once, so a busy agent doesn't block other requests. */
const MAX_CLONES = 3;
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
      recruit: (role) => this.#recruit(role),
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
    // Live progress on @mention replies that are still being worked on.
    this.#ticker = setInterval(() => this.#tickMentions(), 3000);
    this.#ticker.unref();
  }

  #ticker: NodeJS.Timeout;
  /** @mention replies in progress: where their agent's run is. */
  readonly #mentionRuns = new Map<string, { threadId: string; runThreadId: string; runId: string; sig: string }>();

  #tickMentions() {
    for (const [itemId, w] of this.#mentionRuns) {
      const item = this.#store.getTurnItem(itemId);
      if (!item || item.kind !== "agent_reply" || item.status !== "running") {
        this.#mentionRuns.delete(itemId);
        continue;
      }
      const activity = runActivity(this.#store, w.runThreadId, w.runId);
      const sig = activitySig(activity);
      if (sig === w.sig) continue;
      w.sig = sig;
      this.#store.commit(w.threadId, [{ type: "turn-item.upserted", item: { ...item, activity } }]);
    }
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
      case "thread.setModel": {
        const thread = this.#requireThread(command.threadId);
        const model = command.model === undefined ? thread.model : command.model.trim() || undefined;
        // An agent's chat follows the agent: change the agent, and every copy of it follows.
        if (thread.agentId && !thread.cloneOf) {
          if (command.provider && command.provider !== thread.provider) throw new CommandError("An agent's engine is set when it's created. Make a new agent to use another engine.");
          return this.#updateAgent({ type: "agent.update", agentId: thread.agentId, model: model ?? "" });
        }
        let provider = thread.provider;
        if (command.provider && command.provider !== thread.provider) {
          if (!this.#adapters.has(command.provider)) throw new CommandError(`Unknown engine "${command.provider}".`);
          // The conversation lives inside the engine, so it can only switch before there is one.
          if (thread.nativeSessionId) throw new CommandError("This chat has already started with " + thread.provider + ". Start a new chat to use another engine.");
          provider = command.provider;
        }
        const switched = provider !== thread.provider;
        this.#store.commit(thread.id, [{ type: "thread.upserted", thread: { ...thread, provider, model: switched && command.model === undefined ? undefined : model } }]);
        // The model is fixed when a session opens: reopen it (the conversation resumes) once it's idle.
        if (thread.status === "running") this.#staleSessions.add(thread.id);
        else this.#closeSession(thread.id);
        return { ok: true };
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
        let sessions = 0;
        if (command.sessions) {
          const since = Date.now() - 30 * 24 * 3600_000;
          for (const item of command.projects) {
            let dir: string;
            try {
              dir = this.#resolveDir(item.path);
            } catch {
              continue;
            }
            const recent = [...claudeSessions(dir, command.sessions), ...codexSessions(dir, command.sessions)]
              .filter((x) => Date.parse(x.updatedAt) >= since)
              .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
              .slice(0, command.sessions);
            for (const x of recent) {
              if (this.#importSession(dir, x).created) sessions++;
            }
          }
        }
        return { added, sessions };
      }
      case "session.import": {
        const dir = this.#resolveDir(command.path);
        const found = findSession(command.tool, command.id, dir);
        if (!found) throw new CommandError("That session wasn't found (it may have been deleted).");
        return { threadId: this.#importSession(dir, found).threadId };
      }
      case "thread.backfill":
        return this.#serial(command.threadId, async () => {
          const t = this.#requireThread(command.threadId);
          if (!t.importedFrom || !t.nativeSessionId || t.importedFrom.history) return { ok: true, items: 0 };
          const found = findSession(t.importedFrom.tool, t.nativeSessionId, t.cwd);
          return { ok: true, items: found ? this.#writeHistory(t, found) : 0 };
        });
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
        for (const c of this.#store.listThreads().filter((x) => x.cloneOf === agent.id)) {
          this.#closeSession(c.id);
          this.#store.commit(c.id, [{ type: "thread.upserted", thread: { ...c, agentId: undefined } }]);
        }
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
    clearInterval(this.#ticker);
    // Requests waiting for your OK are cancelled by closing their sessions: say so in their chats.
    const waiting = new Map<string, number>();
    for (const item of this.#store.pendingApprovals()) waiting.set(item.threadId, (waiting.get(item.threadId) ?? 0) + 1);
    for (const [threadId, n] of waiting) {
      this.#note(threadId, `Bullpen restarted, so ${n === 1 ? "a request waiting for your OK was" : `${n} requests waiting for your OK were`} cancelled. The agent asks again when it picks the work back up.`);
    }
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
    };
    this.#store.commit(thread.id, [{ type: "thread.upserted", thread }]);
    return { threadId: thread.id };
  }

  /** A thread that continues a past session, with its recent conversation shown. Reuses one already imported. */
  #importSession(dir: string, s: PastSession): { threadId: string; created: boolean } {
    const existing = this.#store.listThreads().find((t) => t.nativeSessionId === s.id);
    if (existing) return { threadId: existing.id, created: false };
    if (!this.#adapters.has(s.tool)) throw new CommandError(`${s.tool === "codex" ? "Codex" : "Claude Code"} isn't available in this Bullpen.`);
    const { threadId } = this.#createThread({ type: "thread.create", cwd: dir, provider: s.tool, title: s.title, model: s.model });
    const t = this.#requireThread(threadId);
    const imported: Thread = { ...t, nativeSessionId: s.id, importedFrom: { tool: s.tool, title: s.title, at: s.updatedAt }, updatedAt: s.updatedAt };
    this.#store.commit(threadId, [{ type: "thread.upserted", thread: imported }]);
    this.#writeHistory(imported, s);
    return { threadId, created: true };
  }

  /** Put a past session's recent conversation into its thread (shown, and given to @mentioned agents as context). */
  #writeHistory(thread: Thread, s: PastSession): number {
    const { items, truncated } = sessionHistory(s);
    const runId = `import:${s.id}`;
    const events: DomainEvent[] = items.map((it, n): DomainEvent => {
      const base = { id: `import:${thread.id}:${n}`, threadId: thread.id, runId };
      if (it.kind === "tool_call") {
        return { type: "turn-item.upserted", item: { ...base, kind: "tool_call", tool: it.tool, input: it.input, status: it.failed ? "failed" : "completed", output: it.output } };
      }
      if (it.kind === "assistant_message") return { type: "turn-item.upserted", item: { ...base, kind: "assistant_message", text: it.text, streaming: false } };
      return { type: "turn-item.upserted", item: { ...base, kind: "user_message", text: it.text } };
    });
    const latest = this.#requireThread(thread.id);
    events.push({ type: "thread.upserted", thread: { ...latest, importedFrom: { ...(latest.importedFrom ?? { tool: s.tool, title: s.title, at: s.updatedAt }), history: { items: items.length, truncated } } } });
    // One transaction per few hundred rows keeps the UI responsive.
    for (let i = 0; i < events.length; i += 200) this.#store.commit(thread.id, events.slice(i, i + 200));
    return items.length;
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
    postNote(this.#store, threadId, text, { runId: `note:${randomUUID()}` });
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
    // Reopen the session with the new settings; the conversation resumes from the native session. Copies too.
    for (const t of [home, ...this.#store.listThreads().filter((x) => x.cloneOf === agent.id)]) {
      if (t.cloneOf) this.#store.commit(t.id, [{ type: "thread.upserted", thread: { ...t, model: next.model, runtimeMode: next.runtimeMode } }]);
      if (t.status === "running") this.#staleSessions.add(t.id);
      else this.#closeSession(t.id);
    }
    return { ok: true };
  }

  /** The lead hires: an agent on the team for that role, or a new one from the ready-made templates. */
  #recruit(role: string): { agent: Agent; hired: boolean } | { error: string } {
    const q = role.trim().toLowerCase().replace(/^@/, "");
    if (!q) return { error: "Say which role, e.g. frontend, tester, devops." };
    const t = AGENT_TEMPLATES.find((x) => x.id === q || x.handle === q || x.name.toLowerCase() === q)
      ?? AGENT_TEMPLATES.find((x) => x.name.toLowerCase().includes(q) || x.id.includes(q) || x.description.toLowerCase().includes(q));
    if (!t) return { error: `No ready-made specialist for "${role}". Options: ${AGENT_TEMPLATES.map((x) => x.handle).join(", ")}.` };
    const existing = this.#store.listAgents().find((a) => a.templateId === t.id);
    if (existing) return { agent: existing, hired: false };
    if (this.#store.listAgents().length >= LIMITS.maxTeamSize) return { error: `The team already has ${LIMITS.maxTeamSize} agents; work with them or ask the person.` };
    const { agentId } = this.#createAgent({ type: "agent.create", name: t.name, handle: t.handle, templateId: t.id, description: t.description, instructions: t.instructions });
    return { agent: this.#requireAgent(agentId), hired: true };
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
    void this.#consult(agent, item.retry.prompt, item.retry.chain, item.retry.project, {
      onRun: (runThreadId, runId) => {
        this.#mentionRuns.set(item.id, { threadId: item.threadId, runThreadId, runId, sig: "" });
        // Where the work is actually running (the agent, or a spare copy of it): "Watch" opens this.
        const latest = this.#store.getTurnItem(item.id);
        if (latest?.kind === "agent_reply") this.#store.commit(item.threadId, [{ type: "turn-item.upserted", item: { ...latest, runThreadId } }]);
      },
    }).then(({ ok, text: answer }) => {
      this.#mentionRuns.delete(item.id);
      finishReply(this.#store, item, ok, answer);
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
    opts: { team?: boolean; onRun?: (homeThreadId: string, runId: string) => void; thread?: string } = {},
  ): Promise<ConsultOutcome> {
    if (chain.includes(agent.id)) {
      return Promise.resolve({
        ok: false,
        text: `@${agent.name} is already waiting further up this chain of requests; asking it again would deadlock.`,
      });
    }
    if (chain.length >= MAX_CONSULT_DEPTH) {
      return Promise.resolve({ ok: false, text: `Too many nested agent consultations (limit ${MAX_CONSULT_DEPTH}).` });
    }
    return (async (): Promise<ConsultOutcome> => {
      let home = agent.homeThreadId;
      for (;;) {
        // The agent itself if it's free; otherwise a spare copy (same instructions and memory), so requests run in
        // parallel instead of queuing behind whatever it's doing. With every copy busy, wait for the agent.
        // A wrap-up or a resumed task goes back to the thread that did the work (it remembers it).
        home = opts.thread && this.#store.getThread(opts.thread) ? opts.thread : this.#freeThreadFor(agent);
        await this.#waitFor(home, () => this.#store.getThread(home)?.status !== "running");
        let runId: string;
        try {
          ({ runId } = await this.#serial(home, () => this.#sendMessage(home, prompt, [...chain, agent.id], project, opts.team)));
          opts.onRun?.(home, runId);
        } catch (err) {
          if (err instanceof CommandError && err.message.startsWith("A run is already active")) continue; // taken meanwhile: pick again
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
    })();
  }

  /** Where a request to this agent can start now: the agent, an idle copy, a new copy, or (all busy) the agent. */
  #freeThreadFor(agent: Agent): string {
    const idle = (id: string) => this.#store.getThread(id)?.status === "idle" && !this.#claimed.has(id);
    const pick = (id: string) => {
      // Held until its run starts, so two requests at once don't pick the same thread.
      this.#claimed.add(id);
      setTimeout(() => this.#claimed.delete(id), 3000);
      return id;
    };
    if (idle(agent.homeThreadId)) return pick(agent.homeThreadId);
    const clones = this.#store.listThreads().filter((t) => t.cloneOf === agent.id);
    const free = clones.find((t) => idle(t.id));
    if (free) return pick(free.id);
    if (clones.length < MAX_CLONES) {
      const { threadId } = this.#createThread(
        { type: "thread.create", cwd: agent.cwd, provider: agent.provider, model: agent.model, runtimeMode: agent.runtimeMode, title: `${agent.displayName ?? `@${agent.name}`} (copy ${clones.length + 1})` },
        false,
      );
      const t = this.#requireThread(threadId);
      this.#store.commit(threadId, [{ type: "thread.upserted", thread: { ...t, agentId: agent.id, cloneOf: agent.id } }]);
      return pick(threadId);
    }
    return agent.homeThreadId;
  }
  readonly #claimed = new Set<string>();

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
      {
        name: "report_progress",
        description:
          "Tell the person (and your lead, on a team task) where you are, in one short sentence, e.g. 'Scoring done; now the results screen'. Use it after each meaningful step of longer work; it shows live in the chat.",
        params: { note: { description: "One short sentence." } },
        run: async ({ note }) => {
          const text = (note ?? "").trim().slice(0, 300);
          if (!text) return { isError: true, text: "Pass a note." };
          if (!this.#team.progress(threadId, text)) postNote(this.#store, threadId, text, { progress: true });
          return { text: "Noted. Keep going." };
        },
      },
      ...threadTools(this.#toolContext, threadId),
      ...artifactTools(this.#toolContext, threadId),
      ...browserTools(this.#toolContext, threadId),
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

  /** What the harness tools need from here (src/tools/*). */
  get #toolContext(): ToolContext {
    return {
      store: this.#store,
      artifacts: this.artifacts,
      browser: this.browser,
      requireThread: (id) => this.#requireThread(id),
      projectOf: (id) => this.#projectOf(id),
      transcript: (id) => this.#transcript(id),
      waitFor: (id, done) => this.#waitFor(id, done),
      dispatch: (cmd) => this.dispatch(cmd),
      startAgentThread: (threadId, caller, root, a) => this.#startAgentThread(threadId, caller, root, a),
    };
  }

  /** start_thread: a new chat in a project with its own agent, on its own branch when it's a git repo. */
  async #startAgentThread(threadId: string, caller: Thread, root: string, a: Record<string, string>): Promise<Thread> {
    const git = await checkpoints.isGitRepo(root);
    const wantBranch = a.branch ? /^y/i.test(a.branch) : git;
    {
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
      return this.#requireThread(id);
    }
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
        "Your final message in a turn is returned to whoever asked, so make it a complete answer, and don't end a turn while something you started is still running (wait for it).",
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

  /** Waiting to restart (an update): nothing new starts, running turns finish. */
  draining = false;

  /** Turns running right now. */
  busy(): { running: number; threads: string[] } {
    const running = this.#store.listThreads().filter((t) => t.status === "running");
    return { running: running.length, threads: running.map((t) => t.title).slice(0, 8) };
  }

  async #sendMessage(threadId: string, text: string, chain: string[], project?: string, team?: boolean, lessonHint?: boolean, resumed = 0) {
    if (this.draining) {
      // Agents' own work (team tasks, @mentions) waits; it's picked back up after the restart.
      if (chain.length || team) await new Promise(() => {});
      throw new CommandError("Bullpen is restarting for an update in a moment; send this again once it's back.");
    }
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
      access: this.#access(thread, project, team),
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

  /** A turn's access in plain words, with what decided it. Mirrors #turnMode and the team rules in the providers. */
  #access(thread: Thread, workdir?: string, team?: boolean): NonNullable<Run["access"]> {
    const label = { "approval-required": "Ask first", "auto-accept-edits": "Build automatically", "full-access": "Full access" } as const;
    const mode = this.#turnMode(thread, workdir);
    const dir = workdir ?? (thread.agentId ? undefined : workdirOf(thread));
    const project = dir ? this.#projectFor(dir) : undefined;
    const agent = thread.agentId ? this.#store.getAgent(thread.agentId) : undefined;
    const reasons = [
      project ? `Project ${project.title}: ${label[project.runtimeMode ?? "approval-required"]}` : agent ? "Not working in a project" : "",
      agent ? `${agent.displayName ?? `@${agent.name}`}'s own setting: ${label[thread.runtimeMode]}` : `This chat: ${label[thread.runtimeMode]}`,
      "The higher of the two applies.",
      team && mode !== "full-access" ? "On a team task, edits in its own copy and tests/builds also run without asking." : "",
      agent ? "Its own notes folder (memory) can always be edited." : "",
    ].filter(Boolean);
    return { mode, team: team || undefined, reasons };
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
        item: { id: `error:${run.id}`, threadId, runId: run.id, kind: "error", message: event.error + signInHint(thread.provider, event.error) },
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
    // Prompts and @mention replies that were in flight died with the old process. Say so, so they don't just vanish.
    const cancelled = new Map<string, number>();
    for (const item of this.#store.pendingApprovals()) {
      this.#store.commit(item.threadId, [{ type: "turn-item.upserted", item: { ...item, status: "resolved", decision: "cancel" } as TurnItem }]);
      cancelled.set(item.threadId, (cancelled.get(item.threadId) ?? 0) + 1);
    }
    for (const [threadId, n] of cancelled) {
      this.#note(threadId, `Bullpen restarted, so ${n === 1 ? "a request waiting for your OK was" : `${n} requests waiting for your OK were`} cancelled. The agent asks again when it picks the work back up.`);
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

/** An engine whose sign-in expired fails every turn; say how to sign in again. */
function signInHint(provider: string, error: string): string {
  if (!/authenticat|oauth|not logged in|log ?in again|invalid api key|unauthori[sz]ed|\b401\b|credentials/i.test(error)) return "";
  const how: Record<string, string> = {
    claude: "open a terminal, run claude, type /login and sign in",
    codex: "open a terminal and run: codex login",
  };
  return `\n\nThe engine's sign-in has expired. To fix it, ${how[provider] ?? `sign in to ${provider} again from a terminal`}, then send your message again.`;
}
