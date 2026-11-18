// `bullpen` — run, stop and open the harness without thinking about folders or terminals.
//
//   bullpen            open the web UI (starts the server first if needed)
//   bullpen start      start the server in the background
//   bullpen stop       stop it
//   bullpen restart
//   bullpen status
//   bullpen logs       follow the server log
//   bullpen install    start at login, `bullpen` on your PATH, and a Bullpen app for Spotlight/Dock
//   bullpen uninstall  undo install (keeps your threads and agents)

import { execFileSync, spawn } from "node:child_process";
import { chmodSync, closeSync, copyFileSync, utimesSync, existsSync, mkdirSync, openSync, readFileSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync, lstatSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { HOME, ensureHome, loadOrCreateToken } from "./home.ts";
import { DEFAULT_PORT } from "./protocol.ts";

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

const serviceInstalled = () => process.platform === "darwin" && existsSync(PLIST);

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
    const out = execFileSync("lsof", ["-nP", `-iTCP:${PORT}`, "-sTCP:LISTEN", "-t"], { encoding: "utf8" }).trim();
    return out ? Number(out.split("\n")[0]) : undefined;
  } catch {
    return undefined;
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
    const child = spawn(NODE, [SERVER], { cwd: ROOT, detached: true, stdio: ["ignore", out, out], env: process.env });
    closeSync(out);
    writeFileSync(PID, String(child.pid));
    child.unref();
  }
  const ok = await waitFor(true);
  if (!ok) say(`The server didn't come up. Last lines of ${LOG}:\n${tail(15)}`);
  return ok;
}

async function stop(): Promise<boolean> {
  if (serviceInstalled()) launchctl("bootout", `gui/${UID}/${LABEL}`); // unload so it stays stopped until `start`
  const pid = pidFromFile() ?? pidOnPort();
  if (pid) {
    try {
      process.kill(pid, "SIGTERM");
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

function install() {
  if (process.platform !== "darwin") throw new Error("install is macOS-only; use `bullpen start` elsewhere.");
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
  mkdirSync(dirname(BIN_LINK), { recursive: true });
  try {
    if (lstatSync(BIN_LINK)) unlinkSync(BIN_LINK);
  } catch {}
  symlinkSync(join(ROOT, "bin", "bullpen"), BIN_LINK);

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
  launchctl("bootout", `gui/${UID}/${LABEL}`);
  for (const p of [PLIST, BIN_LINK]) {
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
    if (process.platform === "darwin") execFileSync("open", [url]);
    else say(url);
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
    await stop();
    if (await start()) say("Restarted.");
    else process.exit(1);
    break;
  case "status": {
    const up = await running();
    say(up ? `Running on http://127.0.0.1:${PORT} (pid ${pidOnPort() ?? "?"})` : "Not running.");
    say(serviceInstalled() ? "Starts at login: yes" : "Starts at login: no (run `bullpen install`)");
    say(`Data: ${HOME}`);
    say(`Log: ${LOG}`);
    break;
  }
  case "logs": {
    const t = spawn("tail", ["-n", "50", "-f", LOG], { stdio: "inherit" });
    t.on("exit", (code) => process.exit(code ?? 0));
    break;
  }
  case "install":
    if (!(await install())) say("Couldn't load the login service; see `bullpen status`.");
    if (await waitFor(true, 10_000)) {
      say("Installed:");
      say("  • the server starts at login and restarts if it crashes");
      say("  • `bullpen` works from any folder (open, start, stop, status, logs)");
      say(`  • the Bullpen app in ${APP.replace(homedir(), "~")}, with a shortcut on your Desktop: find it with Spotlight or drag it to the Dock`);
    } else {
      say(`Installed, but the server didn't start. Last lines of ${LOG}:\n${tail(15)}`);
      process.exit(1);
    }
    break;
  case "uninstall":
    uninstall();
    say("Removed the login service, the command and the app. Your threads and agents are kept in " + HOME);
    break;
  default:
    say("usage: bullpen [open|start|stop|restart|status|logs|install|uninstall]");
    process.exit(1);
}
