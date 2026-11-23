// `bullpen` — run, stop and open the harness without thinking about folders or terminals.
//
//   bullpen            open the web UI (starts the server first if needed)
//   bullpen start      start the server in the background
//   bullpen stop       stop it
//   bullpen restart
//   bullpen status
//   bullpen logs       follow the server log
//   bullpen update     get the newest release (or pull, on a branch checkout) and restart
//   bullpen version
//   bullpen remote     use it from your phone or another computer (on [--lan] | off | ssh | reset)
//   bullpen install    start at login, `bullpen` on your PATH, and a Bullpen app for Spotlight/Dock
//   bullpen uninstall  undo install (keeps your threads and agents)

import { execFileSync, spawn } from "node:child_process";
import { statSync, watchFile, readSync, chmodSync, closeSync, copyFileSync, utimesSync, existsSync, mkdirSync, openSync, readFileSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync, lstatSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
import { HOME, ensureHome, loadOrCreateToken } from "./home.ts";
import { DEFAULT_PORT } from "./protocol.ts";
import { compareVersions, currentVersion, latestRelease } from "./version.ts";
import { deviceToken, pairingUrl, qrTerminal, readRemote, resetDeviceToken, resolveHost, sshCommand, writeRemote } from "./remote.ts";

const PORT = Number(process.env.BULLPEN_PORT ?? DEFAULT_PORT);
const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const SERVER = join(ROOT, "src", "server.ts");
const LOG = join(HOME, "server.log");
const PID = join(HOME, "server.pid");
const LABEL = "dev.bullpen.server";
const PLIST = join(homedir(), "Library", "LaunchAgents", `${LABEL}.plist`);
const BIN_LINK = join(homedir(), ".local", "bin", "bullpen");
const APP = join(homedir(), "Applications", "Bullpen.app");
const ICON = join(ROOT, "assets", "Bullpen.icns");
const DESKTOP_LINK = join(homedir(), "Desktop", "Bullpen.app");
const UID = process.getuid?.() ?? 0;
const WIN = process.platform === "win32";
// Windows: a `bullpen.cmd` in ~/.bullpen/bin (added to your PATH), a hidden starter in the Startup folder, and a
// Start menu shortcut.
const WIN_BIN = join(HOME, "bin");
const WIN_STARTUP = join(process.env.APPDATA ?? join(homedir(), "AppData", "Roaming"), "Microsoft", "Windows", "Start Menu", "Programs", "Startup", "Bullpen.vbs");
const WIN_MENU = join(process.env.APPDATA ?? join(homedir(), "AppData", "Roaming"), "Microsoft", "Windows", "Start Menu", "Programs", "Bullpen.lnk");
const NODE = realpathSync(process.execPath); // not fnm's per-shell symlink, which disappears

const say = (s: string) => console.log(s);

async function running(): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${PORT}/`, { signal: AbortSignal.timeout(1500) });
    return res.ok;
  } catch {
    return false;
  }
}

async function waitFor(up: boolean, ms = 10_000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if ((await running()) === up) return true;
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

/** The login service is installed, and it's this instance's (not the main one, when BULLPEN_HOME/PORT point elsewhere). */
function serviceInstalled(): boolean {
  if (process.platform !== "darwin" || !existsSync(PLIST)) return false;
  const plist = readFileSync(PLIST, "utf8");
  const home = plist.match(/<key>BULLPEN_HOME<\/key><string>([^<]*)<\/string>/)?.[1] ?? join(homedir(), ".bullpen");
  const port = Number(plist.match(/<key>BULLPEN_PORT<\/key><string>(\d+)<\/string>/)?.[1] ?? DEFAULT_PORT);
  return home === xml(HOME) && port === PORT;
}

function launchctl(...args: string[]): boolean {
  try {
    execFileSync("launchctl", args, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function pidFromFile(): number | undefined {
  try {
    const pid = Number(readFileSync(PID, "utf8"));
    process.kill(pid, 0);
    return pid;
  } catch {
    return undefined;
  }
}

/** The process listening on our port, whoever started it. */
function pidOnPort(): number | undefined {
  try {
    if (WIN) {
      const out = execFileSync("netstat", ["-ano", "-p", "TCP"], { encoding: "utf8", windowsHide: true });
      const m = out.match(new RegExp(`:${PORT}\\s+(?:0\\.0\\.0\\.0|\\[::\\]):0\\s+\\S+\\s+(\\d+)`));
      return m ? Number(m[1]) : undefined;
    }
    const out = execFileSync("lsof", ["-nP", `-iTCP:${PORT}`, "-sTCP:LISTEN", "-t"], { encoding: "utf8" }).trim();
    return out ? Number(out.split("\n")[0]) : undefined;
  } catch {
    return undefined;
  }
}

/** The running server's process: from our pid file, the server itself, or whoever holds the port. */
async function serverPid(): Promise<number | undefined> {
  return pidFromFile() ?? (await ask("busy"))?.pid ?? pidOnPort();
}

/** Run npm with this Node (on Windows npm is a .cmd, which can't be started directly). */
function npm(args: string[], cwd: string) {
  const cli = join(dirname(NODE), "node_modules", "npm", "bin", "npm-cli.js");
  if (existsSync(cli)) return execFileSync(NODE, [cli, ...args], { cwd, stdio: "inherit" });
  const bin = join(dirname(NODE), "npm");
  return execFileSync(existsSync(bin) ? bin : "npm", args, { cwd, stdio: "inherit", shell: WIN });
}

/** Open a URL in the default browser. */
function openUrl(url: string): boolean {
  try {
    if (process.platform === "darwin") execFileSync("open", [url]);
    else if (WIN) spawn("explorer.exe", [url], { detached: true, stdio: "ignore" }).unref();
    else spawn("xdg-open", [url], { detached: true, stdio: "ignore" }).on("error", () => {}).unref();
    return true;
  } catch {
    return false;
  }
}

async function start(): Promise<boolean> {
  if (await running()) return true;
  ensureHome();
  if (serviceInstalled()) {
    // Load it if it isn't (e.g. after `stop`), then (re)start it.
    launchctl("bootstrap", `gui/${UID}`, PLIST);
    launchctl("kickstart", `gui/${UID}/${LABEL}`);
  } else {
    const out = openSync(LOG, "a");
    const child = spawn(NODE, [SERVER], { cwd: ROOT, detached: true, windowsHide: true, stdio: ["ignore", out, out], env: process.env });
    closeSync(out);
    writeFileSync(PID, String(child.pid));
    child.unref();
  }
  const ok = await waitFor(true);
  if (!ok) say(`The server didn't come up. Last lines of ${LOG}:\n${tail(15)}`);
  return ok;
}

