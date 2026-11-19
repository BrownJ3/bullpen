// What the team engine says to the lead and to teammates (plain text, no state of its own).

import type { Store } from "./store.ts";
import type { Goal, TeamTask, Thread } from "./types.ts";
import { clip } from "./util.ts";
import { LIMITS } from "./limits.ts";


export function planPrompt(store: Store, goal: Goal, thread: Thread, context: string): string {
  const roster = store
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
      `- Size tasks to about 10 minutes of work each (a task's run has a ${LIMITS.taskBudgetMs / 60_000}-minute budget; at the budget it wraps up and submits what's done plus what's left). A request with five parts is several tasks, not one.`,
      "- Prefer parallel tasks on separate files over one long chain: a single big task that everything else depends on makes the whole team wait.",
      "- In briefs, give file paths relative to the project root: each teammate works in its own copy of the project, at a different path.",
      "- Open-ended goals ('keep improving until…', 'make it great'): first call set_goal_criteria with checkable criteria and a round limit, then run it in rounds: delegate a round, review, and next_round until the criteria are met.",
      "- Hand out each piece with the delegate tool: one owner per task, a self-contained brief (teammates can't see this conversation), the exact deliverable, the files or folders it may change, and depends_on for tasks that need another's result.",
      `- Tasks without dependencies run in parallel (up to ${LIMITS.maxParallel} at once), so give parallel tasks separate files. Add a reviewer task (code review, QA, security) only when the change is risky enough to need one.`,
      "- For routine, low-risk tasks pass review: 'skip' so they're accepted on submission and anything depending on them starts at once. Review only what's risky or central.",
      "- Your turn ends after you delegate. You'll be woken with results (several at once when they finish close together). Accept unless something is actually wrong; fix small things yourself instead of sending back; send back at most once, with every note in one message.",
      "- When everything is accepted, check the whole (tests or build if any) and call finish_goal with the report for the person.",
      "- Don't push, deploy, delete data or spend money; that's for the person to do.",
    ].join("\n"),
    `Your team:\n${roster || "(nobody yet; do it yourself, and suggest which specialists to recruit)"}`,
    "Now: plan and delegate. Then end your turn with a short message to the person (it's posted in the thread). Start it with either " +
      "\"I'll run this as a team (N tasks):\" followed by who is doing what, or, if you answered or did it yourself, \"Answering directly:\".",
  ]
    .filter(Boolean)
    .join("\n\n---\n\n");
}

export function updatePrompt(store: Store, goal: Goal, texts: string[]): string {
  return [
    `Team goal "${goal.title}" (project ${goal.project}): update.`,
    ...texts,
    `Current tasks:\n${statusTable(store, goal.id, false)}`,
    "Act now (review_task, delegate, cancel_task or finish_goal). Your turn should end with the goal moving forward.",
  ].join("\n\n---\n\n");
}

