// Test of the `bullpen` command on a throwaway instance (no agents): start, status, stopping and restarting a server
// that was started by hand (no pid file), and stop. Runs on macOS, Linux and Windows.
//   node scripts/cli-test.ts
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const HOME = mkdtempSync(join(tmpdir(), "bullpen-cli-home-"));
const PORT = 4800 + Math.floor(Math.random() * 50);
const env = { ...process.env, BULLPEN_HOME: HOME, BULLPEN_PORT: String(PORT) };
const cli = (...args: string[]) => {
  try {
    return execFileSync(process.execPath, ["src/cli.ts", ...args], { env, encoding: "utf8", timeout: 60_000 }).trim();
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string };
    return `FAILED: ${err.stdout ?? ""}${err.stderr ?? ""}`.trim();
  }
};
const up = async () => {
  try {
    return (await fetch(`http://127.0.0.1:${PORT}/`, { signal: AbortSignal.timeout(1500) })).ok;
  } catch {
    return false;
  }
};
const until = async (want: boolean, ms = 15_000) => {
  for (const end = Date.now() + ms; Date.now() < end; await new Promise((r) => setTimeout(r, 250))) if ((await up()) === want) return true;
  return false;
};
let pass = 0, fail = 0;
const check = (cond: unknown, label: string, info = "") => { cond ? pass++ : fail++; console.log(`${cond ? "✓" : "✗"} ${label}${info ? `  (${info})` : ""}`); };
const pidIn = (status: string) => Number(status.match(/pid (\d+)/)?.[1]);

try {
  check(/^Bullpen v?\d+\.\d+\.\d+/.test(cli("version")), "version prints", cli("version").split("\n")[0]);
  check(cli("status").startsWith("Not running."), "status: not running at first");

  let out = cli("start");
  check(out.startsWith("Started on") && (await up()), "start brings the server up", out);
  check(existsSync(join(HOME, "server.pid")), "start writes a pid file");
  const first = pidIn(cli("status"));
  check(first > 0, "status shows its pid", String(first));

  out = cli("stop");
  check(out === "Stopped." && !(await up()), "stop brings it down", out);

  // A server someone started by hand: no pid file, so the command has to find the process itself.
  const manual = spawn(process.execPath, ["src/server.ts"], { env, stdio: "ignore" });
  check(await until(true), "a hand-started server comes up");
  check(!existsSync(join(HOME, "server.pid")), "it has no pid file");
  check(pidIn(cli("status")) === manual.pid, "status finds the hand-started server's pid", `${pidIn(cli("status"))} vs ${manual.pid}`);

  out = cli("restart");
  const second = pidIn(cli("status"));
  check(out.endsWith("Restarted.") && (await up()) && second > 0 && second !== manual.pid, "restart replaces a hand-started server", `${manual.pid} → ${second}`);

  out = cli("stop");
  check(out === "Stopped." && (await until(false, 3000)), "stop after restart", out);
  check(cli("status").startsWith("Not running."), "status: not running at the end");
} finally {
  cli("stop");
  await new Promise((r) => setTimeout(r, 300));
  rmSync(HOME, { recursive: true, force: true, maxRetries: 5 });
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
