// Teams: a lead agent turns a goal into tracked tasks for specialists, reviews each result once, and reports.
// Modeled on AgentOffice (delegate → submit → one-round review, reason-tagged wake-ups, retry-then-park,
// recovery sweep, stuck detection), scaled down to one goal per @mention in a thread.
//
// Nobody holds a turn open waiting for someone else: the lead's turn ends after it delegates, and it's
// woken with a reason ("T2 submitted", "T3 parked", "the person added…"). Wake-ups are batched.

import { randomUUID } from "node:crypto";
import { relative, isAbsolute } from "node:path";
import { execFileSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import type { Store } from "./store.ts";
import { shellWrites } from "./team-policy.ts";
import * as worktrees from "./worktrees.ts";
import { clip } from "./util.ts";
import { LIMITS, resumeTime } from "./limits.ts";
import { finishReply, postNote } from "./notes.ts";
import { conflictPrompt, planPrompt, reworkPrompt, statusTable, taskPrompt, updatePrompt, wrapUpPrompt } from "./team-prompts.ts";
import { activitySig, runActivity } from "./activity.ts";
import { workdirOf, type Agent, type Goal, type GoalCard, type HarnessTool, type TeamTask, type Thread, type TurnItem } from "./types.ts";


export interface ConsultOutcome {
  ok: boolean;
  text: string;
  runId?: string;
  homeThreadId?: string;
  /** The run hit the plan's usage limit (or was rate limited). */
  limited?: boolean;
}

/** What the team needs from the orchestrator. */
export interface TeamHost {
  consult(
    agent: Agent,
    prompt: string,
    chain: string[],
    project: string,
    opts: { team?: boolean; onRun?: (homeThreadId: string, runId: string) => void; thread?: string },
  ): Promise<ConsultOutcome>;
  interrupt(homeThreadId: string, runId: string): Promise<void>;
  transcript(threadId: string): string;
  /** Should tasks in this folder get their own worktree? (git repo, and the project hasn't turned it off) */
  isolation(goalDir: string): Promise<{ setup?: string } | undefined>;
  /** Hire a specialist from the ready-made templates (or return the one already on the team). */
  recruit(role: string): { agent: Agent; hired: boolean } | { error: string };
  /** Suggest a lasting lesson for an agent (the person approves it). */
  proposeLesson(agentId: string | undefined, text: string, source: { kind: "review"; threadId?: string; note?: string }): void;
}

type ReplyItem = Extract<TurnItem, { kind: "agent_reply" }>;
interface Wake {
  text: string;
  reply?: ReplyItem;
}

const now = () => new Date().toISOString();

export class Team {
  readonly #store: Store;
  readonly #host: TeamHost;
  readonly #wakes = new Map<string, Wake[]>(); // goalId -> pending wake-ups
  readonly #leadBusy = new Set<string>(); // goalId
  readonly #nudges = new Map<string, number>(); // goalId -> consecutive re-wakes
  readonly #sweepNudged = new Set<string>(); // goalId nudged by the stuck detector
  /** The goal a lead's current run is for, keyed by the lead's home thread. */
  readonly #runGoal = new Map<string, string>();
  readonly #timers = new Map<string, NodeJS.Timeout>(); // taskId -> timeout
  readonly #timedOut = new Set<string>(); // taskId
  readonly #wrapping = new Set<string>(); // taskId: out of time, finishing up
  readonly #slowNudgedAt = new Map<string, number>(); // goalId -> last "progress is slow" wake-up
  #sweep: NodeJS.Timeout | undefined;

  constructor(store: Store, host: TeamHost) {
    this.#store = store;
    this.#host = host;
  }

  /** After a restart: requeue interrupted work, then keep everything moving. */
  start() {
    for (const goal of this.#store.openGoals()) {
      const tasks = this.#store.listTasks(goal.id);
      if (goal.status === "planning" && !tasks.length) {
        this.#saveGoal({ ...goal, status: "cancelled", note: "Bullpen restarted while planning.", endedAt: now() });
        continue;
      }
      for (const t of tasks) {
        // Picked up where it was: same agent thread (it remembers), same folder, a "continue" prompt.
        if (t.status === "working") this.#saveTask({ ...t, status: "queued", runId: undefined, resumed: true, attempts: Math.max(0, t.attempts - 1) });
      }
      if (goal.status === "planning") this.#saveGoal({ ...goal, status: "working" });
      if (tasks.some((t) => t.status === "submitted")) this.#wake(goal.id, { text: "Bullpen restarted. Results are waiting for your review." });
      this.#pump(goal.id);
      this.#publish(goal.id);
    }
    this.#sweep = setInterval(() => this.#sweepAll(), LIMITS.sweepMs);
    // Live progress: refresh team cards while anyone on them is working.
    this.#ticker = setInterval(() => this.#tick(), 4000);
    this.#ticker.unref();
  }

  #ticker: NodeJS.Timeout | undefined;
  readonly #cardSigs = new Map<string, string>();
  /** The lead's current run per goal, for its live activity. */
  readonly #leadRuns = new Map<string, { threadId: string; runId: string }>();

  #tick() {
    for (const goal of this.#store.openGoals()) {
      const tasks = this.#store.listTasks(goal.id).filter((t) => t.status === "working" && t.runThreadId && t.runId);
      const lead = this.#leadRuns.get(goal.id);
      if (!tasks.length && !lead) continue;
      const sig = [
        ...tasks.map((t) => `${t.id}:${activitySig(runActivity(this.#store, t.runThreadId!, t.runId!))}:${this.#wrapping.has(t.id)}`),
        lead ? `lead:${activitySig(runActivity(this.#store, lead.threadId, lead.runId))}` : "",
      ].join(";");
      if (this.#cardSigs.get(goal.id) === sig) continue;
      this.#cardSigs.set(goal.id, sig);
      this.#publish(goal.id);
    }
  }

  stop() {
    if (this.#sweep) clearInterval(this.#sweep);
    if (this.#ticker) clearInterval(this.#ticker);
    for (const t of this.#timers.values()) clearTimeout(t);
  }

  // ---------------------------------------------------------------- entry points

  /** True while this agent's current turn is a lead turn for a team goal. */
  isLeadingGoal(homeThreadId: string): boolean {
    return this.#runGoal.has(homeThreadId);
  }

  /** An open goal this lead is running in this thread, if any (new @mentions steer it). */
  openGoalFor(threadId: string, leadId: string): Goal | undefined {
    return this.#store.goalsForThread(threadId).find((g) => g.leadAgentId === leadId && isOpen(g));
  }

  /** "@lead build X" in a project thread. */
  startGoal(thread: Thread, lead: Agent, request: string, reply: ReplyItem): string {
    const goal: Goal = {
      id: randomUUID(),
      threadId: thread.id,
      project: workdirOf(thread),
      leadAgentId: lead.id,
      title: titleFrom(request, lead.name),
      request,
      status: "planning",
      leadTurns: 0,
      createdAt: now(),
      updatedAt: now(),
    };
    this.#saveGoal(goal);
    const context = this.#host.transcript(thread.id);
    this.#wake(goal.id, { text: planPrompt(this.#store, goal, thread, context), reply });
    return goal.id;
  }

  /** The person @mentioned the lead again while its goal is open. */
  userMessage(goal: Goal, text: string, reply: ReplyItem) {
    if (goal.status === "stuck") this.#saveGoal({ ...goal, status: "working", note: undefined });
    this.#sweepNudged.delete(goal.id);
    this.#nudges.delete(goal.id);
    this.#wake(goal.id, {
      text: `The person wrote in the thread:\n\n${text}\n\nReply to them (your final message is posted in the thread) and adjust the plan if needed: delegate new tasks, cancel_task, or finish_goal.`,
      reply,
    });
  }

  cancelGoal(goalId: string) {
    const goal = this.#store.getGoal(goalId);
    if (!goal || !isOpen(goal)) return;
    this.#saveGoal({ ...goal, status: "cancelled", note: "Stopped by you.", endedAt: now() });
    for (const t of this.#store.listTasks(goalId)) {
      if (isActiveTask(t)) {
        this.#saveTask({ ...t, status: "cancelled", endedAt: now() });
        if (t.status === "working" && t.runThreadId && t.runId) void this.#host.interrupt(t.runThreadId, t.runId);
      }
    }
    this.#wakes.delete(goalId);
    this.#publish(goalId);
    void this.#cleanupGoal(goalId);
  }

  /** Remove the tasks' worktrees once a goal is over (anything not landed is kept in the task's refs). */
  async #cleanupGoal(goalId: string) {
    const goal = this.#store.getGoal(goalId);
    if (!goal) return;
    for (const t of this.#store.listTasks(goalId)) {
      if (!t.workspace) continue;
      await worktrees.removeTaskWorkspace(goal.project, t.workspace).catch(() => {});
      if (t.status === "accepted") await worktrees.dropTaskRefs(goal.project, t.id).catch(() => {});
      const latest = this.#store.getTask(t.id);
      if (latest) this.#saveTask({ ...latest, workspace: undefined });
    }
  }

  retryTask(taskId: string) {
    const task = this.#store.getTask(taskId);
    if (!task || !["parked", "paused", "cancelled"].includes(task.status)) return;
    const goal = this.#store.getGoal(task.goalId);
    if (!goal) return;
    if (!isOpen(goal) || goal.status === "paused" || goal.status === "stuck") {
      this.#saveGoal({ ...goal, status: "working", note: undefined, resumeAt: undefined, endedAt: undefined });
    }
    this.#saveTask({ ...task, status: "queued", attempts: 0, error: undefined, resumeAt: undefined, endedAt: undefined });
    this.#sweepNudged.delete(goal.id);
    this.#pump(goal.id);
    this.#publish(goal.id);
  }

  /** An approval prompt appeared or was answered in some agent's home thread. */
  onApprovalChange(homeThreadId: string) {
    for (const goal of this.#store.openGoals()) {
      if (this.#store.listTasks(goal.id).some((t) => t.runThreadId === homeThreadId && t.status === "working")) this.#publish(goal.id);
    }
  }

  /**
   * report_progress, for whoever is working on a task in this thread: a one-line note shown live on the team card.
   * Outside a team task it's posted in the thread instead (the caller does that).
   */
  progress(threadId: string, text: string): boolean {
    for (const goal of this.#store.openGoals()) {
      const task = this.#store.listTasks(goal.id).find((t) => t.status === "working" && t.runThreadId === threadId);
      if (!task) continue;
      const progress = [...(task.progress ?? []), { at: now(), text: clip(text.trim(), 300) }].slice(-8);
      this.#saveTask({ ...task, progress });
      this.#publish(goal.id);
      return true;
    }
    return false;
  }

  // ---------------------------------------------------------------- lead tools

  tools(leadHomeThreadId: string): HarnessTool[] {
    const goalOf = () => {
      const id = this.#runGoal.get(leadHomeThreadId);
      const goal = id ? this.#store.getGoal(id) : undefined;
      return goal && isOpen(goal) ? goal : undefined;
    };
    const none = { isError: true, text: "No team goal is active in this turn. Team tools work when you're @mentioned in a project thread." };
    return [
      {
        name: "delegate",
        description:
          "Hand a piece of the goal to a teammate as a tracked task. It runs in the project in parallel with other tasks (unless depends_on says otherwise), and you're woken with the result to review. " +
          "The teammate can't see your conversation: the brief must be self-contained.",
        params: {
          agent: { description: "Teammate's @handle, e.g. backend." },
          title: { description: "Short task title, e.g. 'Add /contact endpoint'." },
          brief: { description: "Everything they need: context, requirements, constraints, relevant files." },
          deliverable: { description: "Exactly what to hand back, e.g. 'the endpoint plus tests, and a summary of the API'." },
          files: { description: "Files or folders this task may change (keep parallel tasks on separate files). Leave empty for review-only work.", optional: true },
          depends_on: { description: "Task refs that must be accepted first, comma-separated, e.g. 'T1, T2'.", optional: true },
          review: {
            description:
              "'skip' to accept the result automatically when it's submitted (routine, low-risk work: dependents start right away and you see the result at the end). Default: you review it.",
            optional: true,
          },
        },
        run: async (a) => {
          const goal = goalOf();
          return goal ? this.#delegate(goal, a) : none;
        },
      },
      {
        name: "review_task",
        description:
          "Review a submitted task: decision 'accept', or 'changes' with every note in one message. Each task can be sent back once; after that, fix small leftovers yourself and accept.",
        params: {
          task: { description: "Task ref, e.g. T2." },
          decision: { description: "'accept' or 'changes'." },
          notes: { description: "For 'changes': all the fixes needed, specific and complete. Optional for 'accept'.", optional: true },
          lesson: {
            description:
              "Optional: a one-line general rule this agent should follow from now on, in every project (not a task-specific fix), e.g. 'Use the project's logger, never console.log'. The person approves it first.",
            optional: true,
          },
        },
        run: async (a) => {
          const goal = goalOf();
          return goal ? await this.#review(goal, a) : none;
        },
      },
      {
        name: "set_goal_criteria",
        description:
          "For open-ended goals ('keep improving until…', 'make it great'): say what done looks like, as a few checkable criteria, and how many improvement rounds to allow. " +
          "After each round you check against them: finish_goal when they're met, otherwise next_round. Call it while planning.",
        params: {
          criteria: { description: "Checkable criteria, one per line, e.g. '- a new player gets the core loop within 10 seconds'." },
          rounds: { description: `Maximum rounds (default ${LIMITS.defaultRounds}, at most ${LIMITS.maxRounds}).`, optional: true },
        },
        run: async (a) => {
          const goal = goalOf();
          if (!goal) return none;
          if (!a.criteria?.trim()) return { isError: true, text: "Pass the criteria." };
          const maxRounds = Math.min(LIMITS.maxRounds, Math.max(1, Number(a.rounds) || LIMITS.defaultRounds));
          this.#saveGoal({ ...goal, criteria: a.criteria.trim(), round: goal.round ?? 1, maxRounds, roundStartedAt: goal.roundStartedAt ?? now() });
          this.#publish(goal.id);
          return { text: `Criteria set; round ${goal.round ?? 1} of up to ${maxRounds}. Now delegate this round's tasks.` };
        },
      },
      {
        name: "next_round",
        description:
          "End this improvement round and start the next: post a short report for the person (what changed, how it measures against the criteria, what the next round will do), then delegate the next round's tasks in the same turn.",
        params: { report: { description: "Short round report for the person." } },
        run: async (a) => {
          const goal = goalOf();
          if (!goal) return none;
          if (!goal.criteria) return { isError: true, text: "This goal has no criteria; use set_goal_criteria first, or finish_goal." };
          const open = this.#store.listTasks(goal.id).filter((t) => isActiveTask(t) || t.status === "parked");
          if (open.length) return { isError: true, text: `Not yet: ${open.map((t) => `${t.ref} is ${t.status}`).join(", ")}.` };
          const round = goal.round ?? 1;
          if (round >= (goal.maxRounds ?? LIMITS.defaultRounds)) {
            return { isError: true, text: `That was the last round (${round}). Call finish_goal with the final report.` };
          }
          if (!a.report?.trim()) return { isError: true, text: "Pass the report." };
          const reports = [...(goal.roundReports ?? []), a.report.trim()];
          this.#saveGoal({ ...goal, round: round + 1, roundReports: reports, roundStartedAt: now() });
          this.#postReply(goal, `round:${goal.id}:${round}`, `**Round ${round} done.** ${a.report.trim()}`);
          this.#nudges.delete(goal.id);
          this.#publish(goal.id);
          return { text: `Round ${round + 1} started. Delegate its tasks now.` };
        },
      },
      {
        name: "estimate",
        description:
          "Before a big plan (or when progress is slow): ask a planner to size the work: rough effort, how to split it into parallel tasks, how many builders to run at once, and what to hire. " +
          "Returns its advice; it's quick and changes nothing.",
        params: { question: { description: "What to size, e.g. 'the next pass: sharing, leaderboards, bot opponents'." } },
        run: async (a) => {
          const goal = goalOf();
          if (!goal) return none;
          const hire = this.#host.recruit("planner");
          if ("error" in hire) return { isError: true, text: hire.error };
          if (hire.hired) this.#event(goal, `The lead brought in @${hire.agent.name} to size the work.`, hire.agent.id);
          const team = this.#store.listAgents().filter((x) => x.id !== goal.leadAgentId).map((x) => `@${x.name}${x.description ? ` (${x.description.slice(0, 60)})` : ""}`).join("; ");
          const res = await this.#host.consult(
            hire.agent,
            [
              `The lead of a team goal asks you to size work. Goal: "${goal.title}". Project: ${goal.project} (you can read it).`,
              `Question: ${a.question ?? "the next step"}`,
              `Current tasks:\n${statusTable(this.#store, goal.id, false)}`,
              `Team: ${team || "(only the lead)"}. Up to ${LIMITS.maxParallel} tasks run at once; each task gets about ${LIMITS.taskBudgetMs / 60_000} minutes.`,
              "Speed matters most. Answer in under 200 words: (1) effort in task-sized pieces of about 10 minutes, (2) which pieces can run in parallel and which truly depend on others, " +
                "(3) how many builders to run at once and which specialists to hire (by role, e.g. frontend, tester), (4) the biggest risk to speed.",
            ].join("\n\n"),
            [goal.leadAgentId],
            goal.project,
            {},
          );
          return res.ok ? { text: res.text } : { isError: true, text: `The planner couldn't answer: ${res.text}` };
        },
      },
      {
        name: "hire",
        description:
          "Add a specialist to the team when there's more parallel work than builders, or a skill is missing (e.g. 'frontend', 'tester', 'devops', 'designer'). " +
          `They join right away and you can delegate to them. At most ${LIMITS.maxHiresPerGoal} hires per goal and ${LIMITS.maxTeamSize} agents in all.`,
        params: { role: { description: "The role, e.g. frontend, tester, devops, designer, security." }, why: { description: "One line for the person: why the team needs them." } },
        run: async (a) => {
          const goal = goalOf();
          if (!goal) return none;
          if ((goal.hires ?? 0) >= LIMITS.maxHiresPerGoal) return { isError: true, text: `This goal already hired ${LIMITS.maxHiresPerGoal}; make do with the team, or ask the person.` };
          const res = this.#host.recruit(a.role ?? "");
          if ("error" in res) return { isError: true, text: res.error };
          if (!res.hired) return { text: `@${res.agent.name} is already on the team; delegate to them.` };
          this.#saveGoal({ ...this.#store.getGoal(goal.id)!, hires: (goal.hires ?? 0) + 1 });
          this.#event(goal, `The lead hired @${res.agent.name}${a.why?.trim() ? `: ${a.why.trim()}` : "."}`, res.agent.id);
          return { text: `Hired @${res.agent.name} (${res.agent.description}). Delegate to them now.` };
        },
      },
      {
        name: "team_status",
        description: "List this goal's tasks with owners, status and results.",
        params: {},
        run: async () => {
          const goal = goalOf();
          return goal ? { text: statusTable(this.#store, goal.id, true) } : none;
        },
      },
      {
        name: "cancel_task",
        description: "Cancel a task that's no longer needed (stops it if it's running).",
        params: { task: { description: "Task ref, e.g. T3." }, reason: { description: "Why, in a few words.", optional: true } },
        run: async (a) => {
          const goal = goalOf();
          if (!goal) return none;
          const task = this.#byRef(goal.id, a.task);
          if (!task) return { isError: true, text: `No task ${a.task}.` };
          if (!isActiveTask(task)) return { isError: true, text: `${task.ref} is already ${task.status}.` };
          this.#saveTask({ ...task, status: "cancelled", error: a.reason, endedAt: now() });
          if (task.status === "working" && task.runThreadId && task.runId) void this.#host.interrupt(task.runThreadId, task.runId);
          if (task.workspace) void worktrees.removeTaskWorkspace(goal.project, task.workspace).catch(() => {});
          this.#pump(goal.id);
          this.#publish(goal.id);
          return { text: `${task.ref} cancelled.` };
        },
      },
      {
        name: "finish_goal",
        description:
          "Close the goal and post your final report in the thread. Only when every task is accepted or cancelled, and you've checked the whole (tests/build if any).",
        params: {
          report: { description: "For the person: what changed, who did what, files touched, how to verify, open risks." },
        },
        run: async (a) => {
          const goal = goalOf();
          if (!goal) return none;
          const open = this.#store.listTasks(goal.id).filter((t) => isActiveTask(t) || t.status === "parked");
          if (open.length) {
            return { isError: true, text: `Not yet: ${open.map((t) => `${t.ref} is ${t.status}`).join(", ")}. Review, cancel, or wait for them first.` };
          }
          const report = (a.report ?? "").trim();
          if (!report) return { isError: true, text: "Pass the report." };
          this.#saveGoal({ ...goal, status: "done", report, endedAt: now() });
          this.#postReply(goal, `report:${goal.id}`, report);
          this.#publish(goal.id);
          void this.#cleanupGoal(goal.id);
          return { text: "Goal finished; your report is posted in the thread. End your turn with a one-line confirmation." };
        },
      },
    ];
  }

  #delegate(goal: Goal, a: Record<string, string>) {
    const tasks = this.#store.listTasks(goal.id);
    const thisRound = tasks.filter((t) => !goal.roundStartedAt || t.createdAt >= goal.roundStartedAt);
    if (thisRound.length >= LIMITS.maxTasks) return { isError: true, text: `This round already has ${LIMITS.maxTasks} tasks (the limit). Finish or cancel some first.` };
    const handle = (a.agent ?? "").replace(/^@/, "").trim().toLowerCase();
    const agent = this.#store.getAgentByName(handle);
    if (!agent) {
      const roster = this.#store.listAgents().map((x) => `@${x.name}`).join(", ");
      return { isError: true, text: `No agent @${handle}. Team: ${roster || "(none)"}. Ask the person to recruit one if a specialist is missing.` };
    }
    if (agent.id === goal.leadAgentId) return { isError: true, text: "Don't delegate to yourself; do it directly or pick a teammate." };
    if (!a.title?.trim() || !a.brief?.trim() || !a.deliverable?.trim()) return { isError: true, text: "Pass title, brief and deliverable." };
    const dup = tasks.find((t) => t.agentId === agent.id && isActiveTask(t) && t.title.toLowerCase() === a.title.trim().toLowerCase());
    if (dup) return { isError: true, text: `That's already ${dup.ref} (${dup.status}). Use team_status to see the plan.` };
    const deps: string[] = [];
    for (const ref of (a.depends_on ?? "").split(/[\s,]+/).filter(Boolean)) {
      const dep = this.#byRef(goal.id, ref);
      if (!dep) return { isError: true, text: `depends_on: no task ${ref}.` };
      deps.push(dep.id);
    }
    const task: TeamTask = {
      id: randomUUID(),
      goalId: goal.id,
      ref: `T${tasks.length + 1}`,
      agentId: agent.id,
      title: a.title.trim().slice(0, 120),
      brief: a.brief.trim(),
      deliverable: a.deliverable.trim(),
      files: a.files?.trim() || undefined,
      dependsOn: deps,
      autoAccept: /^(skip|no|none|auto|false)/i.test(a.review ?? ""),
      status: deps.length ? "waiting" : "queued",
      attempts: 0,
      round: 0,
      createdAt: now(),
    };
    this.#saveTask(task);
    if (goal.status === "planning") this.#saveGoal({ ...goal, status: "working" });
    this.#pump(goal.id);
    this.#publish(goal.id);
    const when = deps.length ? `It starts when ${a.depends_on} ${deps.length > 1 ? "are" : "is"} accepted.` : "It's starting now.";
    return { text: `Created ${task.ref} for @${agent.name}: "${task.title}". ${when}${task.autoAccept ? " It's accepted automatically when submitted." : ""}` };
  }

  async #review(goal: Goal, a: Record<string, string>) {
    const task = this.#byRef(goal.id, a.task);
    if (!task) return { isError: true, text: `No task ${a.task}.` };
    if (task.status !== "submitted") return { isError: true, text: `${task.ref} is ${task.status}, not waiting for review.` };
    const decision = (a.decision ?? "").toLowerCase();
    if (a.lesson?.trim()) {
      this.#host.proposeLesson(task.agentId, a.lesson.trim(), { kind: "review", threadId: goal.threadId, note: `From the review of ${task.ref} "${task.title}"` });
    }
    if (decision.startsWith("acc")) {
      const landed = await this.#accept(goal, task);
      this.#pump(goal.id);
      this.#publish(goal.id);
      return landed.ok
        ? { text: `${task.ref} accepted${task.workspace ? " and merged into the project" : ""}.` }
        : {
            text:
              `${task.ref} can't be merged yet: it conflicts with work merged since it started (${landed.conflicts.join(", ") || landed.error}). ` +
              "It's gone back to its owner to resolve; that doesn't count as your one send-back. You'll be woken when it's resubmitted.",
          };
    }
    if (decision.startsWith("chan") || decision.startsWith("rej") || decision.startsWith("send")) {
      if (task.round >= 1) {
        return { isError: true, text: `${task.ref} was already sent back once (one-round review). Fix what's left yourself, then accept it.` };
      }
      if (!a.notes?.trim()) return { isError: true, text: "Sending back needs notes: every fix, in one message." };
      this.#saveTask({ ...task, status: "changes", round: 1, reviewNotes: a.notes.trim() });
      this.#pump(goal.id);
      this.#publish(goal.id);
      return { text: `${task.ref} sent back to its owner with your notes.` };
    }
    return { isError: true, text: "decision must be 'accept' or 'changes'." };
  }

  /**
   * Accept a task: merge its worktree into the goal's folder first. On a conflict it goes back to its agent with the
   * conflict markers in its folder (status "changes", `conflicts` set; the review round isn't used up).
   */
  async #accept(goal: Goal, task: TeamTask, extra: Partial<TeamTask> = {}): Promise<{ ok: true } | { ok: false; conflicts: string[]; error?: string }> {
    if (!task.workspace) {
      this.#saveTask({ ...task, ...extra, status: "accepted", conflicts: undefined, endedAt: now() });
      return { ok: true };
    }
    let res: worktrees.LandResult;
    try {
      res = await worktrees.landTask(goal.project, task.workspace, task.id);
    } catch (err) {
      res = { ok: false, conflicts: [], error: (err as Error).message };
    }
    const latest = { ...this.#store.getTask(task.id)!, ...extra };
    if (res.ok) {
      this.#saveTask({ ...latest, status: "accepted", filesTouched: res.files.length ? res.files : latest.filesTouched, conflicts: undefined, endedAt: now() });
      void worktrees.removeTaskWorkspace(goal.project, task.workspace).then(() => {
        const t = this.#store.getTask(task.id);
        if (t) this.#saveTask({ ...t, workspace: undefined });
      });
      return { ok: true };
    }
    if (!res.conflicts.length) {
      this.#saveTask({ ...latest, status: "parked", error: `Couldn't merge it into the project: ${res.error}`, endedAt: now() });
      this.#wake(goal.id, { text: `${task.ref} couldn't be merged into the project (${res.error}). Its work is in ${task.workspace.path}. Decide what to do.` });
      return res;
    }
    // landTask moved the workspace's base to the goal folder's current state.
    this.#saveTask({ ...latest, status: "changes", workspace: task.workspace, conflicts: res.conflicts });
    return res;
  }

  // ---------------------------------------------------------------- the lead's turns

  #wake(goalId: string, wake: Wake) {
    const list = this.#wakes.get(goalId) ?? [];
    list.push(wake);
    this.#wakes.set(goalId, list);
    if (!this.#leadBusy.has(goalId)) void this.#runLead(goalId);
  }

  async #runLead(goalId: string) {
    this.#leadBusy.add(goalId);
    try {
      for (;;) {
        let goal = this.#store.getGoal(goalId);
        const batch = this.#wakes.get(goalId) ?? [];
        this.#wakes.delete(goalId);
        if (!goal || !isOpen(goal) || !batch.length) break;
        if (goal.status === "paused") {
          this.#wakes.set(goalId, batch); // try again when the limit resets
          break;
        }
        const lead = this.#store.getAgent(goal.leadAgentId);
        if (!lead) {
          this.#saveGoal({ ...goal, status: "failed", note: "The lead agent was deleted.", endedAt: now() });
          this.#publish(goalId);
          break;
        }
        if (goal.leadTurns >= LIMITS.maxLeadTurns + 15 * ((goal.round ?? 1) - 1)) {
          this.#saveGoal({ ...goal, status: "stuck", note: `The lead used its ${LIMITS.maxLeadTurns} turns. Mention it to continue, or stop the team.` });
          this.#publish(goalId);
          break;
        }
        goal = { ...goal, leadTurns: goal.leadTurns + 1 };
        this.#saveGoal(goal);

        const isPlan = goal.status === "planning";
        const info = this.#info.get(goalId) ?? [];
        this.#info.delete(goalId);
        const prompt = isPlan ? batch.map((w) => w.text).join("\n\n---\n\n") : updatePrompt(this.#store, goal, [...info, ...batch.map((w) => w.text)]);
        const reply = batch.find((w) => w.reply)?.reply;
        let res: ConsultOutcome;
        try {
          // Attach the goal when the lead's turn actually starts: it may first have to finish a turn for another
          // goal, and that turn's cleanup must not detach this one.
          res = await this.#host.consult(lead, prompt, [], goal.project, {
            team: true,
            onRun: (home, runId) => {
              this.#runGoal.set(home, goalId);
              this.#leadRuns.set(goalId, { threadId: home, runId });
              this.#publish(goalId);
            },
          });
        } finally {
          const lr = this.#leadRuns.get(goalId);
          this.#leadRuns.delete(goalId);
          if (lr && this.#runGoal.get(lr.threadId) === goalId) this.#runGoal.delete(lr.threadId);
          this.#publish(goalId);
        }

        goal = this.#store.getGoal(goalId)!;
        if (res.limited) {
          this.#pauseGoal(goal, res.text);
          this.#wakes.set(goalId, [...batch, ...(this.#wakes.get(goalId) ?? [])]);
          break;
        }
        if (reply) finishReply(this.#store, reply, res.ok, res.text);

        const tasks = this.#store.listTasks(goalId);
        if (isPlan && !tasks.length) {
          // Answered directly: no team needed, so no card.
          this.#saveGoal({ ...goal, status: "done", note: "Answered without a team.", endedAt: now() });
          break;
        }
        if (!res.ok && !isOpen(goal)) break;
        if (!isOpen(goal)) break;
        this.#afterLeadTurn(goal, tasks);
      }
    } finally {
      this.#leadBusy.delete(goalId);
    }
    // Wake-ups that arrived while we were finishing up.
    if (this.#wakes.get(goalId)?.length && isOpen(this.#store.getGoal(goalId))) void this.#runLead(goalId);
  }

  /** The lead's turn ended: make sure the goal keeps moving (AgentOffice: every turn ends with an action). */
  #afterLeadTurn(goal: Goal, tasks: TeamTask[]) {
    if (goal.status === "planning") this.#saveGoal({ ...goal, status: "working" });
    const unreviewed = tasks.filter((t) => t.status === "submitted");
    const allSettled = tasks.length > 0 && tasks.every((t) => ["accepted", "cancelled"].includes(t.status));
    const nudges = this.#nudges.get(goal.id) ?? 0;
    let nudge: string | undefined;
    if (unreviewed.length) nudge = `You still need to review ${unreviewed.map((t) => t.ref).join(", ")} with review_task.`;
    else if (allSettled && goal.criteria) {
      const round = goal.round ?? 1;
      const last = round >= (goal.maxRounds ?? LIMITS.defaultRounds);
      nudge = last
        ? `Round ${round} (the last) is done. Check the whole against the criteria and call finish_goal with the final report.`
        : `Round ${round} is done. Check the result against the criteria:\n${goal.criteria}\nIf they're met, finish_goal. If not, call next_round with a short report and delegate the next round's tasks in the same turn.`;
    } else if (allSettled) nudge = "Every task is accepted or cancelled. Check the whole (tests/build if any) and call finish_goal with the report.";
    if (nudge) {
      if (nudges >= LIMITS.maxNudges) {
        this.#saveGoal({ ...this.#store.getGoal(goal.id)!, status: "stuck", note: "The lead stopped without reviewing or finishing. Mention it to continue." });
      } else {
        this.#nudges.set(goal.id, nudges + 1);
        const list = this.#wakes.get(goal.id) ?? [];
        list.push({ text: nudge });
        this.#wakes.set(goal.id, list);
      }
    } else {
      this.#nudges.delete(goal.id);
    }
    this.#pump(goal.id);
    this.#publish(goal.id);
  }

  // ---------------------------------------------------------------- running tasks

  #pump(goalId: string) {
    const goal = this.#store.getGoal(goalId);
    if (!goal || !["planning", "working"].includes(goal.status)) return;
    const tasks = this.#store.listTasks(goalId);
    const byId = new Map(tasks.map((t) => [t.id, t]));
    for (const t of tasks) {
      if (t.status !== "waiting" && t.status !== "queued") continue;
      const ready = t.dependsOn.every((d) => byId.get(d)?.status === "accepted");
      const next = ready ? "queued" : "waiting";
      if (next !== t.status) this.#saveTask({ ...t, status: next });
    }
    let working = this.#store.listTasks(goalId).filter((t) => t.status === "working").length;
    for (const t of this.#store.listTasks(goalId)) {
      if (working >= LIMITS.maxParallel) break;
      if (t.status === "queued" || t.status === "changes") {
        working++;
        void this.#runTask(t.id);
      }
    }
  }

  async #runTask(taskId: string) {
    let task = this.#store.getTask(taskId)!;
    const goal = this.#store.getGoal(task.goalId)!;
    const agent = this.#store.getAgent(task.agentId);
    if (!agent) {
      this.#saveTask({ ...task, status: "parked", error: "That agent was deleted.", endedAt: now() });
      this.#wake(goal.id, { text: `${task.ref} is parked: its agent was deleted. Reassign it with delegate or cancel it.` });
      this.#publish(goal.id);
      return;
    }
    const rework = task.status === "changes";
    const resolving = rework && Boolean(task.conflicts?.length);
    task = { ...task, status: "working", attempts: task.attempts + 1, startedAt: task.startedAt ?? now(), error: undefined };
    this.#saveTask(task);
    this.#publish(goal.id);

    // Its own worktree, made from the goal folder as it is now (so it includes accepted work it depends on).
    if (!task.workspace || !existsSync(task.workspace.path)) {
      const iso = await this.#host.isolation(goal.project).catch(() => undefined);
      if (iso) {
        try {
          const workspace = await worktrees.createTaskWorkspace(goal.project, task.id, iso.setup);
          task = { ...this.#store.getTask(taskId)!, workspace };
          this.#saveTask(task);
        } catch (err) {
          console.error(`[team] worktree for ${task.ref} failed, sharing the project folder:`, err);
        }
      }
    }
    const where = task.workspace?.path ?? goal.project;

    const resumed = Boolean(task.resumed) && Boolean(task.runThreadId);
    let prompt = resolving ? conflictPrompt(this.#store, goal, task) : rework ? reworkPrompt(this.#store, goal, task) : taskPrompt(this.#store, goal, task);
    if (resumed) {
      prompt =
        "Bullpen restarted while you were working on this task. Your changes so far are still in your folder and you remember the work: " +
        `check where you got to and continue from there (don't redo finished steps). The task, for reference:\n\n${prompt}`;
    }
    if (task.resumed) this.#saveTask((task = { ...task, resumed: false }));
    // One run, at most the time budget; then a short wrap-up turn in the same conversation, so nothing is lost.
    const run = (text: string, budgetMs: number, thread?: string) =>
      this.#host.consult(agent, text, [goal.leadAgentId], where, {
        team: true,
        thread,
        onRun: (homeThreadId, runId) => {
          const t = this.#store.getTask(taskId);
          if (t) this.#saveTask({ ...t, runThreadId: homeThreadId, runId });
          this.#publish(goal.id);
          clearTimeout(this.#timers.get(taskId));
          this.#timers.set(
            taskId,
            setTimeout(() => {
              this.#timedOut.add(taskId);
              void this.#host.interrupt(homeThreadId, runId);
            }, budgetMs),
          );
        },
      });
    let res = await run(prompt, LIMITS.taskBudgetMs, resumed ? task.runThreadId : undefined);
    clearTimeout(this.#timers.get(taskId));
    let timedOut = this.#timedOut.delete(taskId);
    let partial = false;
    const after = this.#store.getTask(taskId);
    if (timedOut && after?.status === "working" && after.runThreadId && isOpen(this.#store.getGoal(goal.id))) {
      this.#wrapping.add(taskId);
      this.#publish(goal.id);
      res = await run(wrapUpPrompt(this.#store, goal, after), LIMITS.wrapUpMs, after.runThreadId);
      clearTimeout(this.#timers.get(taskId));
      timedOut = this.#timedOut.delete(taskId);
      this.#wrapping.delete(taskId);
      partial = res.ok;
    }
    this.#timers.delete(taskId);

    task = this.#store.getTask(taskId)!;
    const g = this.#store.getGoal(goal.id)!;
    if (task.status !== "working" || !isOpen(g)) {
      // Cancelled meanwhile: the agent may have kept writing after the first cleanup, so clean up again.
      if (task.workspace && ["cancelled"].includes(task.status) || (!isOpen(g) && task.workspace && task.status !== "accepted")) {
        await worktrees.removeTaskWorkspace(goal.project, task.workspace).catch(() => {});
      }
      this.#publish(goal.id);
      return;
    }
    if (res.ok) {
      let touched: string[] = [];
      let patch = "";
      if (task.workspace) {
        const changes = await worktrees.taskChanges(goal.project, task.workspace, task.id).catch(() => undefined);
        touched = changes?.files ?? [];
        patch = changes?.patch ?? "";
      } else if (res.homeThreadId && res.runId) touched = this.#filesTouched(res.homeThreadId, res.runId, goal.project);
      const result = resolving ? `${task.result ?? ""}\n\n(Resolved merge conflicts: ${res.text})` : partial ? `(Submitted at its time budget.)\n${res.text}` : res.text;
      if (partial) task = { ...task, partial: true };
      if ((task.autoAccept && !rework) || resolving) {
        // Fast lane: no review turn (routine work, or work the lead already accepted that only needed its merge
        // conflicts resolved). Dependents start now; the lead sees the result when it next wakes.
        const landed = await this.#accept(goal, { ...task, result, filesTouched: touched }, { result, runId: undefined, partial: task.partial });
        if (landed.ok) {
          this.#queueInfo(
            goal.id,
            resolving
              ? `${task.ref} (@${agent.name}: ${task.title}) resolved its merge conflicts and is merged in:\n${clip(res.text, 800)}`
              : `${task.ref} (@${agent.name}: ${task.title}) finished and was accepted automatically${task.workspace ? "; its changes are merged into the project folder" : ""}:\n${clip(res.text, 1500)}`,
          );
          this.#maybeWakeForFinish(goal.id);
        }
      } else {
        this.#saveTask({ ...task, status: "submitted", result, filesTouched: touched, runId: undefined, conflicts: undefined });
        const verb = partial
          ? `submitted at its ${LIMITS.taskBudgetMs / 60_000}-minute budget (done as far as it got; what's left is listed: delegate follow-up tasks for it if needed)`
          : resolving
            ? "resubmitted after resolving merge conflicts"
            : rework
              ? "resubmitted after your notes"
              : "submitted";
        this.#wakeForReview(goal.id, {
          text:
            `${task.ref} (@${agent.name}: ${task.title}) was ${verb}:\n\n${clip(res.text, 4000)}` +
            (touched.length ? `\n\nFiles touched: ${touched.join(", ")}` : "") +
            (task.workspace
              ? `\n\nIts work is in its own copy of the project, ${task.workspace.path}, and is merged into the project when you accept it.` +
                (patch ? `\n\nThe change:\n\n${patch}` : "")
              : "") +
            `\n\nReview it with review_task (${rework && !resolving ? "this was the one send-back, so accept it, fixing any small leftovers yourself" : "accept unless something is actually wrong; fix small things yourself rather than sending back"}).`,
        });
      }
    } else if (res.limited) {
      const resumeAt = resumeTime(res.text);
      this.#saveTask({ ...task, status: "paused", error: "Usage limit reached", resumeAt, runId: undefined });
      this.#pauseGoal(g, res.text);
    } else {
      const error = timedOut ? `Didn't finish wrapping up within ${(LIMITS.taskBudgetMs + LIMITS.wrapUpMs) / 60_000} minutes and was stopped.` : clip(res.text, 600) || "Failed.";
      if (task.attempts < LIMITS.maxAttempts) {
        // Retry once automatically (AgentOffice: retry-then-park).
        this.#saveTask({ ...task, status: rework ? "changes" : "queued", error: `Retrying: ${error}`, runId: undefined });
      } else {
        this.#saveTask({ ...task, status: "parked", error, runId: undefined, endedAt: now() });
        this.#wake(goal.id, {
          text: `${task.ref} (@${agent.name}: ${task.title}) failed twice and is parked: ${error}\nDecide: reassign it with delegate, cancel_task, or finish without it. The person can also press Retry.`,
        });
      }
    }
    // A held review can go now if nothing else is about to submit.
    if (this.#reviewTimers.has(goal.id) && !this.#store.listTasks(goal.id).some((t) => t.status === "working")) {
      clearTimeout(this.#reviewTimers.get(goal.id));
      this.#reviewTimers.delete(goal.id);
      if (!this.#leadBusy.has(goal.id)) void this.#runLead(goal.id);
    }
    this.#pump(goal.id);
    this.#publish(goal.id);
  }

  /** Results the lead should see next time it wakes, without waking it just for them. */
  readonly #info = new Map<string, string[]>();
  #queueInfo(goalId: string, text: string) {
    const list = this.#info.get(goalId) ?? [];
    list.push(text);
    this.#info.set(goalId, list);
  }

  /** Auto-accepted work may have finished the last open task: then the lead needs to wrap up. */
  #maybeWakeForFinish(goalId: string) {
    const tasks = this.#store.listTasks(goalId);
    const goal = this.#store.getGoal(goalId);
    if (tasks.length && tasks.every((t) => ["accepted", "cancelled"].includes(t.status))) {
      this.#wake(goalId, {
        text: goal?.criteria
          ? `Every task in round ${goal.round ?? 1} is accepted. Check against the criteria: finish_goal if met (or if this was the last round), otherwise next_round and delegate.`
          : "Every task is accepted. Check the whole (tests/build if any) and call finish_goal with the report.",
      });
    }
  }

  readonly #reviewTimers = new Map<string, NodeJS.Timeout>();
  /**
   * A submission needs review. If other tasks are still working, hold the wake-up briefly so the lead reviews
   * several results in one turn instead of one turn per result.
   */
  #wakeForReview(goalId: string, wake: Wake) {
    const list = this.#wakes.get(goalId) ?? [];
    list.push(wake);
    this.#wakes.set(goalId, list);
    if (this.#leadBusy.has(goalId)) return; // it picks this up when its current turn ends
    const stillWorking = this.#store.listTasks(goalId).some((t) => t.status === "working");
    clearTimeout(this.#reviewTimers.get(goalId));
    if (!stillWorking) {
      this.#reviewTimers.delete(goalId);
      void this.#runLead(goalId);
      return;
    }
    this.#reviewTimers.set(
      goalId,
      setTimeout(() => {
        this.#reviewTimers.delete(goalId);
        if (!this.#leadBusy.has(goalId)) void this.#runLead(goalId);
      }, LIMITS.reviewBatchMs),
    );
  }

  #pauseGoal(goal: Goal, why: string) {
    const resumeAt = resumeTime(why);
    this.#saveGoal({
      ...goal,
      status: "paused",
      resumeAt,
      note: `Paused: your plan's usage limit was reached. Resumes around ${new Date(resumeAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}.`,
    });
    this.#publish(goal.id);
  }

  /** Every 30s: resume paused work, and catch goals where nothing is moving. */
  #sweepAll() {
    const t = Date.now();
    for (const goal of this.#store.openGoals()) {
      const tasks = this.#store.listTasks(goal.id);
      if (goal.status === "paused" && goal.resumeAt && Date.parse(goal.resumeAt) <= t) {
        for (const task of tasks) if (task.status === "paused") this.#saveTask({ ...task, status: "queued", error: undefined, resumeAt: undefined });
        this.#saveGoal({ ...goal, status: "working", note: undefined, resumeAt: undefined });
        this.#pump(goal.id);
        if (this.#wakes.get(goal.id)?.length) void this.#runLead(goal.id);
        this.#publish(goal.id);
        continue;
      }
      if (goal.status !== "working") continue;
      // Moving slowly: one task (or none) running while work waits. Wake the lead, at most every 15 minutes.
      const working = tasks.filter((x) => x.status === "working");
      const waiting = tasks.filter((x) => x.status === "queued" || x.status === "waiting");
      const longest = Math.max(0, ...working.map((x) => t - Date.parse(x.startedAt ?? goal.updatedAt)));
      const slow = (working.length <= 1 && waiting.length >= 1 && longest > LIMITS.slowAfterMs) || working.some((x) => x.partial);
      if (slow && !this.#leadBusy.has(goal.id) && t - (this.#slowNudgedAt.get(goal.id) ?? 0) > 15 * 60_000) {
        this.#slowNudgedAt.set(goal.id, t);
        this.#event(goal, "Progress is slow, so the lead was asked to split the work and add help.");
        this.#wake(goal.id, {
          text:
            `Progress is slow: ${working.length} task${working.length === 1 ? "" : "s"} running (the longest for ${Math.round(longest / 60_000)} min) while ${waiting.length} wait${waiting.length === 1 ? "s" : ""}.\n` +
            `${statusTable(this.#store, goal.id, false)}\n` +
            "Speed matters: split the remaining work into smaller parallel tasks on separate files, drop dependencies that aren't real, and hire builders if there aren't enough (estimate can help you size it). Cancel or re-scope anything stuck.",
        });
        continue;
      }
      const moving =
        this.#leadBusy.has(goal.id) ||
        this.#wakes.get(goal.id)?.length ||
        tasks.some((x) => ["working", "queued", "changes"].includes(x.status));
      if (moving) {
        this.#sweepNudged.delete(goal.id);
        continue;
      }
      if (!this.#sweepNudged.has(goal.id)) {
        this.#sweepNudged.add(goal.id);
        this.#wake(goal.id, {
          text: `Nothing is moving on this goal.\n${statusTable(this.#store, goal.id, false)}\nDecide the next step: review, delegate what's missing, cancel blocked tasks, or finish_goal.`,
        });
      } else {
        this.#saveGoal({ ...goal, status: "stuck", note: "Nothing has moved for a while. Mention the lead with what to do next, or stop the team." });
        this.#publish(goal.id);
      }
    }
  }

  // ---------------------------------------------------------------- output into the thread

  #postReply(goal: Goal, id: string, text: string) {
    const lead = this.#store.getAgent(goal.leadAgentId);
    const item: ReplyItem = {
      id,
      threadId: goal.threadId,
      runId: `team:${goal.id}`,
      kind: "agent_reply",
      agentId: goal.leadAgentId,
      agentName: lead?.name ?? "lead",
      status: "completed",
      text,
      delivered: false,
    };
    this.#store.commit(goal.threadId, [{ type: "turn-item.upserted", item }]);
  }

  /** Upsert the team card in the goal's thread, and the thread's sidebar status. */
  /** The team card for one goal: what the lead's thread shows and what the Teams page lists. */
  card(goal: Goal, tasks = this.#store.listTasks(goal.id)): GoalCard {
    const ref = new Map(tasks.map((t) => [t.id, t.ref]));
    const lead = this.#store.getAgent(goal.leadAgentId);
    return {
      goalId: goal.id,
      title: goal.title,
      status: goal.status,
      leadAgentId: goal.leadAgentId,
      leadName: lead?.displayName ?? (lead ? `@${lead.name}` : "Lead"),
      note: goal.note,
      resumeAt: goal.resumeAt,
      startedAt: goal.createdAt,
      endedAt: goal.endedAt,
      tasks: tasks.map((t) => {
        const owner = this.#store.getAgent(t.agentId);
        const approvals =
          t.status === "working" && t.runThreadId && t.runId
            ? this.#store.pendingApprovalsFor(t.runThreadId, t.runId).flatMap((a) =>
                a.kind === "approval_request" ? [{ requestId: a.requestId, threadId: a.threadId, tool: a.tool, input: a.input }] : [],
              )
            : [];
        return {
          id: t.id,
          ref: t.ref,
          agentId: t.agentId,
          agentName: owner?.displayName ?? (owner ? `@${owner.name}` : "?"),
          title: t.title,
          status: t.status,
          autoAccept: t.autoAccept,
          dependsOn: t.dependsOn.map((d) => ref.get(d) ?? "?"),
          summary: t.result ? clip(t.result, 1500) : undefined,
          reviewNotes: t.reviewNotes,
          filesTouched: t.filesTouched,
          error: t.error,
          round: t.round,
          startedAt: t.startedAt,
          endedAt: t.endedAt,
          runThreadId: t.runThreadId ?? owner?.homeThreadId,
          approvals,
          activity:
            t.status === "working" && t.runThreadId && t.runId ? runActivity(this.#store, t.runThreadId, t.runId, t.progress?.at(-1)?.text) : undefined,
          budgetMs: LIMITS.taskBudgetMs,
          wrapping: this.#wrapping.has(t.id) || undefined,
          partial: t.partial,
        };
      }),
      lead: (() => {
        const lr = this.#leadRuns.get(goal.id);
        return { busy: this.#leadBusy.has(goal.id), threadId: lr?.threadId, activity: lr ? runActivity(this.#store, lr.threadId, lr.runId) : undefined };
      })(),
      speed: (() => {
        const done = tasks.filter((x) => x.status === "accepted" && x.startedAt && x.endedAt);
        const avg = done.length ? done.reduce((n, x) => n + (Date.parse(x.endedAt!) - Date.parse(x.startedAt!)), 0) / done.length : undefined;
        return { working: tasks.filter((x) => x.status === "working").length, max: LIMITS.maxParallel, done: done.length, avgTaskMin: avg ? Math.round(avg / 60_000) : undefined };
      })(),
      rounds: goal.criteria ? { round: goal.round ?? 1, max: goal.maxRounds ?? LIMITS.defaultRounds, criteria: goal.criteria, reports: goal.roundReports ?? [] } : undefined,
    };
  }

  #publish(goalId: string) {
    const goal = this.#store.getGoal(goalId);
    if (!goal) return;
    const tasks = this.#store.listTasks(goalId);
    const thread = this.#store.getThread(goal.threadId);
    if (!thread) return;
    if (tasks.length || !["planning", "done"].includes(goal.status)) {
      const card = this.card(goal, tasks);
      this.#store.commit(goal.threadId, [
        {
          type: "turn-item.upserted",
          item: { id: `team:${goal.id}`, threadId: goal.threadId, runId: `team:${goal.id}`, kind: "team_goal", ...card },
        },
      ]);
    }
    // Sidebar: how many teams are active here, and how many things need the person.
    const goals = this.#store.goalsForThread(goal.threadId);
    const active = goals.filter((g) => isOpen(g) && g.status !== "planning").length;
    let needsYou = 0;
    for (const g of goals.filter(isOpen)) {
      if (g.status === "stuck") needsYou++;
      for (const t of this.#store.listTasks(g.id)) {
        if (t.status === "parked") needsYou++;
        if (t.status === "working" && t.runThreadId && t.runId) needsYou += this.#store.pendingApprovalsFor(t.runThreadId, t.runId).length;
      }
    }
    // The agent threads doing this team's work, so their approvals aren't counted twice (here and on their own).
    const runs = goals.filter(isOpen).flatMap((g) => this.#store.listTasks(g.id).filter((t) => t.status === "working" && t.runThreadId).map((t) => t.runThreadId!));
    const fresh = this.#store.getThread(goal.threadId)!;
    if (fresh.team?.active !== active || fresh.team?.needsYou !== needsYou || (fresh.team?.runs ?? []).join() !== runs.join()) {
      this.#store.commit(goal.threadId, [{ type: "thread.upserted", thread: { ...fresh, team: { active, needsYou, runs } } }]);
    }
  }

  // ---------------------------------------------------------------- helpers

  #byRef(goalId: string, ref: string | undefined): TeamTask | undefined {
    const r = (ref ?? "").trim().toUpperCase().replace(/^#/, "");
    return this.#store.listTasks(goalId).find((t) => t.ref === r || t.ref === `T${r}`);
  }

  /**
   * Files a run wrote, relative to the project: from its tool calls (Claude Write/Edit, Codex apply_patch,
   * shell "> file"), or failing that, files git sees changed during the run's time window.
   */
  #filesTouched(homeThreadId: string, runId: string, project: string): string[] {
    const out = new Set<string>();
    let cwd = project;
    for (const item of this.#store.listRunItems(homeThreadId, runId)) {
      if (item.kind !== "tool_call" || item.status !== "completed") continue;
      const input = (item.input ?? {}) as Record<string, unknown>;
      const paths: string[] = [];
      if (typeof input.file_path === "string") paths.push(input.file_path);
      if (typeof input.notebook_path === "string") paths.push(input.notebook_path);
      if (Array.isArray(input.files)) for (const f of input.files) if (typeof f === "string") paths.push(f.replace(/^(add|update|delete|move)\s+/, ""));
      if (typeof input.command === "string") {
        const cd = input.command.match(/(?:^|&&|;)\s*cd\s+("([^"]+)"|'([^']+)'|(\S+))/);
        if (cd) cwd = cd[2] ?? cd[3] ?? cd[4];
        for (const w of shellWrites(input.command)) paths.push(isAbsolute(w) ? w : `${cwd}/${w}`);
      }
      for (const p of paths) {
        const rel = isAbsolute(p) ? relative(project, p) : p;
        if (rel && !rel.startsWith("..")) out.add(rel);
      }
    }
    if (!out.size) {
      const run = this.#store.getRun(runId);
      if (run) for (const f of changedDuring(project, run.startedAt, run.endedAt)) out.add(f);
    }
    return [...out].slice(0, 40);
  }

  #saveGoal(goal: Goal) {
    const prev = this.#store.getGoal(goal.id);
    this.#store.commit(`goal:${goal.id}`, [{ type: "goal.upserted", goal: { ...goal, updatedAt: now() } }]);
    if (prev && prev.status !== goal.status) {
      const lead = this.#store.getAgent(goal.leadAgentId);
      const text =
        goal.status === "paused" ? `Team paused: ${goal.note ?? "usage limit reached"}` :
        goal.status === "stuck" ? `Team is stuck: ${goal.note ?? "nothing is moving"}` :
        goal.status === "failed" ? `Team stopped: ${goal.note ?? "it failed"}` :
        goal.status === "cancelled" ? "Team stopped." :
        prev.status === "paused" && goal.status === "working" ? "Team resumed." : "";
      if (text) this.#event(goal, text, lead?.id);
    }
  }

  #saveTask(task: TeamTask) {
    const prev = this.#store.getTask(task.id);
    this.#store.commit(`goal:${task.goalId}`, [{ type: "task.upserted", task }]);
    this.#taskEvent(prev, task);
  }

  /** A one-line update in the goal's chat whenever a task moves, so you can follow along without opening anything. */
  #taskEvent(prev: TeamTask | undefined, t: TeamTask) {
    const goal = this.#store.getGoal(t.goalId);
    if (!goal) return;
    const who = `@${this.#store.getAgent(t.agentId)?.name ?? "?"}`;
    const lastNote = t.progress?.at(-1);
    if (prev && lastNote && lastNote.at !== prev.progress?.at(-1)?.at) {
      this.#event(goal, `${t.ref} · ${who}: ${lastNote.text}`, t.agentId, true);
    }
    if (prev?.status === t.status) return;
    const ref = (ids: string[]) => ids.map((id) => this.#store.getTask(id)?.ref ?? "?").join(", ");
    let text = "";
    switch (t.status) {
      case "queued":
      case "waiting":
        if (!prev) text = `${t.ref} · ${who} will do “${t.title}”${t.status === "waiting" ? ` after ${ref(t.dependsOn)}` : ""}.`;
        break;
      case "working":
        text = t.resumed
          ? `${t.ref} · ${who} is continuing “${t.title}” after a restart.`
          : prev?.status === "changes"
            ? `${t.ref} · ${who} is reworking “${t.title}”.`
            : `${t.ref} · ${who} started “${t.title}”${t.attempts > 1 ? " (trying again)" : ""}.`;
        break;
      case "submitted":
        text = `${t.ref} · ${who} submitted${t.partial ? " what it got done in its time (some is left)" : ""}; the lead is reviewing.`;
        break;
      case "accepted":
        text = `${t.ref} accepted${t.autoAccept && prev?.status === "working" ? " (no review needed)" : ""}${t.filesTouched?.length ? ` · ${t.filesTouched.length} file${t.filesTouched.length === 1 ? "" : "s"} changed` : ""}.`;
        break;
      case "changes":
        text = t.conflicts?.length
          ? `${t.ref} clashes with work merged meanwhile (${t.conflicts.slice(0, 3).join(", ")}); ${who} is resolving it.`
          : `The lead sent ${t.ref} back to ${who}: ${clip(t.reviewNotes, 160)}`;
        break;
      case "parked":
        text = `${t.ref} is stuck and needs a decision: ${clip(t.error, 160)}`;
        break;
      case "paused":
        text = `${t.ref} paused: usage limit reached; it resumes on its own.`;
        break;
      case "cancelled":
        text = `${t.ref} cancelled.`;
        break;
    }
    if (text) this.#event(goal, text, t.agentId);
  }

  #event(goal: Goal, text: string, agentId?: string, progress = false) {
    postNote(this.#store, goal.threadId, text, { runId: `team:${goal.id}`, team: true, progress, agentId });
  }
}

