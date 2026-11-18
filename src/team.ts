// Teams: a lead agent turns a goal into tracked tasks for specialists, reviews each result once, and reports.
// Modeled on AgentOffice (delegate → submit → one-round review, reason-tagged wake-ups, retry-then-park,
// recovery sweep, stuck detection), scaled down to one goal per @mention in a thread.
//
// Nobody holds a turn open waiting for someone else: the lead's turn ends after it delegates, and it's
// woken with a reason ("T2 submitted", "T3 parked", "the person added…"). Wake-ups are batched.

import { randomUUID } from "node:crypto";
import { relative, isAbsolute } from "node:path";
import { execFileSync } from "node:child_process";
import { statSync } from "node:fs";
import type { Store } from "./store.ts";
import { shellWrites } from "./team-policy.ts";
import type { Agent, Goal, GoalCard, HarnessTool, TeamTask, Thread, TurnItem } from "./types.ts";

export const LIMITS = {
  maxTasks: 12, // per goal
  maxParallel: 3, // tasks working at once per goal
  taskTimeoutMs: 20 * 60_000,
  maxAttempts: 2, // one automatic retry, then park
  maxLeadTurns: 30, // per goal
  maxNudges: 3, // "you still need to review / finish" re-wakes in a row
  sweepMs: 30_000,
  /** Hold a review wake-up this long while other tasks are about to submit, so one lead turn reviews them all. */
  reviewBatchMs: 45_000,
  pauseDefaultMs: 15 * 60_000, // when a usage limit doesn't say when it resets
};

export interface ConsultOutcome {
  ok: boolean;
  text: string;
  runId?: string;
  homeThreadId?: string;
  /** The run hit the plan's usage limit (or was rate limited). */
  limited?: boolean;
  timedOut?: boolean;
}

/** What the team needs from the orchestrator. */
export interface TeamHost {
  consult(
    agent: Agent,
    prompt: string,
    chain: string[],
    project: string,
    opts: { team?: boolean; onRun?: (homeThreadId: string, runId: string) => void },
  ): Promise<ConsultOutcome>;
  interrupt(homeThreadId: string, runId: string): Promise<void>;
  transcript(threadId: string): string;
  /** Suggest a lasting lesson for an agent (the person approves it). */
  proposeLesson(agentId: string | undefined, text: string, source: { kind: "review"; threadId?: string; note?: string }): void;
}

type ReplyItem = Extract<TurnItem, { kind: "agent_reply" }>;
interface Wake {
  text: string;
  reply?: ReplyItem;
}