/** Ask the running server something (busy / drain). Undefined if it isn't running or doesn't know the method. */
async function ask(method: string, params?: unknown): Promise<any> {
  if (!(await running())) return undefined;
  const { WebSocket } = await import("ws");
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}`, { headers: { authorization: `Bearer ${loadOrCreateToken()}` } });
    const timer = setTimeout(() => done(undefined), 5000);
    const done = (v: unknown) => {
      clearTimeout(timer); // or the command would sit for 5 seconds before exiting
      ws.close();
      resolve(v);
    };
    ws.on("open", () => ws.send(JSON.stringify({ id: 1, method, params })));
    ws.on("message", (raw) => {
      const msg = JSON.parse(String(raw));
      if (msg.id === 1) done(msg.error ? undefined : msg.result);
    });
    ws.on("error", () => done(undefined));
  });
}

/**
 * Before a restart: stop new turns from starting and wait for running ones to finish (up to 30 minutes), so agents
 * aren't cut off mid-step. `--now` skips the wait. Team tasks and @mentions waiting to start are picked up afterwards.
 */
async function drain(): Promise<void> {
  if (process.argv.includes("--now")) return;
  let state = await ask("drain", { on: true });
  if (!state && (await running())) state = runningFromDb(); // an older server without "drain": still wait for it
  if (!state?.running) return;
  say(`Waiting for ${state.running} running turn${state.running === 1 ? "" : "s"} to finish (${state.threads.join(", ")}). Nothing new starts meanwhile; Ctrl-C to cancel, --now to restart anyway.`);
  const deadline = Date.now() + 30 * 60_000;
  const cancel = () => void ask("drain", { on: false }).finally(() => process.exit(130));
  process.once("SIGINT", cancel);
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 3000));
    state = (await ask("busy")) ?? runningFromDb();
    if (!state?.running) break;
  }
  process.removeListener("SIGINT", cancel);
}

/** Turns running, straight from the database (read-only), for servers too old to answer "busy". */
function runningFromDb(): { running: number; threads: string[] } | undefined {
  try {
    const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");
    const db = new DatabaseSync(join(HOME, "state.sqlite"), { readOnly: true });
    const rows = db.prepare("SELECT json_extract(payload_json, '$.title') AS title FROM threads WHERE json_extract(payload_json, '$.status') = 'running'").all() as Array<{ title: string }>;
    db.close();
    return { running: rows.length, threads: rows.map((r) => r.title).slice(0, 8) };
  } catch {
    return undefined;
  }
}

async function stop(): Promise<boolean> {
  if (serviceInstalled()) launchctl("bootout", `gui/${UID}/${LABEL}`); // unload so it stays stopped until `start`
  const pid = await serverPid();
  if (pid) {
    try {
      process.kill(pid, "SIGTERM"); // on Windows this ends the process outright
    } catch {}
  }
  const ok = await waitFor(false);
  if (existsSync(PID)) unlinkSync(PID);
  return ok;
}

function uiUrl(): string {
  return `http://127.0.0.1:${PORT}/#token=${loadOrCreateToken()}`;
}

