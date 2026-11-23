// Benchmark: does a lead with a team beat one agent on the same goal? Uses real agents, so it spends your plan.
//
//   node scripts/bench.ts <goal|all> [--mode solo|team|both] [--runs N] [--model M] [--provider P]
//                                    [--team lead,backend,tester] [--timeout MIN] [--keep]
//   node scripts/bench.ts report      the table from every run so far
//   node scripts/bench.ts goals       the goals, smallest first
//
// Each trial gets its own throwaway server, data folder and project. The project holds only a SPEC.md; the agent (or
// the lead and its team) is asked to build it. Afterwards a hidden check script scores the result. Recorded per trial:
// clock time, tokens and cost across every agent involved, the checks passed, and how many times anything asked for
// approval. Results append to bench-results/results.jsonl.
import { execFileSync, spawn, spawnSync, type ChildProcess } from "node:child_process";
import { appendFileSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { WebSocket } from "ws";
import { AGENT_TEMPLATES } from "../src/agent-templates.ts";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const BENCH = join(ROOT, "scripts", "bench");
const RESULTS = join(ROOT, "bench-results", "results.jsonl");

/** Smallest first. `shape` is why the goal is here: what it should tell us about when a team helps. */
const GOALS = [
  { id: "slug", size: "small", shape: "one function: a team can only add overhead" },
  { id: "todo", size: "medium", shape: "one file where each part builds on the last: hard to split" },
  { id: "textkit", size: "medium", shape: "four independent modules: splits cleanly" },
  { id: "notes", size: "large", shape: "one integrated server: parts must agree with each other" },
  { id: "toolbox", size: "large", shape: "eight independent modules plus docs: the best case for a team" },
] as const;
type GoalId = (typeof GOALS)[number]["id"];
type Mode = "solo" | "team";

interface Result {
  goal: GoalId;
  mode: Mode;
  model: string;
  provider: string;
  version: string;
  at: string;
  /** How the trial ended: finished on its own, or hit the time limit. */
  ended: "finished" | "timeout";
  seconds: number;
  tokens: number;
  costUsd: number;
  /** Agent turns across every agent involved. */
  turns: number;
  /** Team tasks the lead created (0 when solo, or when the lead did it itself). */
  tasks: number;
  approvals: number;
  passed: number;
  total: number;
  failed: string[];
}

const argv = process.argv.slice(2);
const flag = (name: string, fallback?: string) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : fallback;
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : 0;
};

// ---------------------------------------------------------------- one trial