// ---------------------------------------------------------------- small pure helpers

/** Uncommitted files (git) whose modification time falls inside [from, to]. */
function changedDuring(project: string, from: string, to?: string): string[] {
  try {
    const list = execFileSync("git", ["-C", project, "status", "--porcelain", "-uall"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })
      .split("\n")
      .map((l) => l.slice(3).trim().replace(/^"|"$/g, ""))
      .filter(Boolean);
    const start = Date.parse(from) - 1000;
    const end = (to ? Date.parse(to) : Date.now()) + 1000;
    return list.filter((f) => {
      try {
        const m = statSync(`${project}/${f}`).mtimeMs;
        return m >= start && m <= end;
      } catch {
        return false;
      }
    });
  } catch {
    return [];
  }
}

function isOpen(goal: Goal | undefined): goal is Goal {
  return Boolean(goal) && ["planning", "working", "paused", "stuck"].includes(goal!.status);
}

function isActiveTask(t: TeamTask): boolean {
  return ["queued", "waiting", "working", "submitted", "changes", "paused"].includes(t.status);
}

function titleFrom(request: string, leadHandle: string): string {
  const text = request.replace(new RegExp(`@${leadHandle}\\b`, "g"), "").replace(/\s+/g, " ").trim();
  return clip(text.charAt(0).toUpperCase() + text.slice(1), 80) || "Team goal";
}
