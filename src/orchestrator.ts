// Command handling + provider event ingestion (T3: OrchestratorV2 + RunExecutionService +
// ProviderEventIngestor). Commands validate against projections and commit domain events;
// side effects (provider calls, git snapshots) run after the commit.
//
// Simplification vs T3: no transactional outbox / lease worker. Side effects run in-process
// right after commit, so a crash mid-turn leaves the run "running" until restart cleanup.

import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { HOME } from "./home.ts";
import { Jobs } from "./jobs.ts";
import { Team, isLimitError, type ConsultOutcome } from "./team.ts";
import * as checkpoints from "./checkpoints.ts";
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
/** How many agents deep a chain of ask_agent calls may go. */
const MAX_CONSULT_DEPTH = 3;
/** How much of the calling thread an @mentioned agent gets to see. */
const MENTION_CONTEXT_CHARS = 8000;
/** Messages that sound like the person correcting how an agent works (a lesson may be worth keeping). */
const CORRECTION = /\b(no[,.!]|nope|don'?t|do not|never|always|instead|stop|wrong|not like that|we use|we don'?t|i prefer|prefer|please use|should (be|use)|from now on|remember)\b/i;
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
  }

  async dispatch(command: Command): Promise<unknown> {
    switch (command.type) {
      case "thread.create":
        return this.#createThread(command);
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
        return { added };
      }
      case "project.update": {
        const project = this.#store.getProject(command.projectId);
        if (!project) throw new CommandError("Unknown project.");
        const next: Project = { ...project };
        if (command.title !== undefined) next.title = command.title.trim() || project.title;
        if (command.pinned !== undefined) next.pinnedAt = command.pinned ? new Date().toISOString() : undefined;
        if (command.archived !== undefined) next.archivedAt = command.archived ? new Date().toISOString() : undefined;
        if (command.runtimeMode !== undefined) next.runtimeMode = command.runtimeMode ?? undefined;
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
    return checkpoints.diff(thread.cwd, from.ref, to.ref);
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
      void this.#consult(agent, prompt, chain, project).then(({ ok, text: answer }) => {
        this.#store.commit(thread.id, [
          { type: "turn-item.upserted", item: { ...item, status: ok ? "completed" : "failed", text: answer } },
        ]);
      });
    }
    return { mentionId, agents: agents.map((a) => a.name) };
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

  /**
   * The project a thread's current work is about: a normal thread's own folder, or for an agent's
   * home thread, the project it was called into (none when you're just talking to it).
   */
  #projectOf(threadId: string): string | undefined {
    const thread = this.#store.getThread(threadId);
    if (!thread) return undefined;
    return thread.agentId ? this.#runProjects.get(threadId) : thread.cwd;
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

  async #sendMessage(threadId: string, text: string, chain: string[], project?: string, team?: boolean, lessonHint?: boolean) {
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
    this.#runChains.set(threadId, chain);
    if (project) this.#runProjects.set(threadId, project);
    else this.#runProjects.delete(threadId);
    this.#session(threadId).startTurn({ runId: run.id, text: agentText, workdir: project, team, mode: this.#turnMode(thread, project) });
    return { runId: run.id, ordinal };
  }

  /** The project's permission level reaches every agent working there; a thread or agent set higher keeps its own. */
  #turnMode(thread: Thread, workdir?: string): RuntimeMode {
    const projectMode = this.#store.getProjectByPath(workdir ?? thread.cwd)?.runtimeMode;
    return projectMode && MODE_RANK[projectMode] > MODE_RANK[thread.runtimeMode] ? projectMode : thread.runtimeMode;
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
      cwd: thread.cwd,
      runtimeMode: thread.runtimeMode,
      model: thread.model,
      resumeNativeSessionId: thread.nativeSessionId,
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
        if (thread.nativeSessionId !== event.nativeSessionId) {
          this.#store.commit(threadId, [
            { type: "thread.upserted", thread: { ...thread, nativeSessionId: event.nativeSessionId } },
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
        run: { ...run, status: event.outcome, error: event.error, costUsd: event.costUsd, tokens: event.tokens, endedAt: new Date().toISOString() },
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
    if (!(await checkpoints.isGitRepo(thread.cwd))) return;
    try {
      const ref = checkpoints.checkpointRef(threadId, ordinal);
      const commit = await checkpoints.capture(thread.cwd, ref, `checkpoint ${ordinal} for thread ${threadId}`);
      const checkpoint: Checkpoint = { threadId, ordinal, ref, commit, capturedAt: new Date().toISOString() };
      const events: DomainEvent[] = [{ type: "checkpoint.captured", checkpoint }];
      const previous = this.#store.getCheckpoint(threadId, ordinal - 1);
      if (announce && previous) {
        const files = await checkpoints.changedFiles(thread.cwd, previous.ref, ref);
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
    await checkpoints.restore(thread.cwd, target.ref, safetyRef);
    // Files only: unlike T3, the agent's conversation is NOT rewound. Tell it so on the next turn.
    return { restoredTo: ordinal, undoRef: safetyRef };
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
    }
  }
}