async function trial(goal: GoalId, mode: Mode, opts: { model?: string; provider: string; team: string[]; timeoutMin: number; keep: boolean }): Promise<Result> {
  const home = mkdtempSync(join(tmpdir(), "bullpen-bench-home-"));
  const repo = realpathSync.native(mkdtempSync(join(tmpdir(), `bullpen-bench-${goal}-`)));
  const port = 4850 + Math.floor(Math.random() * 100);
  const git = (...a: string[]) => execFileSync("git", ["-C", repo, ...a], { encoding: "utf8" }).trim();
  git("init", "-q", "-b", "main");
  git("config", "user.email", "bench@example.com");
  git("config", "user.name", "Bench");
  git("config", "core.autocrlf", "false");
  copyFileSync(join(BENCH, "specs", `${goal}.md`), join(repo, "SPEC.md"));
  writeFileSync(join(repo, "package.json"), `${JSON.stringify({ name: goal, version: "1.0.0", private: true, type: "module" }, null, 2)}\n`);
  writeFileSync(join(repo, ".gitignore"), "node_modules/\ntodos.json\n");
  git("add", "-A");
  git("commit", "-q", "-m", "spec");

  let server: ChildProcess | undefined;
  let ws: WebSocket | undefined;
  const started = Date.now();
  let ended: Result["ended"] = "timeout";
  let approvals = 0;
  let seconds = 0;
  try {
    server = spawn(process.execPath, ["src/server.ts"], { cwd: ROOT, env: { ...process.env, BULLPEN_HOME: home, BULLPEN_PORT: String(port) }, stdio: ["ignore", "pipe", "pipe"] });
    await new Promise<void>((resolve, reject) => {
      server!.stdout!.on("data", (d) => String(d).includes("listening") && resolve());
      server!.on("exit", (c) => reject(new Error(`the server exited (${c})`)));
      setTimeout(() => reject(new Error("the server didn't start")), 20_000);
    });
    const token = readFileSync(join(home, "token"), "utf8").trim();
    ws = new WebSocket(`ws://127.0.0.1:${port}`, { headers: { authorization: `Bearer ${token}` } });
    let id = 1;
    const waiters = new Map<number, (r: { result?: unknown; error?: string }) => void>();
    type Ev = { type: string; item?: any; project?: any };
    const listeners = new Set<(e: Ev) => void>();
    ws.on("message", (raw) => {
      const msg = JSON.parse(String(raw));
      if ("subscription" in msg) for (const e of msg.items ?? []) for (const l of listeners) l(e.event);
      else waiters.get(msg.id)?.(msg);
    });
    const call = async <T>(method: string, params?: unknown): Promise<T> => {
      const myId = id++;
      ws!.send(JSON.stringify({ id: myId, method, params }));
      const res = await new Promise<{ result?: unknown; error?: string }>((r) => waiters.set(myId, r));
      if (res.error) throw new Error(res.error);
      return res.result as T;
    };
    await new Promise((r) => ws!.once("open", r));

    // Anything that asks is approved and counted: prompts are a cost to the person, even when the answer is yes.
    const seen = new Set<string>();
    let card: { status: string; tasks: unknown[] } | undefined;
    let projectId: string | undefined;
    listeners.add((e) => {
      if (e.type === "project.upserted") projectId = e.project.id;
      if (e.type !== "turn-item.upserted") return;
      const item = e.item;
      if (item.kind === "team_goal") card = item;
      if (item.kind === "approval_request" && item.status === "pending" && !seen.has(item.requestId)) {
        seen.add(item.requestId);
        approvals++;
        void call("dispatch", { type: "runtime-request.respond", threadId: item.threadId, requestId: item.requestId, decision: "accept" }).catch(() => {});
      }
    });
    await call("subscribeSidebar");

    const mode_ = "auto-accept-edits"; // "Build automatically", for both sides
    if (mode === "team") {
      for (const tid of opts.team) {
        const t = AGENT_TEMPLATES.find((x) => x.id === tid);
        if (!t) throw new Error(`no agent template "${tid}"`);
        await call("dispatch", { type: "agent.create", name: t.name, handle: t.handle, templateId: t.id, description: t.description, instructions: t.instructions, provider: opts.provider, model: opts.model, runtimeMode: mode_ });
      }
    }
    const { threadId } = await call<{ threadId: string }>("dispatch", { type: "thread.create", cwd: repo, provider: opts.provider, model: opts.model, runtimeMode: mode_ });
    await call("subscribeThread", { threadId });
    for (let i = 0; i < 40 && !projectId; i++) await sleep(250);
    if (projectId) await call("dispatch", { type: "project.update", projectId, runtimeMode: mode_ });

    const ask = "Build what SPEC.md in this project describes, exactly as written. Use only Node.js built-ins. Check that it works by running it. You're finished when everything in the spec works.";
    const t0 = Date.now();
    await call("dispatch", { type: "message.send", threadId, text: mode === "team" ? `@lead ${ask}` : ask });

    // Finished = nothing is running anywhere and no team is open, and it has stayed that way for 15 seconds.
    type Thread = { id: string; status: string; runCount: number; team?: { active: number } };
    const deadline = t0 + opts.timeoutMin * 60_000;
    let quietSince = 0;
    let lastLine = "";
    while (Date.now() < deadline) {
      await sleep(3000);
      const threads = await call<Thread[]>("listThreads");
      const running = threads.filter((t) => t.status === "running").length;
      const ran = threads.some((t) => t.runCount > 0);
      const teamOpen = Boolean(card && !["done", "failed", "cancelled", "stuck"].includes(card.status)) || threads.some((t) => (t.team?.active ?? 0) > 0);
      const line = `${running} running${card ? `, team ${card.status} (${card.tasks.length} tasks)` : ""}`;
      if (line !== lastLine) console.log(`      ${Math.round((Date.now() - t0) / 1000)}s  ${line}`);
      lastLine = line;
      if (ran && !running && !teamOpen) {
        quietSince ||= Date.now();
        if (Date.now() - quietSince >= 15_000) {
          ended = "finished";
          seconds = Math.round((quietSince - t0) / 1000);
          break;
        }
      } else quietSince = 0;
    }
    if (ended === "timeout") seconds = Math.round((Date.now() - t0) / 1000);
  } finally {
    ws?.close();
    server?.kill("SIGTERM");
    await sleep(800);
  }

  // Usage: every turn in this throwaway instance belongs to this trial.
  let tokens = 0, costUsd = 0, turns = 0, tasks = 0;
  try {
    const db = new DatabaseSync(join(home, "state.sqlite"), { readOnly: true });
    const r = db.prepare("SELECT count(*) AS n, coalesce(sum(json_extract(payload_json, '$.tokens')), 0) AS tokens, coalesce(sum(json_extract(payload_json, '$.costUsd')), 0) AS cost FROM runs").get() as { n: number; tokens: number; cost: number };
    tokens = r.tokens;
    costUsd = Math.round(r.cost * 100) / 100;
    turns = r.n;
    tasks = (db.prepare("SELECT count(*) AS n FROM tasks").get() as { n: number }).n;
    db.close();
  } catch (e) {
    console.log(`      couldn't read usage: ${(e as Error).message}`);
  }

  const out = spawnSync(process.execPath, [join(BENCH, "checks", `${goal}.mjs`), repo], { encoding: "utf8", timeout: 240_000 });
  const line = out.stdout.split("\n").find((l) => l.startsWith("RESULT "));
  const score = line ? (JSON.parse(line.slice(7)) as { total: number; passed: number; failed: string[] }) : { total: 1, passed: 0, failed: [`the checks didn't run: ${(out.stderr || "no output").split("\n")[0]}`] };

  if (opts.keep) console.log(`      kept: ${repo}\n            ${home}`);
  else for (const d of [repo, home]) rmSync(d, { recursive: true, force: true, maxRetries: 5 });
  void started;
  const version = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).version as string;
  return { goal, mode, model: opts.model ?? "default", provider: opts.provider, version, at: new Date().toISOString(), ended, seconds, tokens, costUsd, turns, tasks, approvals, ...score };
}