function tail(lines: number): string {
  try {
    return readFileSync(LOG, "utf8").trimEnd().split("\n").slice(-lines).join("\n");
  } catch {
    return "(no log yet)";
  }
}

// ---------- install ----------

function xml(s: string) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function linkCommand() {
  mkdirSync(dirname(BIN_LINK), { recursive: true });
  try {
    if (lstatSync(BIN_LINK)) unlinkSync(BIN_LINK);
  } catch {}
  symlinkSync(join(ROOT, "bin", "bullpen"), BIN_LINK);
}

/** Get the newest release (or the latest on this branch), reinstall dependencies if they changed, restart. */
async function update(): Promise<boolean> {
  // Never wait on a password prompt (it may run from the app with no terminal); the error says what to do instead.
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", ROOT, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } }).trim();
  try {
    git("rev-parse", "--git-dir");
  } catch {
    say("This copy of Bullpen isn't a git checkout, so it can't update itself. Reinstall with the install script.");
    return false;
  }
  if (git("status", "--porcelain", "--untracked-files=no")) {
    say(`${ROOT} has local changes; commit or stash them first (it's a development copy).`);
    return false;
  }
  const before = git("rev-parse", "HEAD");
  const lockBefore = git("rev-parse", "HEAD:package-lock.json");
  const cur = currentVersion();
  say("Checking for updates…");
  try {
    git("fetch", "--quiet", "--tags", "origin");
  } catch {
    say("Couldn't reach GitHub to check for updates. If the repository is private, make sure git can sign in (gh auth login, or an SSH key), then try again.");
    return false;
  }
  if (cur.branch) {
    git("merge", "--quiet", "--ff-only", `origin/${cur.branch}`);
  } else {
    const latest = await latestRelease(true);
    if (!latest || compareVersions(latest, `v${cur.version}`) <= 0) {
      say(`Up to date (${cur.describe}).`);
      return true;
    }
    git("checkout", "--quiet", latest);
  }
  const after = git("rev-parse", "HEAD");
  if (after === before) {
    say(`Up to date (${currentVersion().describe}).`);
    return true;
  }
  if (git("rev-parse", "HEAD:package-lock.json") !== lockBefore) {
    say("Installing updated dependencies…");
    npm(["ci", "--omit=dev", "--no-audit", "--no-fund", "--loglevel=error"], ROOT);
  }
  // Let running agents finish their step, then the new version's own install step and a restart onto the new code.
  await drain();
  execFileSync(NODE, [join(ROOT, "src", "cli.ts"), "_after-update"], { stdio: "inherit" });
  say(`Updated to ${currentVersion().describe}.`);
  return true;
}

