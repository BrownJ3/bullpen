// Git worktrees (T3: thread launch modes root | worktree{baseRef, branch} + setup stage).
//
// Two uses:
//   - A thread can work on its own branch in its own folder, so it never touches your checkout until you merge it.
//   - Each team task works in a throwaway folder made from a snapshot of the goal's folder (uncommitted changes
//     included). When the lead accepts the task, its changes are three-way merged back into the goal's folder;
//     if they collide with work that landed meanwhile, the task goes back to its agent with the conflicts marked.

import { execFile, execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readdirSync, realpathSync, rmSync, symlinkSync, lstatSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { HOME } from "./home.ts";
import * as checkpoints from "./checkpoints.ts";

const exec = promisify(execFile);
const ROOT = join(HOME, "worktrees");
const IDENTITY = {
  GIT_AUTHOR_NAME: "bullpen",
  GIT_AUTHOR_EMAIL: "bullpen@localhost",
  GIT_COMMITTER_NAME: "bullpen",
  GIT_COMMITTER_EMAIL: "bullpen@localhost",
};

async function git(cwd: string, args: string[], opts: { env?: Record<string, string>; input?: string; allowFail?: boolean } = {}) {
  try {
    const child = exec("git", args, { cwd, env: { ...process.env, ...IDENTITY, ...opts.env }, maxBuffer: 64 * 1024 * 1024 });
    if (opts.input !== undefined) {
      child.child.stdin?.end(opts.input);
    }
    const { stdout } = await child;
    return { ok: true, out: stdout.trim(), code: 0 };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; code?: number; message: string };
    if (!opts.allowFail) throw new Error((e.stderr || e.message).trim());
    return { ok: false, out: (e.stdout ?? "").trim(), err: (e.stderr ?? e.message).trim(), code: e.code ?? 1 };
  }
}
const out = async (cwd: string, args: string[]) => (await git(cwd, args)).out;

export async function repoRoot(dir: string): Promise<string> {
  return out(dir, ["rev-parse", "--show-toplevel"]);
}

const rootCache = new Map<string, string | null>();
/**
 * The main checkout a folder belongs to: itself for a normal repo, the repo it was made from for a worktree.
 * Synchronous (cached) so permission lookups can use it.
 */
export function mainCheckoutOf(dir: string): string | undefined {
  if (rootCache.has(dir)) return rootCache.get(dir) ?? undefined;
  let found: string | null = null;
  try {
    const common = execFileSync("git", ["-C", dir, "rev-parse", "--path-format=absolute", "--git-common-dir"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    found = basename(common) === ".git" ? resolve(dirname(common)) : null; // resolve: git prints C:/… on Windows
  } catch {
    found = null;
  }
  rootCache.set(dir, found);
  return found ?? undefined;
}

function slug(text: string): string {
  return (
    text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40)
      .replace(/-+$/, "") || "work"
  );
}

function repoDir(root: string): string {
  const hash = createHash("sha1").update(root).digest("hex").slice(0, 6);
  return join(ROOT, `${basename(root)}-${hash}`);
}

/**
 * Make a new worktree usable right away: link node_modules (installing again in every worktree is slow) and copy
 * local env files, which git doesn't track. Then run the project's own setup command, if it has one.
 */
async function prepare(root: string, path: string, setup?: string): Promise<string | undefined> {
  for (const dir of ["node_modules", ".venv", "vendor"]) {
    const src = join(root, dir);
    const dest = join(path, dir);
    try {
      if (existsSync(src) && !existsSync(dest) && lstatSync(src).isDirectory()) {
        const tracked = (await git(root, ["ls-files", "--", dir], { allowFail: true })).out;
        if (!tracked) symlinkSync(src, dest, "dir");
      }
    } catch {
      // best effort
    }
  }
  try {
    for (const name of readdirSync(root)) {
      if (/^\.env(\..+)?$/.test(name) && !existsSync(join(path, name))) copyFileSync(join(root, name), join(path, name));
    }
  } catch {
    // best effort
  }
  if (!setup?.trim()) return undefined;
  try {
    await exec("/bin/sh", ["-c", setup], { cwd: path, timeout: 10 * 60_000, maxBuffer: 8 * 1024 * 1024 });
    return undefined;
  } catch (err) {
    const e = err as { stderr?: string; message: string };
    return `Setup command failed: ${(e.stderr || e.message).trim().slice(-600)}`;
  }
}

export interface ThreadWorktree {
  path: string;
  branch: string;
  /** Branch (or commit) it was made from, and merges back into. */
  base: string;
  /** The main checkout. */
  root: string;
  createdAt: string;
  setupError?: string;
  prUrl?: string;
}

/** A new branch in its own folder for a thread. */
export async function createThreadWorktree(dir: string, opts: { title?: string; base?: string; branch?: string; setup?: string }): Promise<ThreadWorktree> {
  const root = await repoRoot(dir);
  const head = (await git(root, ["symbolic-ref", "--quiet", "--short", "HEAD"], { allowFail: true })).out;
  const base = opts.base?.trim() || head || (await out(root, ["rev-parse", "HEAD"]));
  const suffix = randomBytes(2).toString("hex");
  const name = `${slug(opts.title ?? "thread")}-${suffix}`;
  const branch = opts.branch?.trim() || `bullpen/${name}`;
  mkdirSync(repoDir(root), { recursive: true });
  // Real path (macOS /tmp is /private/tmp): agents report real paths, and the UI shows them relative to this.
  const path = join(realpathSync(repoDir(root)), name);
  const exists = (await git(root, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], { allowFail: true })).ok;
  await git(root, exists ? ["worktree", "add", path, branch] : ["worktree", "add", "-b", branch, path, base]);
  const setupError = await prepare(root, path, opts.setup);
  return { path, branch, base, root, createdAt: new Date().toISOString(), setupError };
}

