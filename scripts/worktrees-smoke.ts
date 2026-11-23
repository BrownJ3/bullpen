// Worktree test (no agents): thread branches, merging, and team-task workspaces landing cleanly and with conflicts.
//   node scripts/worktrees-smoke.ts
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.BULLPEN_HOME = mkdtempSync(join(tmpdir(), "bullpen-wt-home-"));
const wt = await import("../src/worktrees.ts");

const repo = mkdtempSync(join(tmpdir(), "bullpen-wt-repo-"));
const git = (...a: string[]) => execFileSync("git", ["-C", repo, ...a], { encoding: "utf8" }).trim();
git("init", "-q", "-b", "main");
git("config", "user.email", "t@t");
git("config", "user.name", "t");
git("config", "core.autocrlf", "false"); // Windows git defaults to CRLF checkouts; the checks compare exact text
writeFileSync(join(repo, "a.txt"), "one\ntwo\nthree\n");
writeFileSync(join(repo, "b.txt"), "bee\n");
git("add", "-A");
git("commit", "-q", "-m", "init");

let pass = 0, fail = 0;
const check = (name: string, ok: boolean, info = "") => { ok ? pass++ : fail++; console.log(`${ok ? "✓" : "✗"} ${name}${info ? `  (${info})` : ""}`); };

// --- thread worktree
const t = await wt.createThreadWorktree(repo, { title: "Add feature" });
check("thread worktree created", existsSync(join(t.path, "a.txt")) && t.base === "main", t.branch);
check("main checkout found from worktree", wt.mainCheckoutOf(t.path) === realpathSync.native(repo));
writeFileSync(join(t.path, "c.txt"), "new file\n");
let st = await wt.status(t);
check("status sees changes", st.changed === 1 && st.dirty.length === 1, JSON.stringify(st));
check("your checkout untouched", !existsSync(join(repo, "c.txt")));
const m = await wt.mergeIntoBase(t, "Add feature");
check("merge into main", m.ok && existsSync(join(repo, "c.txt")), JSON.stringify(m));
st = await wt.status(t);
check("merged status", st.ahead === 0 || st.merged, JSON.stringify(st));

// conflicting merge is refused and aborted
writeFileSync(join(t.path, "b.txt"), "bee from branch\n");
writeFileSync(join(repo, "b.txt"), "bee from main\n");
git("commit", "-q", "-am", "main edit");
const m2 = await wt.mergeIntoBase(t, "conflict");
check("conflicting merge refused", !m2.ok && (m2 as { conflicts?: string[] }).conflicts?.includes("b.txt") === true, JSON.stringify(m2));
check("main left clean after refusal", git("status", "--porcelain") === "", git("status", "--porcelain"));
const u = await wt.updateFromBase(t);
check("update from base leaves conflicts in worktree", !u.ok && u.conflicts.includes("b.txt") && readFileSync(join(t.path, "b.txt"), "utf8").includes("<<<<<<<"));
await wt.removeThreadWorktree(t, true);
check("worktree removed", !existsSync(t.path));

// --- task workspaces
writeFileSync(join(repo, "dirty.txt"), "uncommitted\n"); // goal folder has uncommitted work
const w1 = await wt.createTaskWorkspace(repo, "task-1");
const w2 = await wt.createTaskWorkspace(repo, "task-2");
check("task workspace has uncommitted files", existsSync(join(w1.path, "dirty.txt")));
writeFileSync(join(w1.path, "a.txt"), "ONE\ntwo\nthree\n");
writeFileSync(join(w2.path, "a.txt"), "one\ntwo\nTHREE\n"); // different hunk: merges cleanly
writeFileSync(join(w2.path, "new.txt"), "from task 2\n");
const ch = await wt.taskChanges(repo, w1, "task-1");
check("task changes listed", ch.files.join() === "a.txt" && ch.patch.includes("+ONE"));
const l1 = await wt.landTask(repo, w1, "task-1");
check("task 1 lands", l1.ok && readFileSync(join(repo, "a.txt"), "utf8").startsWith("ONE"), JSON.stringify(l1));
const l2 = await wt.landTask(repo, w2, "task-2");
check("task 2 lands on top (3-way)", l2.ok && readFileSync(join(repo, "a.txt"), "utf8") === "ONE\ntwo\nTHREE\n" && existsSync(join(repo, "new.txt")), JSON.stringify(l2));
check("goal folder index untouched", git("diff", "--cached", "--name-only") === "");

const w3 = await wt.createTaskWorkspace(repo, "task-3");
const w4 = await wt.createTaskWorkspace(repo, "task-4");
writeFileSync(join(w3.path, "b.txt"), "bee three\n");
writeFileSync(join(w4.path, "b.txt"), "bee four\n");
await wt.landTask(repo, w3, "task-3");
const l4 = await wt.landTask(repo, w4, "task-4");
check("conflict detected", !l4.ok && (l4 as { conflicts: string[] }).conflicts.includes("b.txt"), JSON.stringify(l4));
check("goal folder unchanged by conflict", readFileSync(join(repo, "b.txt"), "utf8") === "bee three\n");
check("markers in task folder", readFileSync(join(w4.path, "b.txt"), "utf8").includes("<<<<<<<"));
writeFileSync(join(w4.path, "b.txt"), "bee three and four\n");
const l4b = await wt.landTask(repo, w4, "task-4");
check("resolved task lands", l4b.ok && readFileSync(join(repo, "b.txt"), "utf8") === "bee three and four\n", JSON.stringify(l4b));
for (const [w, id] of [[w1, "task-1"], [w2, "task-2"], [w3, "task-3"], [w4, "task-4"]] as const) {
  await wt.removeTaskWorkspace(repo, w);
  await wt.dropTaskRefs(repo, id);
}
check("task workspaces removed", !existsSync(w1.path) && git("worktree", "list").split("\n").length === 1, git("worktree", "list"));

rmSync(repo, { recursive: true, force: true });
rmSync(process.env.BULLPEN_HOME!, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
