// Engines beyond the built-in Claude and Codex: agents that speak ACP. Known ones are offered when their command is
// installed; add others (or change arguments) in ~/.bullpen/engines.json:
//   [{ "id": "my-agent", "name": "My Agent", "command": "/path/to/agent", "args": ["--acp"] }]

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, isAbsolute, join } from "node:path";
import { HOME } from "./home.ts";
import type { AcpEngine } from "./providers/acp.ts";

const KNOWN: AcpEngine[] = [
  { id: "gemini", name: "Gemini CLI", command: "gemini", args: ["--experimental-acp"] },
  { id: "opencode", name: "OpenCode", command: "opencode", args: ["acp"] },
  { id: "goose", name: "Goose", command: "goose", args: ["acp"] },
  { id: "qwen", name: "Qwen Code", command: "qwen", args: ["--experimental-acp"] },
];
const RESERVED = new Set(["claude", "codex"]);

const WIN = process.platform === "win32";

/** The full path of a command, searching PATH (and on Windows, trying .exe, .cmd and so on). */
export function onPath(command: string): string | undefined {
  // On Windows a command is `name.exe`, or `name.cmd` for anything installed with npm.
  const exts = WIN ? ["", ...(process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").map((e) => e.toLowerCase())] : [""];
  const hit = (base: string) => exts.map((e) => base + e).find((f) => existsSync(f));
  if (isAbsolute(command) || command.includes("/") || (WIN && command.includes("\\"))) return hit(command);
  const extra = WIN ? [] : ["/opt/homebrew/bin", "/usr/local/bin"];
  const dirs = [...(process.env.PATH ?? "").split(delimiter), ...extra, join(homedir(), ".local", "bin")];
  for (const dir of dirs) {
    const found = dir && hit(join(dir, command));
    if (found) return found;
  }
  return undefined;
}

/** Spawn options for a command found with onPath: Windows can only start .cmd and .bat files through a shell. */
export function shellFor(command: string): { shell?: boolean; windowsHide: boolean } {
  return { shell: WIN && /\.(cmd|bat)$/i.test(command) ? true : undefined, windowsHide: true };
}

export function acpEngines(): AcpEngine[] {
  let custom: AcpEngine[] = [];
  try {
    const parsed = JSON.parse(readFileSync(join(HOME, "engines.json"), "utf8"));
    if (Array.isArray(parsed)) {
      custom = parsed
        .filter((e) => e && typeof e.id === "string" && typeof e.command === "string" && /^[a-z][a-z0-9-]{1,30}$/.test(e.id) && !RESERVED.has(e.id))
        .map((e) => ({ id: e.id, name: String(e.name ?? e.id), command: e.command, args: Array.isArray(e.args) ? e.args.map(String) : [], env: e.env }));
    }
  } catch {
    // no custom engines
  }
  const ids = new Set(custom.map((e) => e.id));
  const all = [...custom, ...KNOWN.filter((e) => !ids.has(e.id))];
  return all.flatMap((e) => {
    const bin = onPath(e.command);
    return bin ? [{ ...e, command: bin }] : [];
  });
}