export interface WorktreeStatus {
  branch: string;
  base: string;
  /** Commits on the branch that the base doesn't have. */
  ahead: number;
  /** Commits on the base since the branch was made. */
  behind: number;
  /** Uncommitted files in the worktree. */
  dirty: string[];
  /** Files changed compared with the base (committed or not). */
  changed: number;
  /** Is the branch already fully merged into the base? */
  merged: boolean;
  exists: boolean;
}

export async function status(wt: ThreadWorktree): Promise<WorktreeStatus> {
  if (!existsSync(wt.path)) return { branch: wt.branch, base: wt.base, ahead: 0, behind: 0, dirty: [], changed: 0, merged: false, exists: false };
  const counts = (await git(wt.path, ["rev-list", "--left-right", "--count", `${wt.base}...HEAD`], { allowFail: true })).out.split(/\s+/);
  // Not trimmed: each porcelain line starts with a two-letter status that may begin with a space.
  const porcelain = (await exec("git", ["status", "--porcelain", "-uall"], { cwd: wt.path })).stdout;
  const dirty = porcelain.split("\n").filter(Boolean).map((l) => l.slice(3));
  const changed = (await git(wt.path, ["diff", "--name-only", wt.base], { allowFail: true })).out.split("\n").filter(Boolean);
  const untracked = dirty.filter((f) => !changed.includes(f));
  const ahead = Number(counts[1] ?? 0);
  return {
    branch: wt.branch,
    base: wt.base,
    behind: Number(counts[0] ?? 0),
    ahead,
    dirty,
    changed: changed.length + untracked.length,
    merged: ahead === 0 && dirty.length === 0,
    exists: true,
  };
}

/** Commit everything in the worktree on its branch. Returns false when there was nothing to commit. */
export async function commitAll(wt: ThreadWorktree, message: string): Promise<boolean> {
  await git(wt.path, ["add", "-A"]);
  const staged = await git(wt.path, ["diff", "--cached", "--quiet"], { allowFail: true });
  if (staged.ok) return false;
  await git(wt.path, ["commit", "-q", "-m", message]);
  return true;
}

export type MergeResult = { ok: true; how: "merged" | "fast-forward" | "nothing" } | { ok: false; error: string; conflicts?: string[] };

/**
 * Merge the thread's branch into its base. Commits the worktree's changes first. Your checkout is only touched when
 * the base is checked out there; git refuses rather than overwrite uncommitted changes of yours, and a conflicted
 * merge is aborted, leaving everything as it was.
 */
