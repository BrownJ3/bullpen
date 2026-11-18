// End-to-end test of standing jobs, the briefing and lessons against a running server (throwaway BULLPEN_HOME).
//   BULLPEN_HOME=... BULLPEN_PORT=... node scripts/jobs-smoke.ts <empty-git-repo>
// Covers: a manual job that reports NEEDS YOU, a job triggered by a new commit, a scheduled job firing on time,
// the briefing, and a lesson proposed from a correction, approved, and then followed.

import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { WebSocket } from "ws";
import { readToken } from "../src/home.ts";
import { DEFAULT_PORT, type Push, type Response } from "../src/protocol.ts";
import type { Job, JobRun, Lesson, StoredEvent, TurnItem } from "../src/types.ts";

const repo = process.argv[2];
if (!repo) throw new Error("usage: jobs-smoke.ts <empty-git-repo>");
const PORT = Number(process.env.BULLPEN_PORT ?? DEFAULT_PORT);
const ws = new WebSocket(`ws://127.0.0.1:${PORT}`, { headers: { authorization: `Bearer ${readToken()}` } });
let id = 1;
const waiters = new Map<number, (r: Response) => void>();
const runs = new Map<string, JobRun>();
const lessons = new Map<string, Lesson>();
const jobs = new Map<string, Job>();
const listeners = new Set<(e: StoredEvent) => void>();
ws.on("message", (raw) => {
  const msg = JSON.parse(String(raw)) as Response | Push;
  if ("subscription" in msg) {
    if ("items" in msg)
      for (const e of msg.items) {
        if (e.event.type === "jobrun.upserted") runs.set(e.event.run.id, e.event.run);
        if (e.event.type === "lesson.upserted") lessons.set(e.event.lesson.id, e.event.lesson);
        if (e.event.type === "job.upserted") jobs.set(e.event.job.id, e.event.job);
        for (const l of listeners) l(e);
      }
  } else waiters.get(msg.id)?.(msg);
});
async function call<T>(method: string, params?: unknown): Promise<T> {
  const myId = id++;
  ws.send(JSON.stringify({ id: myId, method, params }));
  const res = await new Promise<Response>((r) => waiters.set(myId, r));
  if ("error" in res) throw new Error(res.error);
  return res.result as T;
}
function check(cond: unknown, label: string) {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}`);
  if (!cond) process.exitCode = 1;
}
async function until<T>(fn: () => T | undefined, ms: number): Promise<T | undefined> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 1000));
  }
  return fn();
}
const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" });

await new Promise((r) => ws.once("open", r));
await call("subscribeSidebar");
await call("dispatch", { type: "settings.update", notifications: false }); // don't pop notifications during tests

const { agentId } = await call<{ agentId: string; threadId: string }>("dispatch", {
  type: "agent.create",
  name: "Night Watch",
  description: "Checks projects and reports",
  instructions: "You check projects carefully and report briefly. Follow the job's instructions exactly.",
  runtimeMode: "approval-required",
});

// ---- 1. A manual job that needs the person ----
const { jobId: j1 } = await call<{ jobId: string }>("dispatch", {
  type: "job.create",
  name: "TODO check",
  agentId,
  project: repo,
  instructions: "Check whether TODO.txt exists in the project. Do not create it. If it's missing, end with exactly one line: NEEDS YOU: create TODO.txt",
  trigger: { kind: "manual" },
});
await call("dispatch", { type: "job.run", jobId: j1 });
const r1 = await until(() => [...runs.values()].find((r) => r.jobId === j1 && r.status !== "running"), 4 * 60_000);
check(r1?.status === "needs-you", `manual job ran and needs you (${r1?.status})`);
check(r1?.needsYou.some((n) => /TODO\.txt/i.test(n)), `needs-you line captured (${r1?.needsYou.join(" | ")})`);
const job1 = (await call<{ jobs: Job[] }>("subscribeSidebar")).jobs.find((j) => j.id === j1);
const snap = await call<{ snapshot: { turnItems: TurnItem[]; thread: { jobId?: string } } }>("subscribeThread", { threadId: job1!.threadId });
check(snap.snapshot.thread.jobId === j1 && snap.snapshot.turnItems.some((i) => i.kind === "agent_reply" && i.status === "completed"), "result posted in the job's own thread");

// ---- 2. A commit-triggered job ----
const { jobId: j2 } = await call<{ jobId: string }>("dispatch", {
  type: "job.create",
  name: "Commit watcher",
  agentId,
  project: repo,
  instructions: "Reply with one line: the subjects of the new commits you were given, separated by commas.",
  trigger: { kind: "commit", branch: "main" },
});
await new Promise((r) => setTimeout(r, 1500));
writeFileSync(join(repo, "feature.txt"), "x\n");
git("add", ".");
git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "Add the zebra feature");
const r2 = await until(() => [...runs.values()].find((r) => r.jobId === j2 && r.status !== "running"), 4 * 60_000);
check(r2 && /commit/i.test(r2.reason), `commit triggered a run (${r2?.reason})`);
check(r2?.status === "done" && /zebra/i.test(r2.summary ?? ""), `agent saw the new commit (${r2?.summary?.slice(0, 80)})`);

// ---- 3. A scheduled job fires on time ----
const at = new Date(Date.now() + 60_000);
const time = `${String(at.getHours()).padStart(2, "0")}:${String(at.getMinutes()).padStart(2, "0")}`;
const { jobId: j3 } = await call<{ jobId: string }>("dispatch", {
  type: "job.create",
  name: "Scheduled ping",
  agentId,
  project: repo,
  instructions: "Reply with one line: 'All fine.'",
  trigger: { kind: "daily", time },
});
const r3 = await until(() => [...runs.values()].find((r) => r.jobId === j3 && r.status !== "running"), 3 * 60_000);
check(r3?.status === "done" && r3.reason === "On schedule", `daily job fired at ${time} (${r3?.reason}, ${r3?.status})`);
const j3after = await until(() => (jobs.get(j3)?.nextRunAt && Date.parse(jobs.get(j3)!.nextRunAt!) > Date.now() + 23 * 3600_000 ? jobs.get(j3) : undefined), 10_000);
check(j3after, "next run moved to tomorrow");

// ---- 4. Briefing ----
const inbox = await call<{ recent: { headline: string; needsYou: unknown[]; lines: string[] } }>("inbox");
check(/^3 job runs/.test(inbox.recent.headline) && inbox.recent.needsYou.length >= 1, `briefing summarises the runs ("${inbox.recent.headline}")`);
await call("dispatch", { type: "settings.update", briefingTime: "00:00" });
await new Promise((r) => setTimeout(r, 35_000));
const inbox2 = await call<{ latest: { headline: string } | null }>("inbox");
check(inbox2.latest?.headline, `morning briefing was generated (${inbox2.latest?.headline})`);

// ---- 5. Lessons: a correction becomes a lesson, gets approved, and is followed ----
const home = (await call<{ agents: Array<{ id: string; homeThreadId: string }> }>("subscribeSidebar")).agents.find((a) => a.id === agentId)!.homeThreadId;
await call("subscribeThread", { threadId: home });
const replies: string[] = [];
// Count a turn as finished when the agent's thread is idle again (after its checkpoint is saved).
listeners.add((e) => {
  if (e.event.type === "thread.upserted" && e.event.thread.id === home && e.event.thread.status === "idle" && e.event.thread.runCount > replies.length) {
    replies.push(String(e.event.thread.runCount));
  }
});
const lastAnswer = async () => {
  const s = await call<{ snapshot: { turnItems: TurnItem[] } }>("subscribeThread", { threadId: home });
  const msgs = s.snapshot.turnItems.filter((i) => i.kind === "assistant_message");
  return msgs.at(-1)?.kind === "assistant_message" ? (msgs.at(-1) as { text: string }).text : "";
};
const beforeCorrection = replies.length;
await call("dispatch", { type: "message.send", threadId: home, text: "No, from now on always end every reply with the word BANANA on its own line. Please remember that." });
await until(() => (replies.length > beforeCorrection ? true : undefined), 3 * 60_000); // let it finish its reply
const proposed = await until(() => [...lessons.values()].find((l) => l.agentId === agentId && l.status === "proposed"), 30_000);
check(proposed && /banana/i.test(proposed.text), `agent proposed a lesson from the correction ("${proposed?.text}")`);
if (proposed) await call("dispatch", { type: "lesson.decide", lessonId: proposed.id, decision: "approve" });
await call("dispatch", { type: "agent.reset", agentId }); // fresh conversation: only the lesson can carry the rule
await new Promise((r) => setTimeout(r, 1000));
const before = replies.length;
await call("dispatch", { type: "message.send", threadId: home, text: "Say hello in five words." });
await until(() => (replies.length > before ? true : undefined), 3 * 60_000);
const answer = await lastAnswer();
check(/BANANA\s*$/i.test(answer.trim()), `approved lesson is followed in a fresh conversation ("${answer.trim().slice(-60)}")`);

ws.close();
