// Standing jobs: agents that work on a schedule or when something happens, while you're away.
// A job belongs to an agent and a project. Each run happens in the job's own thread, in team mode (edits in the
// project and safe commands without asking), either solo or as a team goal when the agent can lead.
// Results that need you are marked "NEEDS YOU:" and collected into notifications and the morning briefing.

import { execFile, execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { Store } from "./store.ts";
import { isLimitError, resumeTime, type ConsultOutcome } from "./team.ts";
import type { Agent, Job, JobRun, JobRunStatus, JobTrigger, Thread, TurnItem } from "./types.ts";

const TICK_MS = 30_000;
const COMMIT_POLL_MS = 60_000;
const MAX_CONCURRENT_RUNS = 2;

type ReplyItem = Extract<TurnItem, { kind: "agent_reply" }>;

export interface JobsHost {
  consult(agent: Agent, prompt: string, chain: string[], project: string, opts: { team?: boolean }): Promise<ConsultOutcome>;
  startTeamGoal(thread: Thread, lead: Agent, request: string, reply: ReplyItem): string;
  /** A thread for the job's runs, in its project. */
  createJobThread(project: string, title: string, jobId: string): Thread;
}

export interface Briefing {
  at: string;
  since: string;
  headline: string;
  lines: string[];
  needsYou: Array<{ jobId: string; jobName: string; threadId: string; text: string }>;
}

const now = () => new Date().toISOString();
const clip = (s: string | undefined, n: number) => (!s ? "" : s.length > n ? `${s.slice(0, n)}…` : s);
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** "Every day at 2:00 AM", "Weekdays at 9:00", "Every 6 hours", "On new commits to main". */
export function describeTrigger(t: JobTrigger): string {
  switch (t.kind) {
    case "manual":
      return "When you run it";
    case "interval":
      return t.hours === 1 ? "Every hour" : `Every ${t.hours} hours`;
    case "commit":
      return `On new commits to ${t.branch}`;
    case "daily": {
      const [h, m] = t.time.split(":").map(Number);
      const time = new Date(2000, 0, 1, h, m).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
      const days = t.days?.length && t.days.length < 7 ? t.days : undefined;
      if (!days) return `Every day at ${time}`;
      if (days.join() === "1,2,3,4,5") return `Weekdays at ${time}`;
      return `${days.map((d) => DAYS[d]).join(", ")} at ${time}`;
    }
  }
}

/** When a scheduled job should next run, after `from`. Commit and manual jobs have no schedule. */
export function nextRunAt(t: JobTrigger, from = new Date()): string | undefined {
  if (t.kind === "interval") return new Date(from.getTime() + Math.max(0.25, t.hours) * 3600_000).toISOString();
  if (t.kind !== "daily") return undefined;
  const [h, m] = t.time.split(":").map(Number);
  const days = t.days?.length ? new Set(t.days) : undefined;
  for (let i = 0; i < 8; i++) {
    const d = new Date(from);
    d.setDate(d.getDate() + i);
    d.setHours(h, m, 0, 0);
    if (d > from && (!days || days.has(d.getDay()))) return d.toISOString();
  }
  return undefined;
}

export function validTrigger(t: JobTrigger | undefined): t is JobTrigger {
  if (!t) return false;
  if (t.kind === "daily") return /^([01]?\d|2[0-3]):[0-5]\d$/.test(t.time) && (!t.days || t.days.every((d) => d >= 0 && d <= 6));
  if (t.kind === "interval") return Number.isFinite(t.hours) && t.hours >= 0.25 && t.hours <= 24 * 14;
  if (t.kind === "commit") return /^[\w./-]+$/.test(t.branch);
  return t.kind === "manual";
}

/** Lines the agent marked as needing the person. */
export function needsYouLines(text: string): string[] {
  return text
    .split("\n")
    .map((l) => l.trim().replace(/^[-*•]\s+/, "").replace(/\*\*|__/g, "").trim())
    .filter((l) => /^NEEDS YOU:/i.test(l))
    .map((l) => l.replace(/^NEEDS YOU:\s*/i, "").trim())
    .filter(Boolean);
}

/** A macOS notification (no-op elsewhere). */
export function notify(title: string, subtitle: string, body: string) {
  if (process.platform !== "darwin") return;
  const q = (s: string) => JSON.stringify(clip(s.replace(/\s+/g, " "), 240));
  execFile("osascript", ["-e", `display notification ${q(body)} with title ${q(title)} subtitle ${q(subtitle)}`], () => {});
}

export class Jobs {
  readonly #store: Store;
  readonly #host: JobsHost;
  #tick: NodeJS.Timeout | undefined;
  #commitPoll: NodeJS.Timeout | undefined;
  /** Jobs with a run in progress (one at a time per job). */
  readonly #running = new Set<string>();

  constructor(store: Store, host: JobsHost) {
    this.#store = store;
    this.#host = host;
  }

  start() {
    for (const run of this.#store.runningJobRuns()) {
      if (run.goalId) continue; // team runs finish with their goal
      this.#saveRun({ ...run, status: "failed", summary: "Bullpen restarted during this run.", endedAt: now() });
    }
    for (const job of this.#store.listJobs()) {
      if (job.enabled && !job.nextRunAt && (job.trigger.kind === "daily" || job.trigger.kind === "interval")) {
        this.#saveJob({ ...job, nextRunAt: nextRunAt(job.trigger) });
      }
    }
    this.#tick = setInterval(() => this.#onTick(), TICK_MS);
    this.#commitPoll = setInterval(() => this.#pollCommits(), COMMIT_POLL_MS);
    setTimeout(() => this.#pollCommits(), 5000);
  }

  stop() {
    if (this.#tick) clearInterval(this.#tick);
    if (this.#commitPoll) clearInterval(this.#commitPoll);
  }

  // ---------------------------------------------------------------- commands

  create(cmd: { name: string; agentId: string; project: string; instructions: string; trigger: JobTrigger; mode?: "solo" | "team"; enabled?: boolean }): Job {
    const agent = this.#store.getAgent(cmd.agentId);
    if (!agent) throw new Error("Pick an agent for this job.");
    if (!cmd.name?.trim() || !cmd.instructions?.trim()) throw new Error("A job needs a name and what to do.");
    if (!validTrigger(cmd.trigger)) throw new Error("That schedule isn't valid.");
    const mode = cmd.mode === "team" && agent.canLead ? "team" : "solo";
    const id = randomUUID();
    const thread = this.#host.createJobThread(cmd.project, `⏱ ${cmd.name.trim()}`, id);
    const job: Job = {
      id,
      name: cmd.name.trim().slice(0, 80),
      agentId: agent.id,
      project: thread.cwd,
      instructions: cmd.instructions.trim(),
      trigger: cmd.trigger,
      mode,
      enabled: cmd.enabled ?? true,
      threadId: thread.id,
      nextRunAt: nextRunAt(cmd.trigger),
      lastCommit: cmd.trigger.kind === "commit" ? headOf(thread.cwd, cmd.trigger.branch) : undefined,
      runCount: 0,
      createdAt: now(),
      updatedAt: now(),
    };
    this.#saveJob(job);
    return job;
  }

  update(cmd: { jobId: string; name?: string; agentId?: string; instructions?: string; trigger?: JobTrigger; mode?: "solo" | "team"; enabled?: boolean }) {
    const job = this.#store.getJob(cmd.jobId);
    if (!job) throw new Error("Unknown job.");
    if (cmd.trigger && !validTrigger(cmd.trigger)) throw new Error("That schedule isn't valid.");
    const agentId = cmd.agentId ?? job.agentId;
    const agent = this.#store.getAgent(agentId);
    if (!agent) throw new Error("Unknown agent.");
    const trigger = cmd.trigger ?? job.trigger;
    const triggerChanged = JSON.stringify(trigger) !== JSON.stringify(job.trigger);
    const next: Job = {
      ...job,
      name: cmd.name?.trim() || job.name,
      agentId,
      instructions: cmd.instructions?.trim() || job.instructions,
      trigger,
      mode: (cmd.mode ?? job.mode) === "team" && agent.canLead ? "team" : "solo",
      enabled: cmd.enabled ?? job.enabled,
    };
    if (triggerChanged || (next.enabled && !job.enabled)) next.nextRunAt = nextRunAt(trigger);
    if (trigger.kind === "commit" && (triggerChanged || !job.lastCommit)) next.lastCommit = headOf(job.project, trigger.branch);
    this.#saveJob(next);
  }

  delete(jobId: string) {
    const job = this.#store.getJob(jobId);
    if (!job) return;
    this.#store.commit(`job:${jobId}`, [{ type: "job.deleted", jobId }]);
    const thread = this.#store.getThread(job.threadId);
    if (thread) this.#store.commit(thread.id, [{ type: "thread.upserted", thread: { ...thread, jobId: undefined, title: `${thread.title} (job deleted)` } }]);
  }

  runNow(jobId: string) {
    const job = this.#store.getJob(jobId);
    if (!job) throw new Error("Unknown job.");
    if (this.#running.has(jobId)) throw new Error("This job is already running.");
    void this.#run(job, "Run by you");
  }

  // ---------------------------------------------------------------- scheduling

  /** While the plan's usage limit is reached, jobs wait (so overnight work doesn't eat tomorrow's limit). */
  #pausedUntil(): number {
    const until = this.#store.getSetting<string | null>("jobs.pausedUntil", null);
    return until ? Date.parse(until) : 0;
  }

  #onTick() {
    const t = Date.now();
    this.#maybeBrief(new Date(t));
    if (this.#pausedUntil() > t) return;
    for (const job of this.#store.listJobs()) {
      if (!job.enabled || this.#running.has(job.id) || !job.nextRunAt) continue;
      if (Date.parse(job.nextRunAt) > t) continue;
      if (this.#running.size >= MAX_CONCURRENT_RUNS) break;
      void this.#run(job, "On schedule");
    }
    this.#checkTeamRuns();
  }

  #pollCommits() {
    if (this.#pausedUntil() > Date.now()) return;
    for (const job of this.#store.listJobs()) {
      if (!job.enabled || job.trigger.kind !== "commit" || this.#running.has(job.id)) continue;
      const head = headOf(job.project, job.trigger.branch);
      if (!head) continue;
      if (!job.lastCommit) {
        this.#saveJob({ ...job, lastCommit: head });
        continue;
      }
      if (head === job.lastCommit || this.#running.size >= MAX_CONCURRENT_RUNS) continue;
      const log = commitsBetween(job.project, job.lastCommit, head);
      this.#saveJob({ ...this.#store.getJob(job.id)!, lastCommit: head });
      void this.#run(job, `New commits on ${job.trigger.branch} (${head.slice(0, 7)})`, log ? `New commits since the last run:\n${log}` : undefined);
    }
  }

  // ---------------------------------------------------------------- running

  async #run(job: Job, reason: string, extra?: string) {
    const agent = this.#store.getAgent(job.agentId);
    const thread = this.#store.getThread(job.threadId);
    if (!agent || !thread) return;
    this.#running.add(job.id);
    const previous = this.#store.jobRunsFor(job.id, 1)[0];
    const run: JobRun = { id: randomUUID(), jobId: job.id, reason, status: "running", needsYou: [], startedAt: now() };
    this.#saveRun(run);
    // Save over the latest copy: the commit poller may have just recorded the commit this run is for.
    this.#saveJob({
      ...(this.#store.getJob(job.id) ?? job),
      lastRunAt: run.startedAt,
      lastStatus: "running",
      runCount: job.runCount + 1,
      nextRunAt: nextRunAt(job.trigger, new Date()),
    });
    const reply: ReplyItem = {
      id: `jobrun:${run.id}`,
      threadId: thread.id,
      runId: `jobrun:${run.id}`,
      kind: "agent_reply",
      agentId: agent.id,
      agentName: agent.name,
      status: "running",
      text: "",
      delivered: false,
    };
    this.#store.commit(thread.id, [
      {
        type: "turn-item.upserted",
        item: { id: `jobstart:${run.id}`, threadId: thread.id, runId: reply.runId, kind: "user_message", text: `⏱ ${reason}` },
      },
      { type: "turn-item.upserted", item: reply },
    ]);
    const prompt = this.#prompt(job, reason, extra, previous);
    try {
      if (job.mode === "team" && agent.canLead) {
        const goalId = this.#host.startTeamGoal(thread, agent, prompt, reply);
        this.#saveRun({ ...run, goalId });
        return; // finishes with its goal (#checkTeamRuns)
      }
      const res = await this.#host.consult(agent, prompt, [], job.project, { team: true });
      this.#store.commit(thread.id, [
        { type: "turn-item.upserted", item: { ...reply, status: res.ok ? "completed" : "failed", text: res.text || "(no answer)" } },
      ]);
      if (res.limited) {
        const until = resumeTime(res.text);
        this.#store.commit("settings", [{ type: "setting.upserted", key: "jobs.pausedUntil", value: until }]);
        this.#finish(run, "paused", `Paused: your plan's usage limit was reached. Jobs resume around ${new Date(until).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}.`);
        // Run this job again once the limit resets.
        this.#saveJob({ ...this.#store.getJob(job.id)!, nextRunAt: until });
        return;
      }
      const needs = needsYouLines(res.text);
      this.#finish(run, !res.ok ? "failed" : needs.length ? "needs-you" : "done", firstParagraph(res.text), needs);
    } finally {
      if (!(job.mode === "team" && agent.canLead)) this.#running.delete(job.id);
    }
  }

  /** Team-mode runs end when their goal does. */
  #checkTeamRuns() {
    for (const run of this.#store.runningJobRuns()) {
      if (!run.goalId) continue;
      const goal = this.#store.getGoal(run.goalId);
      if (!goal) continue;
      if (goal.status === "done") {
        const text = goal.report ?? goal.note ?? "Done.";
        const needs = needsYouLines(text);
        this.#finish(run, needs.length ? "needs-you" : "done", firstParagraph(text), needs);
      } else if (goal.status === "cancelled" || goal.status === "failed") {
        this.#finish(run, "failed", goal.note ?? `Team ${goal.status}.`);
      } else if (goal.status === "stuck") {
        this.#finish(run, "needs-you", goal.note ?? "The team is stuck.", [goal.note ?? "The team needs a decision."]);
      } else {
        continue;
      }
      this.#running.delete(run.jobId);
    }
  }

  #finish(run: JobRun, status: JobRunStatus, summary: string, needsYou: string[] = []) {
    const done: JobRun = { ...run, status, summary: clip(summary, 600), needsYou, endedAt: now() };
    this.#saveRun(done);
    const job = this.#store.getJob(run.jobId);
    if (job) this.#saveJob({ ...job, lastStatus: status });
    if (status === "needs-you" && this.#notifications()) {
      notify("Bullpen", `${job?.name ?? "A job"} needs you`, needsYou[0] ?? summary);
    } else if (status === "failed" && this.#notifications()) {
      notify("Bullpen", `${job?.name ?? "A job"} failed`, summary);
    }
  }

  #prompt(job: Job, reason: string, extra: string | undefined, previous: JobRun | undefined): string {
    return [
      `Standing job "${job.name}" (${describeTrigger(job.trigger)}). Project folder: ${job.project} (you have access to it).`,
      `Why now: ${reason}.${extra ? `\n\n${extra}` : ""}`,
      previous ? `Last run (${new Date(previous.startedAt).toLocaleString()}): ${previous.status}. ${clip(previous.summary, 500)}` : "This is the first run.",
      `What to do:\n${job.instructions}`,
      [
        "You're working unattended:",
        "- Edits inside the project and tests/builds/git status run without approval; anything else waits for the person, so prefer checks over changes unless the job asks for changes.",
        "- Don't commit, push, deploy or delete data.",
        "- Finish with a short summary: what you checked, what you changed (files), and for each thing that needs the person's decision a separate line starting with \"NEEDS YOU:\". If all is well, say so in one line.",
      ].join("\n"),
    ].join("\n\n---\n\n");
  }

  // ---------------------------------------------------------------- morning briefing

  #notifications(): boolean {
    return this.#store.getSetting("notifications", true);
  }

  /** What happened since `since`: run counts, one line per job, and what needs the person. */
  briefing(since?: string): Briefing {
    const from = since ?? this.#store.getSetting<string | null>("briefing.lastAt", null) ?? new Date(Date.now() - 24 * 3600_000).toISOString();
    const runs = this.#store.jobRunsSince(from);
    const jobs = new Map(this.#store.listJobs().map((j) => [j.id, j]));
    const byJob = new Map<string, JobRun[]>();
    for (const r of runs) byJob.set(r.jobId, [...(byJob.get(r.jobId) ?? []), r]);
    const lines: string[] = [];
    const needsYou: Briefing["needsYou"] = [];
    for (const [jobId, list] of byJob) {
      const job = jobs.get(jobId);
      if (!job) continue;
      const latest = list[0];
      const counts = `${list.length} run${list.length === 1 ? "" : "s"}`;
      lines.push(`${job.name}: ${counts}, last ${latest.status}. ${clip(latest.summary, 180)}`);
      for (const r of list) for (const n of r.needsYou) needsYou.push({ jobId, jobName: job.name, threadId: job.threadId, text: n });
    }
    const failed = runs.filter((r) => r.status === "failed").length;
    const headline = !runs.length
      ? "Quiet: no jobs ran."
      : `${runs.length} job run${runs.length === 1 ? "" : "s"}${needsYou.length ? `, ${needsYou.length} need${needsYou.length === 1 ? "s" : ""} you` : ""}${failed ? `, ${failed} failed` : ""}.`;
    return { at: now(), since: from, headline, lines, needsYou };
  }

  #maybeBrief(t: Date) {
    if (!this.#store.getSetting("briefing.enabled", true)) return;
    const time = this.#store.getSetting("briefing.time", "08:00");
    const [h, m] = time.split(":").map(Number);
    const due = new Date(t);
    due.setHours(h, m, 0, 0);
    if (t < due) return;
    const last = this.#store.getSetting<string | null>("briefing.lastAt", null);
    if (last && Date.parse(last) >= due.getTime()) return;
    if (!last && !this.#store.jobRunsSince(new Date(0).toISOString()).length) {
      // A fresh install: nothing has run yet, so start the clock quietly instead of announcing an empty briefing.
      this.#store.commit("settings", [{ type: "setting.upserted", key: "briefing.lastAt", value: t.toISOString() }]);
      return;
    }
    const b = this.briefing(last ?? undefined);
    this.#store.commit("settings", [
      { type: "setting.upserted", key: "briefing.latest", value: b },
      { type: "setting.upserted", key: "briefing.lastAt", value: t.toISOString() },
    ]);
    const lessons = this.#store.listLessons().filter((l) => l.status === "proposed").length;
    if (this.#notifications() && (b.lines.length || lessons)) {
      notify("Bullpen", "Morning briefing", `${b.headline}${lessons ? ` ${lessons} lesson${lessons === 1 ? "" : "s"} to review.` : ""}`);
    }
  }

  // ---------------------------------------------------------------- storage

  #saveJob(job: Job) {
    this.#store.commit(`job:${job.id}`, [{ type: "job.upserted", job: { ...job, updatedAt: now() } }]);
  }

  #saveRun(run: JobRun) {
    this.#store.commit(`job:${run.jobId}`, [{ type: "jobrun.upserted", run }]);
  }
}

// ---------------------------------------------------------------- git helpers

function headOf(project: string, branch: string): string | undefined {
  try {
    return execFileSync("git", ["-C", project, "rev-parse", "--verify", "--quiet", `${branch}^{commit}`], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim() || undefined;
  } catch {
    return undefined;
  }
}

function commitsBetween(project: string, from: string, to: string): string {
  try {
    return execFileSync("git", ["-C", project, "log", "--oneline", "--no-decorate", "-n", "30", `${from}..${to}`], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "";
  }
}

function firstParagraph(text: string): string {
  const t = text.trim();
  const para = t.split(/\n\s*\n/)[0] ?? t;
  return para.length > 40 ? para : clip(t, 600);
}
