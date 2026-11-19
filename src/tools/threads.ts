// Chats as tools (T3: t3_thread_launch/list/read/send/wait): agents start and follow other chats.

import * as worktrees from "../worktrees.ts";
import type { ToolContext } from "./context.ts";
import { postNote } from "../notes.ts";
import type { HarnessTool, Thread } from "../types.ts";

/** Threads as tools (T3: t3_thread_launch/list/read/send/wait): agents can start and follow other threads. */
export function threadTools(ctx: ToolContext, threadId: string): HarnessTool[] {
  const find = (ref: string | undefined) => {
    const r = (ref ?? "").trim();
    const all = ctx.store.listThreads();
    return all.find((t) => t.id === r) ?? all.find((t) => t.id.startsWith(r) && r.length >= 6);
  };
  const line = (t: Thread) =>
    `${t.id.slice(0, 8)}  ${t.status === "running" ? "working" : "idle"}  "${t.title}"  ${t.worktree ? `branch ${t.worktree.branch}` : t.cwd}`;
  const lastAnswer = (t: Thread) => {
    const items = ctx.store.listTurnItems(t.id, 60);
    const a = items.filter((i) => i.kind === "assistant_message" && !i.streaming).at(-1);
    return a?.kind === "assistant_message" ? a.text : "";
  };
  return [
    {
      name: "list_threads",
      description: "List recent project threads (id, status, title, folder or branch). Use the id with read_thread, message_thread and wait_for_thread.",
      params: { project: { description: "Only threads in this project folder (absolute path). Default: the project you're working in.", optional: true } },
      run: async ({ project }) => {
        const dir = project?.trim() || ctx.projectOf(threadId);
        const main = dir ? worktrees.mainCheckoutOf(dir) ?? dir : undefined;
        const list = ctx.store
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
        return { text: `${line(t)}\n\n${ctx.transcript(t.id) || "(empty)"}` };
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
        const caller = ctx.requireThread(threadId);
        const project = a.project?.trim() || ctx.projectOf(threadId);
        if (!project) return { isError: true, text: "Say which project folder (project)." };
        const root = worktrees.mainCheckoutOf(project) ?? project;
        if (!a.prompt?.trim()) return { isError: true, text: "Pass the prompt." };
        const live = ctx.store.listThreads().filter((t) => t.startedBy && t.status === "running").length;
        if (live >= 4) return { isError: true, text: "Four agent-started threads are already working; wait for one to finish first." };
        if (caller.startedBy && ctx.store.getThread(caller.startedBy.threadId)?.startedBy) {
          return { isError: true, text: "Threads started by agents can't keep starting more beyond two levels." };
        }
        try {
          const created = await ctx.startAgentThread(threadId, caller, root, a);
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
          await ctx.dispatch({ type: "message.send", threadId: t.id, text: message });
          return { text: `Sent. ${line(ctx.requireThread(t.id))}` };
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
        const idle = ctx.waitFor(t.id, () => ctx.store.getThread(t.id)?.status !== "running");
        const timedOut = await Promise.race([idle.then(() => false), new Promise<boolean>((r) => setTimeout(() => r(true), ms))]);
        const now = ctx.requireThread(t.id);
        if (timedOut) return { text: `Still working after ${ms / 60_000} minutes. ${line(now)}` };
        const run = ctx.store.listRuns(t.id).at(-1);
        return { text: `${line(now)}\nLast turn: ${run?.status ?? "?"}\n\n${lastAnswer(now) || "(no answer)"}` };
      },
    },
    {
      name: "propose_pull_request",
      description:
        "When this thread's work (on its own branch) is ready: propose a pull request. The person sees a button to push the branch and open it; you can't push yourself.",
      params: { title: { description: "PR title." }, body: { description: "PR description: what changed, why, how to verify." } },
      run: async ({ title, body }) => {
        const t = ctx.requireThread(threadId);
        if (!t.worktree) return { isError: true, text: "This thread works in the project folder, not on its own branch; there's nothing to open a pull request from." };
        if (!title?.trim()) return { isError: true, text: "Pass a title." };
        postNote(ctx.store, threadId, `Proposed a pull request: **${title.trim()}**`, { action: { kind: "open_pr", title: title.trim(), body: body?.trim() ?? "" } });
        return { text: "Proposed. The person will open it with one click; tell them briefly." };
      },
    },
  ];
}