// ---------------------------------------------------------------- report

function load(): Result[] {
  if (!existsSync(RESULTS)) return [];
  return readFileSync(RESULTS, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Result);
}
const mins = (s: number) => (s >= 60 ? `${Math.floor(s / 60)}m ${String(Math.round(s % 60)).padStart(2, "0")}s` : `${Math.round(s)}s`);
const ktok = (n: number) => (n >= 1000 ? `${Math.round(n / 1000)}k` : String(Math.round(n)));

function report() {
  const all = load();
  if (!all.length) return console.log("No results yet. Run: node scripts/bench.ts slug");
  const pad = (s: string, n: number) => s.padEnd(n);
  console.log(`${pad("goal", 9)}${pad("mode", 6)}${pad("runs", 5)}${pad("time", 10)}${pad("tokens", 8)}${pad("cost", 8)}${pad("checks", 9)}${pad("tasks", 6)}${pad("asked", 6)}`);
  const verdicts: string[] = [];
  for (const g of GOALS) {
    const by: Partial<Record<Mode, { s: number; t: number; p: number }>> = {};
    for (const mode of ["solo", "team"] as const) {
      const rs = all.filter((r) => r.goal === g.id && r.mode === mode);
      if (!rs.length) continue;
      const s = median(rs.map((r) => r.seconds)), t = median(rs.map((r) => r.tokens));
      const p = rs.reduce((a, r) => a + r.passed / r.total, 0) / rs.length;
      by[mode] = { s, t, p };
      const timeouts = rs.filter((r) => r.ended === "timeout").length;
      console.log(
        `${pad(g.id, 9)}${pad(mode, 6)}${pad(String(rs.length), 5)}${pad(mins(s), 10)}${pad(ktok(t), 8)}${pad(`$${median(rs.map((r) => r.costUsd)).toFixed(2)}`, 8)}` +
          `${pad(`${Math.round(p * 100)}%`, 9)}${pad(String(median(rs.map((r) => r.tasks))), 6)}${pad(String(median(rs.map((r) => r.approvals))), 6)}${timeouts ? `${timeouts} timed out` : ""}`,
      );
    }
    if (by.solo && by.team) {
      const time = by.team.s / by.solo.s, tok = by.team.t / Math.max(1, by.solo.t), q = Math.round((by.team.p - by.solo.p) * 100);
      verdicts.push(`${pad(g.id, 9)}team took ${time.toFixed(1)}× the time and ${tok.toFixed(1)}× the tokens; checks ${q === 0 ? "the same" : `${q > 0 ? "+" : ""}${q} points`}  (${g.size}; ${g.shape})`);
    }
  }
  if (verdicts.length) console.log(`\nTeam compared with solo (medians):\n${verdicts.join("\n")}`);
  console.log("\nTime and tokens are medians; checks is the average share passed. Fewer than 3 runs each is too few to trust.");
}

