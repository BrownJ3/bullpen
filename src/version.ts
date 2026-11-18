// Which version is running, and whether a newer release exists (release = a git tag like v0.3.0 on origin).

import { execFile, execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const exec = promisify(execFile);
export const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const CHECK_EVERY_MS = 6 * 3600_000;

export function currentVersion(): { version: string; describe: string; branch?: string } {
  const version = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).version as string;
  const git = (args: string[]) => {
    try {
      return execFileSync("git", ["-C", ROOT, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    } catch {
      return "";
    }
  };
  return { version, describe: git(["describe", "--tags", "--always"]) || version, branch: git(["symbolic-ref", "--quiet", "--short", "HEAD"]) || undefined };
}

/** "v1.2.10" > "v1.2.9". */
export function compareVersions(a: string, b: string): number {
  const pa = a.replace(/^v/, "").split(/[.-]/).map((x) => Number.parseInt(x, 10) || 0);
  const pb = b.replace(/^v/, "").split(/[.-]/).map((x) => Number.parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) - (pb[i] ?? 0);
  return 0;
}

let cache: { at: number; latest?: string } = { at: 0 };
/** Newest release tag on origin (checked at most every 6 hours; undefined if offline or none). */
export async function latestRelease(force = false): Promise<string | undefined> {
  if (!force && Date.now() - cache.at < CHECK_EVERY_MS) return cache.latest;
  try {
    const { stdout } = await exec("git", ["-C", ROOT, "ls-remote", "--tags", "--refs", "origin", "v*"], {
      timeout: 15_000,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    });
    const tags = stdout.split("\n").map((l) => l.split("refs/tags/")[1]).filter((t): t is string => Boolean(t && /^v\d/.test(t)));
    cache = { at: Date.now(), latest: tags.sort(compareVersions).at(-1) };
  } catch {
    cache = { at: Date.now(), latest: cache.latest };
  }
  return cache.latest;
}

export async function updateInfo() {
  const cur = currentVersion();
  const latest = await latestRelease();
  // A checkout on a branch (a developer's copy) follows that branch; only release installs get the notice.
  const onRelease = !cur.branch;
  return {
    current: cur.version,
    describe: cur.describe,
    branch: cur.branch,
    latest,
    updateAvailable: Boolean(onRelease && latest && compareVersions(latest, `v${cur.version}`) > 0),
  };
}