/** PowerShell, for the few Windows settings Node can't reach (user PATH, shortcuts). */
function powershell(script: string): boolean {
  try {
    execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script], { stdio: "ignore", windowsHide: true });
    return true;
  } catch {
    return false;
  }
}
const psq = (s: string) => `'${s.replace(/'/g, "''")}'`;
const vbq = (s: string) => s.replace(/"/g, '""');

/** Windows: the `bullpen` command, start at login (hidden), and a Start menu shortcut. */
async function installWindows(): Promise<boolean> {
  ensureHome();
  const cli = join(ROOT, "src", "cli.ts");
  mkdirSync(WIN_BIN, { recursive: true });
  writeFileSync(join(WIN_BIN, "bullpen.cmd"), `@"${NODE}" "${cli}" %*\r\n`);
  powershell(
    `$p=[Environment]::GetEnvironmentVariable('Path','User'); $d=${psq(WIN_BIN)}; ` +
      `if (-not (($p -split ';') -contains $d)) { [Environment]::SetEnvironmentVariable('Path', (@($p,$d) -ne '' -join ';'), 'User') }`,
  );
  // A .vbs runs node without a console window.
  const hidden = (sub: string) => `CreateObject("WScript.Shell").Run """${vbq(NODE)}"" ""${vbq(cli)}"" ${sub}", 0, False\r\n`;
  mkdirSync(dirname(WIN_STARTUP), { recursive: true });
  writeFileSync(WIN_STARTUP, hidden("start"));
  const opener = join(HOME, "bin", "open-bullpen.vbs");
  writeFileSync(opener, hidden("open"));
  powershell(
    `$s=(New-Object -ComObject WScript.Shell).CreateShortcut(${psq(WIN_MENU)}); $s.TargetPath='wscript.exe'; ` +
      `$s.Arguments='"' + ${psq(opener)} + '"'; $s.WorkingDirectory=${psq(ROOT)}; $s.Description='Bullpen'; $s.Save()`,
  );
  // Swap a manually started server for one started the same way login will start it.
  if (await running()) await stop();
  return start();
}

function install() {
  if (WIN) return installWindows();
  if (process.platform !== "darwin") {
    // No launchd: just the command. Start it with `bullpen start` (or your own systemd unit).
    ensureHome();
    linkCommand();
    return Promise.resolve(true);
  }
  ensureHome();
  // The agents need `claude` and `codex` on PATH; launchd starts with almost none.
  const path = [dirname(NODE), join(homedir(), ".local", "bin"), "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"].join(":");
  mkdirSync(dirname(PLIST), { recursive: true });
  writeFileSync(
    PLIST,
    `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array><string>${xml(NODE)}</string><string>${xml(SERVER)}</string></array>
  <key>WorkingDirectory</key><string>${xml(ROOT)}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>${xml(path)}</string>
    <key>HOME</key><string>${xml(homedir())}</string>
    ${process.env.BULLPEN_HOME ? `<key>BULLPEN_HOME</key><string>${xml(HOME)}</string>` : ""}
    ${process.env.BULLPEN_PORT ? `<key>BULLPEN_PORT</key><string>${PORT}</string>` : ""}
  </dict>
  <key>RunAtLoad</key><true/>
  <!-- restart after a crash, but not after a clean stop -->
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>ThrottleInterval</key><integer>5</integer>
  <key>StandardOutPath</key><string>${xml(LOG)}</string>
  <key>StandardErrorPath</key><string>${xml(LOG)}</string>
</dict>
</plist>
`,
  );

  // `bullpen` on PATH (~/.local/bin is where the claude CLI lives too).
  linkCommand();

  // A tiny app so it opens from Spotlight, Launchpad or the Dock.
  rmSync(APP, { recursive: true, force: true });
  mkdirSync(join(APP, "Contents", "MacOS"), { recursive: true });
  writeFileSync(
    join(APP, "Contents", "Info.plist"),
    `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>Bullpen</string>
  <key>CFBundleIdentifier</key><string>dev.bullpen.launcher</string>
  <key>CFBundleExecutable</key><string>bullpen</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleVersion</key><string>1</string>
  <key>CFBundleIconFile</key><string>Bullpen</string>
  <key>LSUIElement</key><true/>
</dict>
</plist>
`,
  );
  const launcher = join(APP, "Contents", "MacOS", "bullpen");
  writeFileSync(launcher, `#!/bin/sh\nexec "${NODE}" "${join(ROOT, "src", "cli.ts")}" open\n`);
  chmodSync(launcher, 0o755);
  if (existsSync(ICON)) {
    mkdirSync(join(APP, "Contents", "Resources"), { recursive: true });
    copyFileSync(ICON, join(APP, "Contents", "Resources", "Bullpen.icns"));
  }
  // Tell Finder and the Dock to pick up the (new) icon.
  const now = new Date();
  utimesSync(APP, now, now);
  try {
    execFileSync("/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister", ["-f", APP], { stdio: "ignore" });
  } catch {}

  // A Desktop shortcut to the app.
  if (existsSync(dirname(DESKTOP_LINK))) {
    try {
      if (lstatSync(DESKTOP_LINK).isSymbolicLink()) unlinkSync(DESKTOP_LINK);
    } catch {}
    if (!existsSync(DESKTOP_LINK)) symlinkSync(APP, DESKTOP_LINK);
  }

  // Swap a manually started server for the service.
  const manual = pidFromFile() ?? pidOnPort();
  if (manual) {
    try {
      process.kill(manual, "SIGTERM");
    } catch {}
  }
  launchctl("bootout", `gui/${UID}/${LABEL}`);
  return waitFor(false, 5000).then(() => launchctl("bootstrap", `gui/${UID}`, PLIST));
}

function uninstall() {
  const mine = serviceInstalled();
  if (mine) launchctl("bootout", `gui/${UID}/${LABEL}`);
  // Windows is still reading bullpen.cmd if that's how this was run, so it's deleted a moment after we exit.
  const cmdFile = join(WIN_BIN, "bullpen.cmd");
  if (WIN && existsSync(cmdFile)) spawn("cmd.exe", ["/d", "/s", "/c", `ping -n 3 127.0.0.1 >nul & del "${cmdFile}"`], { detached: true, stdio: "ignore", windowsHide: true, windowsVerbatimArguments: true }).unref();
  for (const p of [...(mine ? [PLIST] : []), BIN_LINK, WIN_STARTUP, WIN_MENU, join(WIN_BIN, "open-bullpen.vbs")]) {
    try {
      unlinkSync(p);
    } catch {}
  }
  rmSync(APP, { recursive: true, force: true });
  try {
    if (lstatSync(DESKTOP_LINK).isSymbolicLink()) unlinkSync(DESKTOP_LINK);
  } catch {}
}

// ---------- main ----------

const cmd = process.argv[2] ?? "open";
switch (cmd) {
  case "open": {
    if (!(await start())) process.exit(1);
    const url = uiUrl();
    if (!openUrl(url)) say(url);
    break;
  }
  case "start":
    if (await running()) say(`Already running on http://127.0.0.1:${PORT}`);
    else if (await start()) say(`Started on http://127.0.0.1:${PORT}. Open it with: bullpen`);
    else process.exit(1);
    break;
  case "stop":
    if (!(await running()) && !pidFromFile()) say("Not running.");
    else if (await stop()) say("Stopped.");
    else (say("It didn't stop in time; check `bullpen status`."), process.exit(1));
    break;
  case "restart":
    await drain();
    await stop();
    if (await start()) say("Restarted.");
    else process.exit(1);
    break;
  case "status": {
    const up = await running();
    say(up ? `Running on http://127.0.0.1:${PORT} (pid ${(await serverPid()) ?? "?"})` : "Not running.");
    say(serviceInstalled() || (WIN && existsSync(WIN_STARTUP)) ? "Starts at login: yes" : "Starts at login: no (run `bullpen install`)");
    say(`Data: ${HOME}`);
    say(`Log: ${LOG}`);
    break;
  }
  case "logs": {
    // Print the last lines, then follow (no `tail` on Windows).
    say(tail(50));
    let size = existsSync(LOG) ? statSync(LOG).size : 0;
    watchFile(LOG, { interval: 500 }, (cur) => {
      if (cur.size < size) size = 0; // rotated or truncated
      if (cur.size === size) return;
      const fd = openSync(LOG, "r");
      const buf = Buffer.alloc(cur.size - size);
      readSync(fd, buf, 0, buf.length, size);
      closeSync(fd);
      process.stdout.write(buf);
      size = cur.size;
    });
    break;
  }
  case "install":
    if (!(await install())) say("Couldn't load the login service; see `bullpen status`.");
    if (await waitFor(true, 10_000)) {
      say("Installed:");
      if (WIN) {
        say("  • the server starts when you sign in to Windows");
        say("  • `bullpen` works from any folder in a new terminal (open, start, stop, status, logs, update)");
        say("  • Bullpen in the Start menu");
      } else {
        say("  • the server starts at login and restarts if it crashes");
        say("  • `bullpen` works from any folder (open, start, stop, status, logs)");
        say(`  • the Bullpen app in ${APP.replace(homedir(), "~")}, with a shortcut on your Desktop: find it with Spotlight or drag it to the Dock`);
      }
    } else {
      say(`Installed, but the server didn't start. Last lines of ${LOG}:\n${tail(15)}`);
      process.exit(1);
    }
    break;
  case "uninstall":
    uninstall();
    say("Removed the login service, the command and the app. Your threads and agents are kept in " + HOME);
    break;
  case "update":
    if (!(await update())) process.exit(1);
    break;
  case "_after-update": {
    // Run by `update` with the new code: refresh the service/app, then restart onto it.
    const wasRunning = await running();
    // Only touch the login service if it runs this copy (another checkout may own it).
    const mine = serviceInstalled() && readFileSync(PLIST, "utf8").includes(`<string>${xml(ROOT)}</string>`);
    if (mine) await install(); // rewrites the service and restarts it on the new code
    else if (WIN && existsSync(WIN_STARTUP)) {
      await installWindows(); // refreshes the command and shortcuts, and restarts onto the new code
      break;
    }
    else if (wasRunning) await stop();
    if (wasRunning || mine) await start();
    break;
  }
  case "version": {
    const v = currentVersion();
    say(`Bullpen ${v.describe}${v.branch ? ` (branch ${v.branch})` : ""}`);
    const latest = await latestRelease(true);
    if (!v.branch && latest && compareVersions(latest, `v${v.version}`) > 0) say(`${latest} is available: run \`bullpen update\`.`);
    break;
  }
  case "remote": {
    const sub = process.argv[3] ?? "status";
    const cfg = readRemote();
    const restartServer = async () => {
      if (await running()) {
        await stop();
        if (!(await start())) process.exit(1);
      }
    };
    if (sub === "on") {
      const via = process.argv.includes("--lan") ? "lan" : "tailscale";
      const where = resolveHost({ ...cfg, enabled: true, via });
      if (!where) {
        say(via === "lan"
          ? "No local-network address found. Connect to Wi-Fi or Ethernet first."
          : "Tailscale isn't running on this computer. Install it (tailscale.com) and sign in on this computer and your phone, then run this again.\n" +
            "Or: `bullpen remote on --lan` for your local network (plain HTTP; only on a network you trust),\n" +
            `or from another computer, forward the port over SSH: ${sshCommand(PORT)}`);
        process.exit(1);
      }
      if (via === "lan") say("Note: on your local network the connection isn't encrypted. Use it only on a network you trust; Tailscale is safer.");
      writeRemote({ enabled: true, via, host: where.host, names: where.names });
      deviceToken(true);
      await restartServer();
      say(`Remote access is on (${via === "lan" ? "local network" : "Tailscale"}).`);
    } else if (sub === "off") {
      writeRemote({ ...cfg, enabled: false });
      await restartServer();
      say("Remote access is off. Only this computer can connect.");
      break;
    } else if (sub === "reset") {
      resetDeviceToken();
      await restartServer();
      say("New device token: every other device has to scan the new code.");
    } else if (sub === "ssh") {
      const had = Boolean(deviceToken(false));
      const t = deviceToken(true)!;
      if (!had) await restartServer();
      say(`On the other computer, forward the port:\n\n  ${sshCommand(PORT)}\n\nthen open:\n\n  ${pairingUrl("127.0.0.1", PORT, t)}\n`);
      say("That link works as you while the tunnel is up. `bullpen remote reset` makes a new one.");
      break;
    } else if (sub !== "status") {
      say("usage: bullpen remote [on [--lan] | off | ssh | reset]");
      process.exit(1);
    }
    const now = readRemote();
    if (!now.enabled) {
      say("Remote access is off. Turn it on with `bullpen remote on` (Tailscale) or `bullpen remote on --lan`.");
      say("From another computer over SSH: `bullpen remote ssh` prints the tunnel command and the link.");
      break;
    }
    const where = resolveHost(now);
    const tokenNow = deviceToken(true)!;
    if (!where) {
      say(`Remote access is on, but no ${now.via === "lan" ? "local network" : "Tailscale"} address is available right now.`);
      break;
    }
    const url = pairingUrl(now.via === "tailscale" && where.names[0] ? where.names[0] : where.host, PORT, tokenNow);
    say(`Open this on your phone (scan the code), or on another device:\n\n  ${url}\n`);
    say(await qrTerminal(url));
    say("Anyone with this link can use Bullpen as you. `bullpen remote reset` makes a new one; `bullpen remote off` turns it off.");
    break;
  }
  default:
    say("usage: bullpen [open|start|stop|restart|status|logs|update|version|install|uninstall|remote]");
    process.exit(1);
}