// ---------------------------------------------------------------- main

const what = argv[0];
if (!what || what === "help" || what === "--help") {
  console.log("usage: node scripts/bench.ts <goal|all|report|goals> [--mode solo|team|both] [--runs N] [--model M] [--provider P] [--team lead,backend,tester] [--timeout MIN] [--keep]");
} else if (what === "report") {
  report();
} else if (what === "goals") {
  for (const g of GOALS) console.log(`${g.id.padEnd(9)}${g.size.padEnd(8)}${g.shape}`);
} else {
  const goals = what === "all" ? GOALS.map((g) => g.id) : [what as GoalId];
  for (const g of goals) if (!GOALS.some((x) => x.id === g)) throw new Error(`no goal "${g}". Try: ${GOALS.map((x) => x.id).join(", ")}`);
  const modeArg = flag("mode", "both")!;
  const modes: Mode[] = modeArg === "both" ? ["solo", "team"] : [modeArg as Mode];
  const runs = Number(flag("runs", "1"));
  const opts = { model: flag("model"), provider: flag("provider", "claude")!, team: flag("team", "lead,backend,tester")!.split(","), timeoutMin: Number(flag("timeout", "30")), keep: argv.includes("--keep") };
  mkdirSync(dirname(RESULTS), { recursive: true });
  for (let n = 1; n <= runs; n++) {
    for (const goal of goals) {
      for (const mode of modes) {
        console.log(`\n${goal} · ${mode}${runs > 1 ? ` · run ${n} of ${runs}` : ""}`);
        try {
          const r = await trial(goal, mode, opts);
          appendFileSync(RESULTS, `${JSON.stringify(r)}\n`);
          console.log(`   ${r.ended === "timeout" ? "TIMED OUT after" : "finished in"} ${mins(r.seconds)}; ${ktok(r.tokens)} tokens ($${r.costUsd.toFixed(2)}); ${r.turns} turns, ${r.tasks} tasks; checks ${r.passed}/${r.total}; asked ${r.approvals} time(s)`);
          for (const f of r.failed.slice(0, 6)) console.log(`      ✗ ${f}`);
        } catch (e) {
          console.log(`   trial failed to run: ${(e as Error).message}`);
        }
      }
    }
  }
  console.log("");
  report();
}
