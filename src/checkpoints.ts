// Per-turn snapshots as hidden git refs (T3: CheckpointService + GitVcsDriver).
// Uses a temporary index file so the user's index, branch and HEAD are never touched.

import { execFile } from "node:child_process";
import { mkdtemp, rm, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);

const IDENTITY = {
  GIT_AUTHOR_NAME: "bullpen",
  GIT_AUTHOR_EMAIL: "bullpen@localhost",
  GIT_COMMITTER_NAME: "bullpen",
  GIT_COMMITTER_EMAIL: "bullpen@localhost",
};

async function git(cwd: string, args: string[], env: Record<string, string> = {}) {
  const { stdout } = await exec("git", args, {
    cwd,
    env: { ...process.env, ...IDENTITY, ...env },
    maxBuffer: 64 * 1024 * 1024,
  });
  return stdout.trim();
}

async function withTempIndex<T>(fn: (env: Record<string, string>) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "bullpen-index-"));
  try {
    return await fn({ GIT_INDEX_FILE: join(dir, "index") });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export function checkpointRef(threadId: string, ordinal: number): string {
  return `refs/bullpen/checkpoints/${threadId}/${ordinal}`;
}

export async function isGitRepo(cwd: string): Promise<boolean> {
  try {
    return (await git(cwd, ["rev-parse", "--is-inside-work-tree"])) === "true";
  } catch {
    return false;
  }
}

/** Snapshot the working tree (tracked + untracked, minus .gitignore'd) into `ref`. Returns the commit id. */
export async function capture(cwd: string, ref: string, message: string): Promise<string> {
  return withTempIndex(async (env) => {
    const root = await git(cwd, ["rev-parse", "--show-toplevel"]);
    await git(root, ["add", "-A", "--", "."], env);
    const tree = await git(root, ["write-tree"], env);
    const commit = await git(root, ["commit-tree", tree, "-m", message], env);
    await git(root, ["update-ref", ref, commit]);
    return commit;
  });
}

export async function changedFiles(cwd: string, fromRef: string, toRef: string): Promise<string[]> {
  const out = await git(cwd, ["diff", "--name-only", fromRef, toRef]);
  return out ? out.split("\n") : [];
}

export async function diff(cwd: string, fromRef: string, toRef: string): Promise<string> {
  return git(cwd, ["diff", "--stat", "--patch", fromRef, toRef]);
}

/**
 * Make the working tree match `ref` exactly: write its files, delete files added since.
 * Takes a safety snapshot first (returned) so the rollback itself can be undone.
 */
export async function restore(cwd: string, ref: string, safetyRef: string): Promise<string> {
  const root = await git(cwd, ["rev-parse", "--show-toplevel"]);
  const safety = await capture(root, safetyRef, "pre-rollback safety snapshot");

  // Files present now but not in the target snapshot -> remove them.
  const added = await git(root, ["diff", "--name-only", "--diff-filter=A", ref, safety]);
  for (const file of added ? added.split("\n") : []) {
    const abs = resolve(root, file);
    if (abs.startsWith(root + sep)) await unlink(abs).catch(() => {});
  }

  // Write every file from the snapshot through a temp index (user's index untouched).
  await withTempIndex(async (env) => {
    await git(root, ["read-tree", ref], env);
    await git(root, ["checkout-index", "--all", "--force"], env);
  });
  return safety;
}