export function taskPrompt(store: Store, goal: Goal, task: TeamTask): string {
  const lead = store.getAgent(goal.leadAgentId);
  const dir = task.workspace?.path ?? goal.project;
  const deps = task.dependsOn
    .map((id) => store.getTask(id))
    .filter((t): t is TeamTask => Boolean(t))
    .map((t) => `${t.ref} (@${store.getAgent(t.agentId)?.name ?? "?"}: ${t.title}):\n${clip(t.result, 2000)}`);
  return [
    `You're on a team led by @${lead?.name ?? "lead"} for the goal "${goal.title}". Project folder: ${dir} (you have access to it; use absolute paths).` +
      (task.workspace ? " It's your own copy of the project (a git worktree); your changes are merged into the real project when the lead accepts them." : ""),
    `Your task (${task.ref}): ${task.title}`,
    `Brief:\n${task.brief}`,
    `Deliverable:\n${task.deliverable}`,
    task.files ? `Files you may change: ${task.files}` : "Keep changes minimal and inside the project.",
    deps.length ? `Results from the tasks this builds on:\n\n${deps.join("\n\n")}` : "",
    [
      "Rules:",
      task.workspace
        ? "- Work only inside that folder. Teammates work in their own copies at the same time; stay in your area so the changes merge cleanly."
        : "- Work only inside the project folder. Teammates may be editing other files at the same time, so stay in your area.",
      "- Change files with your file-editing tools and read them with your file-reading tools, not shell redirection or cat. Edits inside the project and tests/builds/git status run without approval; other shell commands wait for the person.",
      "- Don't commit, push, deploy or delete data.",
      "- Run the relevant tests, build or type check if the project has them.",
      `- You have about ${LIMITS.taskBudgetMs / 60_000} minutes. Do the deliverable first; submit as soon as it's done rather than polishing beyond the brief.`,
      "- Call report_progress with one short sentence after each meaningful step (it shows live to the person and the lead).",
      "- Your final message is your submission, so don't end your turn while anything you started is still running: run commands in the foreground and wait for them (background only for servers you keep running, and check their output before you finish).",
      "- Don't wait around: no sleep, no repeated screenshots. To test something timed (rounds, animations), shorten the timer for the test with a setting or env variable; check visually once per change.",
      `- Finish with your submission: what you did, the files you changed, how to verify it, and anything left open. That message goes to @${lead?.name ?? "the lead"} for review.`,
    ].join("\n"),
  ]
    .filter(Boolean)
    .join("\n\n---\n\n");
}

export function wrapUpPrompt(store: Store, goal: Goal, task: TeamTask): string {
  return [
    `Time's up for ${task.ref} ("${task.title}"): you've used the ${LIMITS.taskBudgetMs / 60_000}-minute budget.`,
    "Stop starting new work. In this one short turn: make sure what you changed is in a working state (revert half-finished edits if needed), then submit:",
    "- what's done (files changed, how to verify)",
    "- what's left, as a short list the lead can turn into follow-up tasks",
    `Your submission goes to @${store.getAgent(goal.leadAgentId)?.name ?? "the lead"}.`,
  ].join("\n");
}

export function conflictPrompt(store: Store, goal: Goal, task: TeamTask): string {
  return [
    `Your work on ${task.ref} ("${task.title}", goal "${goal.title}") was accepted, but it conflicts with teammates' work that was merged into the project after you started.`,
    `Your folder (${task.workspace?.path}) now holds the merged result. These files have git conflict markers (<<<<<<< ======= >>>>>>>): ${task.conflicts?.join(", ")}.`,
    "Resolve every conflict keeping both sides' intent, make sure no markers are left, rerun the relevant checks, and finish with a short note of how you resolved it. Don't commit.",
  ].join("\n\n");
}

export function reworkPrompt(store: Store, goal: Goal, task: TeamTask): string {
  const lead = store.getAgent(goal.leadAgentId);
  return [
    `@${lead?.name ?? "The lead"} reviewed your work on ${task.ref} ("${task.title}", goal "${goal.title}", project ${goal.project}) and sent it back once with these notes:`,
    task.reviewNotes ?? "",
    "Fix every point, rerun the relevant checks, and finish with an updated submission: what changed since last time, files changed, how to verify.",
  ].join("\n\n");
}

export function statusTable(store: Store, goalId: string, withResults: boolean): string {
  const tasks = store.listTasks(goalId);
  if (!tasks.length) return "(no tasks yet)";
  const ref = new Map(tasks.map((t) => [t.id, t.ref]));
  return tasks
    .map((t) => {
      const who = store.getAgent(t.agentId)?.name ?? "?";
      const deps = t.dependsOn.length ? ` (after ${t.dependsOn.map((d) => ref.get(d)).join(", ")})` : "";
      const extra = withResults && t.result ? `\n    result: ${clip(t.result, 600)}` : t.error ? ` — ${clip(t.error, 160)}` : "";
      return `${t.ref} @${who} — ${t.title} — ${t.status}${t.round ? " (sent back once)" : ""}${deps}${extra}`;
    })
    .join("\n");
}
