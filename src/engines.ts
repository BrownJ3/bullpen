// Engines beyond the built-in Claude and Codex: agents that speak ACP. Known ones are offered when their command is
// installed; add others (or change arguments) in ~/.bullpen/engines.json:
//   [{ "id": "my-agent", "name": "My Agent", "command": "/path/to/agent", "args": ["--acp"] }]

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { HOME } from "./home.ts";
import type { AcpEngine } from "./providers/acp.ts";

const KNOWN: AcpEngine[] = [
  { id: "gemini", name: "Gemini CLI", command: "gemini", args: ["--experimental-acp"] },
  { id: "opencode", name: "OpenCode", command: "opencode", args: ["acp"] },
  { id: "goose", name: "Goose", command: "goose", args: ["acp"] },
  { id: "qwen", name: "Qwen Code", command: "qwen", args: ["--experimental-acp"] },
];
const RESERVED = new Set(["claude", "codex"]);

function onPath(command: string): string | undefined {
  if (command.includes("/")) return existsSync(command) ? command : undefined;
  const dirs = [...(process.env.PATH ?? "").split(":"), "/opt/homebrew/bin", "/usr/local/bin", join(process.env.HOME ?? "", ".local", "bin")];
  for (const dir of dirs) if (dir && existsSync(join(dir, command))) return join(dir, command);
  return undefined;
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