const now = () => new Date().toISOString();
const clip = (s: string | undefined, n: number) => (!s ? "" : s.length > n ? `${s.slice(0, n)}…` : s);
const LIMIT_RE = /usage limit|rate.?limit|limit (reached|exceeded)|too many requests|\b429\b|quota|overloaded/i;

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
        if (t.status === "working") this.#saveTask({ ...t, status: "queued", runId: undefined });
      }
      if (goal.status === "planning") this.#saveGoal({ ...goal, status: "working" });
      if (tasks.some((t) => t.status === "submitted")) this.#wake(goal.id, { text: "Bullpen restarted. Results are waiting for your review." });
      this.#pump(goal.id);
      this.#publish(goal.id);
    }
    this.#sweep = setInterval(() => this.#sweepAll(), LIMITS.sweepMs);
  }

  stop() {
    if (this.#sweep) clearInterval(this.#sweep);
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
      project: thread.cwd,
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
    this.#wake(goal.id, { text: this.#planPrompt(goal, thread, context), reply });
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
          return goal ? this.#review(goal, a) : none;
        },
      },
      {
        name: "team_status",
        description: "List this goal's tasks with owners, status and results.",
        params: {},
        run: async () => {
          const goal = goalOf();
          return goal ? { text: this.#statusTable(goal.id, true) } : none;
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
          return { text: "Goal finished; your report is posted in the thread. End your turn with a one-line confirmation." };
        },
      },
    ];
  }

  #delegate(goal: Goal, a: Record<string, string>) {
    const tasks = this.#store.listTasks(goal.id);
    if (tasks.length >= LIMITS.maxTasks) return { isError: true, text: `This goal already has ${LIMITS.maxTasks} tasks (the limit). Finish or cancel some first.` };
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

  #review(goal: Goal, a: Record<string, string>) {
    const task = this.#byRef(goal.id, a.task);
    if (!task) return { isError: true, text: `No task ${a.task}.` };
    if (task.status !== "submitted") return { isError: true, text: `${task.ref} is ${task.status}, not waiting for review.` };
    const decision = (a.decision ?? "").toLowerCase();
    if (a.lesson?.trim()) {
      this.#host.proposeLesson(task.agentId, a.lesson.trim(), { kind: "review", threadId: goal.threadId, note: `From the review of ${task.ref} "${task.title}"` });
    }
    if (decision.startsWith("acc")) {
      this.#saveTask({ ...task, status: "accepted", endedAt: now() });
      this.#pump(goal.id);
      this.#publish(goal.id);
      return { text: `${task.ref} accepted.` };
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
        if (goal.leadTurns >= LIMITS.maxLeadTurns) {
          this.#saveGoal({ ...goal, status: "stuck", note: `The lead used its ${LIMITS.maxLeadTurns} turns. Mention it to continue, or stop the team.` });
          this.#publish(goalId);
          break;
        }
        goal = { ...goal, leadTurns: goal.leadTurns + 1 };
        this.#saveGoal(goal);

        const isPlan = goal.status === "planning";
        const info = this.#info.get(goalId) ?? [];
        this.#info.delete(goalId);
        const prompt = isPlan ? batch.map((w) => w.text).join("\n\n---\n\n") : this.#updatePrompt(goal, [...info, ...batch.map((w) => w.text)]);
        const reply = batch.find((w) => w.reply)?.reply;
        let res: ConsultOutcome;
        try {
          // Attach the goal when the lead's turn actually starts: it may first have to finish a turn for another
          // goal, and that turn's cleanup must not detach this one.
          res = await this.#host.consult(lead, prompt, [], goal.project, {
            team: true,
            onRun: (home) => this.#runGoal.set(home, goalId),
          });
        } finally {
          if (this.#runGoal.get(lead.homeThreadId) === goalId) this.#runGoal.delete(lead.homeThreadId);
        }

        goal = this.#store.getGoal(goalId)!;
        if (res.limited) {
          this.#pauseGoal(goal, res.text);
          this.#wakes.set(goalId, [...batch, ...(this.#wakes.get(goalId) ?? [])]);
          break;
        }
        if (reply) this.#fillReply(goal.threadId, reply, res.ok, res.text);

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
    else if (allSettled) nudge = "Every task is accepted or cancelled. Check the whole (tests/build if any) and call finish_goal with the report.";
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
    task = { ...task, status: "working", attempts: task.attempts + 1, startedAt: task.startedAt ?? now(), error: undefined };
    this.#saveTask(task);
    this.#publish(goal.id);

    const prompt = rework ? this.#reworkPrompt(goal, task) : this.#taskPrompt(goal, task);
    const res = await this.#host.consult(agent, prompt, [goal.leadAgentId], goal.project, {
      team: true,
      onRun: (homeThreadId, runId) => {
        const t = this.#store.getTask(taskId);
        if (t) this.#saveTask({ ...t, runThreadId: homeThreadId, runId });
        this.#publish(goal.id);
        this.#timers.set(
          taskId,
          setTimeout(() => {
            this.#timedOut.add(taskId);
            void this.#host.interrupt(homeThreadId, runId);
          }, LIMITS.taskTimeoutMs),
        );
      },
    });
    clearTimeout(this.#timers.get(taskId));
    this.#timers.delete(taskId);
    const timedOut = this.#timedOut.delete(taskId);

    task = this.#store.getTask(taskId)!;
    const g = this.#store.getGoal(goal.id)!;
    if (task.status !== "working" || !isOpen(g)) {
      this.#publish(goal.id); // cancelled meanwhile
      return;
    }
    if (res.ok) {
      const touched = res.homeThreadId && res.runId ? this.#filesTouched(res.homeThreadId, res.runId, goal.project) : [];
      if (task.autoAccept && !rework) {
        // Fast lane: no review turn. Dependents start now; the lead sees the result when it next wakes.
        this.#saveTask({ ...task, status: "accepted", result: res.text, filesTouched: touched, runId: undefined, endedAt: now() });
        this.#queueInfo(goal.id, `${task.ref} (@${agent.name}: ${task.title}) finished and was accepted automatically:\n${clip(res.text, 1500)}`);
        this.#maybeWakeForFinish(goal.id);
      } else {
        this.#saveTask({ ...task, status: "submitted", result: res.text, filesTouched: touched, runId: undefined });
        this.#wakeForReview(goal.id, {
          text:
            `${task.ref} (@${agent.name}: ${task.title}) was ${rework ? "resubmitted after your notes" : "submitted"}:\n\n${clip(res.text, 4000)}` +
            (touched.length ? `\n\nFiles touched: ${touched.join(", ")}` : "") +
            `\n\nReview it with review_task (${rework ? "this was the one send-back, so accept it, fixing any small leftovers yourself" : "accept unless something is actually wrong; fix small things yourself rather than sending back"}).`,
        });
      }
    } else if (res.limited) {
      const resumeAt = resumeTime(res.text);
      this.#saveTask({ ...task, status: "paused", error: "Usage limit reached", resumeAt, runId: undefined });
      this.#pauseGoal(g, res.text);
    } else {
      const error = timedOut ? `Took longer than ${LIMITS.taskTimeoutMs / 60_000} minutes and was stopped.` : clip(res.text, 600) || "Failed.";
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
    if (tasks.length && tasks.every((t) => ["accepted", "cancelled"].includes(t.status))) {
      this.#wake(goalId, { text: "Every task is accepted. Check the whole (tests/build if any) and call finish_goal with the report." });
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
          text: `Nothing is moving on this goal.\n${this.#statusTable(goal.id, false)}\nDecide the next step: review, delegate what's missing, cancel blocked tasks, or finish_goal.`,
        });
      } else {
        this.#saveGoal({ ...goal, status: "stuck", note: "Nothing has moved for a while. Mention the lead with what to do next, or stop the team." });
        this.#publish(goal.id);
      }
    }
  }

  // ---------------------------------------------------------------- prompts

  #planPrompt(goal: Goal, thread: Thread, context: string): string {
    const roster = this.#store
      .listAgents()
      .filter((a) => a.id !== goal.leadAgentId)
      .map((a) => `@${a.name}${a.displayName ? ` (${a.displayName})` : ""}${a.description ? ` — ${a.description}` : ""}`)
      .join("\n");
    return [
      `You were @mentioned in the thread "${thread.title}" and are leading this as a team goal. Project folder: ${goal.project} (you have access to it).`,
      context ? `Recent conversation in that thread:\n\n${context}` : "",
      `The person asked:\n\n${goal.request}`,
      [
        "How team goals work:",
        "- Speed matters more than ceremony: every handoff costs a turn. If it's small or just a question, answer or do it yourself and don't create tasks.",
        "- Use the fewest tasks that get it done well: give each specialist a complete, self-contained piece (a whole feature slice, not fragments), and don't add steps for their own sake.",
        "- Hand out each piece with the delegate tool: one owner per task, a self-contained brief (teammates can't see this conversation), the exact deliverable, the files or folders it may change, and depends_on for tasks that need another's result.",
        `- Tasks without dependencies run in parallel (up to ${LIMITS.maxParallel} at once), so give parallel tasks separate files. Add a reviewer task (code review, QA, security) only when the change is risky enough to need one.`,
        "- For routine, low-risk tasks pass review: 'skip' so they're accepted on submission and anything depending on them starts at once. Review only what's risky or central.",
        "- Your turn ends after you delegate. You'll be woken with results (several at once when they finish close together). Accept unless something is actually wrong; fix small things yourself instead of sending back; send back at most once, with every note in one message.",
        "- When everything is accepted, check the whole (tests or build if any) and call finish_goal with the report for the person.",
        "- Don't push, deploy, delete data or spend money; that's for the person to do.",
      ].join("\n"),
      `Your team:\n${roster || "(nobody yet; do it yourself, and suggest which specialists to recruit)"}`,
      "Now: plan and delegate. Then end your turn with a short message to the person saying who is doing what (it's posted in the thread).",
    ]
      .filter(Boolean)
      .join("\n\n---\n\n");
  }

  #updatePrompt(goal: Goal, texts: string[]): string {
    return [
      `Team goal "${goal.title}" (project ${goal.project}): update.`,
      ...texts,
      `Current tasks:\n${this.#statusTable(goal.id, false)}`,
      "Act now (review_task, delegate, cancel_task or finish_goal). Your turn should end with the goal moving forward.",
    ].join("\n\n---\n\n");
  }

  #taskPrompt(goal: Goal, task: TeamTask): string {
    const lead = this.#store.getAgent(goal.leadAgentId);
    const deps = task.dependsOn
      .map((id) => this.#store.getTask(id))
      .filter((t): t is TeamTask => Boolean(t))
      .map((t) => `${t.ref} (@${this.#store.getAgent(t.agentId)?.name ?? "?"}: ${t.title}):\n${clip(t.result, 2000)}`);
    return [
      `You're on a team led by @${lead?.name ?? "lead"} for the goal "${goal.title}". Project folder: ${goal.project} (you have access to it; use absolute paths).`,
      `Your task (${task.ref}): ${task.title}`,
      `Brief:\n${task.brief}`,
      `Deliverable:\n${task.deliverable}`,
      task.files ? `Files you may change: ${task.files}` : "Keep changes minimal and inside the project.",
      deps.length ? `Results from the tasks this builds on:\n\n${deps.join("\n\n")}` : "",
      [
        "Rules:",
        "- Work only inside the project folder. Teammates may be editing other files at the same time, so stay in your area.",
        "- Change files with your file-editing tools and read them with your file-reading tools, not shell redirection or cat. Edits inside the project and tests/builds/git status run without approval; other shell commands wait for the person.",
        "- Don't commit, push, deploy or delete data.",
        "- Run the relevant tests, build or type check if the project has them.",
        `- Finish with your submission: what you did, the files you changed, how to verify it, and anything left open. That message goes to @${lead?.name ?? "the lead"} for review.`,
      ].join("\n"),
    ]
      .filter(Boolean)
      .join("\n\n---\n\n");
  }

  #reworkPrompt(goal: Goal, task: TeamTask): string {
    const lead = this.#store.getAgent(goal.leadAgentId);
    return [
      `@${lead?.name ?? "The lead"} reviewed your work on ${task.ref} ("${task.title}", goal "${goal.title}", project ${goal.project}) and sent it back once with these notes:`,
      task.reviewNotes ?? "",
      "Fix every point, rerun the relevant checks, and finish with an updated submission: what changed since last time, files changed, how to verify.",
    ].join("\n\n");
  }

  #statusTable(goalId: string, withResults: boolean): string {
    const tasks = this.#store.listTasks(goalId);
    if (!tasks.length) return "(no tasks yet)";
    const ref = new Map(tasks.map((t) => [t.id, t.ref]));
    return tasks
      .map((t) => {
        const who = this.#store.getAgent(t.agentId)?.name ?? "?";
        const deps = t.dependsOn.length ? ` (after ${t.dependsOn.map((d) => ref.get(d)).join(", ")})` : "";
        const extra = withResults && t.result ? `\n    result: ${clip(t.result, 600)}` : t.error ? ` — ${clip(t.error, 160)}` : "";
        return `${t.ref} @${who} — ${t.title} — ${t.status}${t.round ? " (sent back once)" : ""}${deps}${extra}`;
      })
      .join("\n");
  }

  // ---------------------------------------------------------------- output into the thread

  #fillReply(threadId: string, reply: ReplyItem, ok: boolean, text: string) {
    this.#store.commit(threadId, [
      { type: "turn-item.upserted", item: { ...reply, status: ok ? "completed" : "failed", text: text || "(no answer)" } },
    ]);
  }

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
        };
      }),
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
    const fresh = this.#store.getThread(goal.threadId)!;
    if (fresh.team?.active !== active || fresh.team?.needsYou !== needsYou) {
      this.#store.commit(goal.threadId, [{ type: "thread.upserted", thread: { ...fresh, team: { active, needsYou } } }]);
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
    this.#store.commit(`goal:${goal.id}`, [{ type: "goal.upserted", goal: { ...goal, updatedAt: now() } }]);
  }

  #saveTask(task: TeamTask) {
    this.#store.commit(`goal:${task.goalId}`, [{ type: "task.upserted", task }]);
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

export function isLimitError(text: string): boolean {
  return LIMIT_RE.test(text);
}

/** When to try again after a usage limit: "resets 3pm" / "resets at 15:00" if the message says, else 15 minutes. */
export function resumeTime(text: string): string {
  const m = text.match(/reset[s]?\s*(?:at\s*)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i);
  const t = new Date();
  if (m) {
    let h = Number(m[1]);
    const min = Number(m[2] ?? 0);
    if (m[3]) h = (h % 12) + (m[3].toLowerCase() === "pm" ? 12 : 0);
    const at = new Date(t);
    at.setHours(h, min + 1, 0, 0);
    if (at <= t) at.setDate(at.getDate() + 1);
    if (at.getTime() - t.getTime() < 12 * 3600_000) return at.toISOString();
  }
  return new Date(t.getTime() + LIMITS.pauseDefaultMs).toISOString();
}