export async function mergeIntoBase(wt: ThreadWorktree, message: string): Promise<MergeResult> {
  await commitAll(wt, message);
  const ahead = Number((await out(wt.root, ["rev-list", "--count", `${wt.base}..${wt.branch}`])) || 0);
  if (!ahead) return { ok: true, how: "nothing" };
  const current = (await git(wt.root, ["symbolic-ref", "--quiet", "--short", "HEAD"], { allowFail: true })).out;
  if (current === wt.base) {
    const res = await git(wt.root, ["merge", "--no-ff", "--no-edit", "-m", message, wt.branch], { allowFail: true });
    if (res.ok) return { ok: true, how: "merged" };
    const conflicts = (await git(wt.root, ["diff", "--name-only", "--diff-filter=U"], { allowFail: true })).out.split("\n").filter(Boolean);
    if (conflicts.length) await git(wt.root, ["merge", "--abort"], { allowFail: true });
    return {
      ok: false,
      conflicts,
      error: conflicts.length
        ? `It conflicts with ${wt.base} in ${conflicts.join(", ")}. Bring ${wt.base} into the thread first and let the agent resolve it.`
        : `git refused: ${res.err?.split("\n").slice(0, 4).join(" ")}`,
    };
  }
  // The base isn't checked out in your folder: move it forward if that's a plain fast-forward.
  const ff = await git(wt.root, ["merge-base", "--is-ancestor", wt.base, wt.branch], { allowFail: true });
  if (ff.ok) {
    await git(wt.root, ["update-ref", `refs/heads/${wt.base}`, wt.branch]);
    return { ok: true, how: "fast-forward" };
  }
  return { ok: false, error: `${wt.base} has moved on and isn't checked out. Bring ${wt.base} into the thread first, then merge again.` };
}

/** Merge the latest base into the thread's branch. Conflicts are left in the worktree for the agent to resolve. */
export async function updateFromBase(wt: ThreadWorktree): Promise<{ ok: boolean; conflicts: string[]; error?: string }> {
  await commitAll(wt, "Work in progress");
  const res = await git(wt.path, ["merge", "--no-edit", wt.base], { allowFail: true });
  if (res.ok) return { ok: true, conflicts: [] };
  const conflicts = (await git(wt.path, ["diff", "--name-only", "--diff-filter=U"], { allowFail: true })).out.split("\n").filter(Boolean);
  return { ok: false, conflicts, error: conflicts.length ? undefined : res.err };
}

export async function removeThreadWorktree(wt: ThreadWorktree, deleteBranch: boolean): Promise<void> {
  if (existsSync(wt.path)) await git(wt.root, ["worktree", "remove", "--force", wt.path], { allowFail: true });
  if (existsSync(wt.path)) rmSync(resolve(wt.path), { recursive: true, force: true });
  await git(wt.root, ["worktree", "prune"], { allowFail: true });
  if (deleteBranch) await git(wt.root, ["branch", "-D", wt.branch], { allowFail: true });
}

/** Push the branch and open a pull request with gh. */
export async function openPullRequest(wt: ThreadWorktree, title: string, body: string): Promise<{ url: string }> {
  await commitAll(wt, title);
  const remote = (await git(wt.path, ["remote"], { allowFail: true })).out.split("\n")[0];
  if (!remote) throw new Error("This repository has no remote to push to.");
  await git(wt.path, ["push", "-u", remote, wt.branch]);
  const base = wt.base.replace(/^origin\//, "");
  try {
    const { stdout } = await exec("gh", ["pr", "create", "--head", wt.branch, "--base", base, "--title", title, "--body", body], {
      cwd: wt.path,
      maxBuffer: 4 * 1024 * 1024,
    });
    return { url: stdout.trim().split("\n").at(-1) ?? "" };
  } catch (err) {
    const e = err as { stderr?: string; message: string };
    const existing = /already exists:?\s*(\S+)/.exec(e.stderr ?? "")?.[1];
    if (existing) return { url: existing };
    throw new Error((e.stderr || e.message).trim());
  }
}

/** The pull request for a branch, if one is open (gh). */
export async function pullRequestFor(wt: ThreadWorktree): Promise<{ url: string; state: string; number: number } | undefined> {
  try {
    const { stdout } = await exec("gh", ["pr", "view", wt.branch, "--json", "url,state,number"], { cwd: wt.path });
    return JSON.parse(stdout);
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------- team task workspaces

export interface TaskWorkspace {
  path: string;
  /** Snapshot commit of the goal's folder the task started from (or last merged with). */
  base: string;
}

function taskRef(taskId: string, what: string) {
  return `refs/bullpen/tasks/${taskId}/${what}`;
}

/** A detached worktree holding a snapshot of the goal's folder, uncommitted changes included. */
export async function createTaskWorkspace(goalDir: string, taskId: string, setup?: string): Promise<TaskWorkspace> {
  const root = await repoRoot(goalDir);
  const base = await checkpoints.capture(goalDir, taskRef(taskId, "base"), `task ${taskId} base`);
  mkdirSync(join(ROOT, "tasks"), { recursive: true });
  const path = join(realpathSync(join(ROOT, "tasks")), taskId);
  if (existsSync(path)) await removeTaskWorkspace(goalDir, { path, base });
  await git(root, ["worktree", "add", "--detach", path, base]);
  await prepare(mainCheckoutOf(root) ?? root, path, setup);
  return { path, base };
}

/** What the task changed, relative to its base: file list plus a clipped patch for the reviewer. */
export async function taskChanges(goalDir: string, ws: TaskWorkspace, taskId: string, maxPatch = 6000): Promise<{ files: string[]; patch: string; tree: string }> {
  const result = await checkpoints.capture(ws.path, taskRef(taskId, "result"), `task ${taskId} result`);
  const files = (await out(ws.path, ["diff", "--name-only", ws.base, result])).split("\n").filter(Boolean);
  let patch = files.length ? await out(ws.path, ["diff", "--stat", "--patch", ws.base, result]) : "";
  if (patch.length > maxPatch) patch = `${patch.slice(0, maxPatch)}\n…[diff truncated]`;
  return { files, patch, tree: result };
}

export type LandResult = { ok: true; files: string[] } | { ok: false; conflicts: string[]; error?: string };

/**
 * Bring a task's changes into the goal's folder: a three-way merge of (task base, goal folder now, task result).
 * Clean: the difference is applied to the goal folder's files (its index and branch are left alone).
 * Conflicted: nothing in the goal folder changes; the task's worktree is reset to the merged result with conflict
 * markers, and its base moves to the goal folder's current state, so the agent can resolve and resubmit.
 */
export async function landTask(goalDir: string, ws: TaskWorkspace, taskId: string): Promise<LandResult> {
  const root = await repoRoot(goalDir);
  const theirs = await checkpoints.capture(ws.path, taskRef(taskId, "result"), `task ${taskId} result`);
  const files = (await out(root, ["diff", "--name-only", ws.base, theirs])).split("\n").filter(Boolean);
  if (!files.length) return { ok: true, files: [] };
  for (let attempt = 0; attempt < 3; attempt++) {
    const ours = await checkpoints.capture(goalDir, taskRef(taskId, "target"), `task ${taskId} target`);
    const merge = await git(root, ["merge-tree", "--write-tree", "--name-only", "--no-messages", `--merge-base=${ws.base}`, ours, theirs], { allowFail: true });
    const lines = merge.out.split("\n").filter(Boolean);
    const tree = lines[0];
    if (!tree) return { ok: false, conflicts: [], error: merge.err ?? "git merge-tree failed" };
    if (!merge.ok) {
      const conflicts = lines.slice(1);
      // Put the conflicted result in the task's folder for its agent to resolve.
      await checkoutTree(ws.path, tree);
      ws.base = ours;
      return { ok: false, conflicts };
    }
    const patch = (await git(root, ["diff", "--binary", ours, tree])).out;
    if (!patch) return { ok: true, files };
    const applied = await git(root, ["apply", "--whitespace=nowarn", "-"], { input: `${patch}\n`, allowFail: true });
    if (applied.ok) return { ok: true, files };
    // Someone changed the goal folder between the snapshot and the apply: try again from the new state.
  }
  return { ok: false, conflicts: [], error: "The project kept changing while the task's work was being merged in." };
}

/** Make a folder's files match a tree exactly (through a temp index, like a checkpoint restore). */
async function checkoutTree(dir: string, tree: string) {
  const tmp = await mkdtemp(join(tmpdir(), "bullpen-index-"));
  try {
    const env = { GIT_INDEX_FILE: join(tmp, "index") };
    const tmpRef = `refs/bullpen/tmp/${randomBytes(4).toString("hex")}`;
    const current = await checkpoints.capture(dir, tmpRef, "before conflict checkout");
    await git(dir, ["update-ref", "-d", tmpRef], { allowFail: true });
    const added = (await out(dir, ["diff", "--name-only", "--diff-filter=A", tree, current])).split("\n").filter(Boolean);
    for (const f of added) rmSync(join(dir, f), { force: true });
    await git(dir, ["read-tree", tree], { env });
    await git(dir, ["checkout-index", "--all", "--force"], { env });
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

export async function removeTaskWorkspace(goalDir: string, ws: TaskWorkspace): Promise<void> {
  const root = (await git(goalDir, ["rev-parse", "--show-toplevel"], { allowFail: true })).out || goalDir;
  if (existsSync(ws.path)) await git(root, ["worktree", "remove", "--force", ws.path], { allowFail: true });
  if (existsSync(ws.path)) rmSync(ws.path, { recursive: true, force: true });
  await git(root, ["worktree", "prune"], { allowFail: true });
}

/** Snapshot refs pile up per task; drop them once the goal is over. */
export async function dropTaskRefs(goalDir: string, taskId: string): Promise<void> {
  for (const what of ["base", "result", "target"]) await git(goalDir, ["update-ref", "-d", taskRef(taskId, what)], { allowFail: true });
}
