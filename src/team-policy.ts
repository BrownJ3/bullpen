// What a team task may do without asking (decision 3: "team mode"), also used when a project builds automatically.
// Edits inside the project are allowed by the adapters' accept-edits modes; this file decides which shell
// commands are safe enough to run unattended. Anything else still comes to the person as an approval.

/** Read-only inspection, tests, builds, linters and type checks. */
const SAFE: RegExp[] = [
  /^(ls|pwd|cat|head|tail|wc|file|stat|tree|du|which|echo|printf|date|env|printenv|basename|dirname|realpath|true|test|\[)(\s|$)/,
  /^(grep|rg|ag|find|fd|sort|uniq|cut|diff|cmp|jq|yq|od|xxd|hexdump|md5|shasum|sha256sum)(\s|$)/,
  /^git (-C ("[^"]*"|'[^']*'|\S+) )?(--no-pager )?(status|diff|log|show|branch|rev-parse|ls-files|blame|grep|remote -v|stash list|describe|shortlog)(\s|$)/,
  /^(npm|pnpm|yarn|bun) (test|t|run (test|tests|build|lint|typecheck|type-check|check|format:check)|ls|list|outdated|why)(\s|$)/,
  /^npx (--no-install )?(tsc|vitest|jest|eslint|prettier --check|playwright test|astro check|svelte-check|next lint)(\s|$)/,
  /^(tsc|vitest|jest|eslint|mypy|ruff check|black --check|flake8|pylint|pyright)(\s|$)/,
  /^(pytest|python3? -m (pytest|unittest|mypy|py_compile))(\s|$)/,
  /^(go (test|build|vet|list)|gofmt -l|cargo (test|build|check|clippy|fmt --check)|swift (build|test)|dotnet (build|test)|make (test|check|lint))(\s|$)/,
  /^(node|python3?|ruby|go|cargo|rustc|java) --?version$/,
  // Quick checks of the project's own code ("node -e 'require(\"./tip\")…'"): no riskier than running its tests,
  // and DANGEROUS above still refuses child processes, eval and file-moving words anywhere in the line.
  /^(node (-e|-p|--eval|--print|--test)|python3? -c)(\s|$)/,
  /^cd(\s|$)/,
];

import { execFileSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";

/** Never unattended, wherever they appear. (curl and kill have narrow local-testing exceptions, checked separately.) */
const DANGEROUS = /\b(rm|mv|cp|chmod|chown|sudo|wget|ssh|scp|rsync|pkill|killall|dd|mkfs|tee|truncate|xargs|eval|exec|source|open)\b|\bgit\b[^&;|]*\b(push|reset|checkout|clean|rebase|commit|merge|tag|restore|switch|rm|mv)\b|\b(npm|pnpm|yarn|bun)\s+(i|install|add|remove|uninstall|publish|link|exec|dlx|create)\b|\bnpx\b(?!\s+(--no-install\s+)?(tsc|vitest|jest|eslint|prettier --check|playwright test|astro check|svelte-check|next lint))/;

/**
 * Local testing, when Bullpen knows the folders the agent works in (`roots`: the project or its copy, and the
 * agent's own folder). An agent checking its work starts the project's own code (often in the background, with
 * PORT=…), pokes it with curl on localhost, and stops it again. All of that stays on this Mac and inside its folders.
 */
export interface LocalContext {
  roots: string[];
  /** The folder of a running process (to check a kill stays within the agent's folders). Injected for tests. */
  cwdOfPid?: (pid: number) => string | undefined;
  /** A small file's text (a pid file). Injected for tests. */
  readFile?: (path: string) => string | undefined;
}

const inside = (path: string, roots: string[]) => {
  const p = path.replace(/^\/private(?=\/(tmp|var)\/)/, "");
  return roots.some((r) => {
    const root = r.replace(/^\/private(?=\/(tmp|var)\/)/, "");
    return p === root || p.startsWith(root + "/");
  });
};
/** A path that's relative and stays put (no "..", no "~"), or absolute inside the roots. */
const localPath = (p: string, roots: string[]) => {
  const x = p.replace(/^["']|["']$/g, "");
  if (x === "/dev/null") return true;
  if (x.startsWith("/")) return inside(x, roots);
  return !x.startsWith("~") && !x.split("/").includes("..");
};

/** One segment of a command under the local-testing rules, or false. */
function localSegment(seg: string, ctx: LocalContext): boolean {
  // Leading env settings: PORT=3123 NODE_ENV=test node server.js
  let p = seg.replace(/^(\w+=("[^"]*"|'[^']*'|\S*)\s+)+/, "").trim();
  // Writing output into its own folders is like editing a file there.
  for (const m of p.matchAll(/(?:^|\s)\d?>>?\s*("[^"]*"|'[^']*'|[^\s;&|]+)/g)) if (!localPath(m[1], ctx.roots)) return false;
  p = p.replace(/(?:^|\s)\d?>>?\s*("[^"]*"|'[^']*'|[^\s;&|]+)/g, "").replace(/\s2>&1/g, "").trim();
  if (!p) return true;
  // The project's own code: node/python/bun/deno on a file of its own, or its package scripts.
  const run = p.match(/^(node|python3?|bun|deno run|tsx|ts-node)\s+(?:-{1,2}[\w-]+(?:=\S+)?\s+)*("[^"]*"|'[^']*'|[^\s-]\S*)/);
  if (run) return localPath(run[2], ctx.roots);
  if (/^(npm|pnpm|yarn|bun) (start|run [\w:.-]+|dev)(\s|$)/.test(p)) return true;
  // curl to this Mac only, saving nowhere outside its folders.
  if (/^curl\s/.test(p)) {
    const urls = [...p.matchAll(/(?:^|\s)(?:"|')?((?:https?:\/\/)?[^\s"']+)/g)].map((m) => m[1]).filter((u) => /^(https?:\/\/)?(localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0)(:\d+)?(\/|$|\?)/.test(u) || /^https?:\/\//.test(u));
    if (!urls.length || urls.some((u) => !/^(https?:\/\/)?(localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0)(:\d+)?(\/|$|\?)/.test(u))) return false;
    for (const m of p.matchAll(/(?:^|\s)(?:-o|--output)\s+(\S+)/g)) if (!localPath(m[1], ctx.roots)) return false;
    return !/(?:^|\s)(-K|--config|--upload-file|-T)\s/.test(p);
  }
  // Stopping what it started: $! / %1, or a process running from inside its folders.
  const kill = p.match(/^kill(?:\s+-(?:\w+))?\s+(.+)$/);
  if (kill) {
    return kill[1].trim().split(/\s+/).every((t) => {
      if (t === "$!" || /^%\d+$/.test(t)) return true;
      if (!/^\d+$/.test(t)) return false;
      const cwd = ctx.cwdOfPid?.(Number(t));
      return Boolean(cwd && inside(cwd, ctx.roots));
    });
  }
  if (/^sleep\s+\d+(\.\d+)?$/.test(p)) return Number(p.split(/\s+/)[1]) <= 120;
  if (/^(lsof|ps)(\s|$)/.test(p)) return true; // read-only: which processes and ports are in use
  return false;
}

/**
 * Simple shell variables ("S=/tmp/x; cat $S/log", "PID=4242; kill $PID"): put their values in, so the checks see
 * real paths and pids, and drop the bare assignments. Values with substitutions are left for the pid-file step.
 */
function expandVars(command: string): string {
  let c = command;
  for (let i = 0; i < 3; i++) {
    const vars = new Map<string, string>();
    for (const m of c.matchAll(/(?:^|[;&|]\s*)([A-Za-z_]\w*)=("[^"$`]*"|'[^']*'|[^\s;&|$`()]+)(?=\s*(?:;|&&|\|\||$))/g)) vars.set(m[1], m[2].replace(/^["']|["']$/g, ""));
    if (!vars.size) break;
    const before = c;
    for (const [k, v] of vars) c = c.replace(new RegExp(`\\$\\{?${k}\\}?(?![\\w])`, "g"), v);
    // A bare assignment on its own is now just bookkeeping.
    c = c.replace(/(^|[;&|]\s*)[A-Za-z_]\w*=("[^"$`]*"|'[^']*'|[^\s;&|$`()]+)\s*(;|&&)\s*/g, "$1");
    if (c === before) break;
  }
  return c;
}

/** "$(cat pid.txt)" inside a kill: replaced by the pid in that file when the file is in the agent's folders. */
function resolvePidFiles(command: string, ctx: LocalContext): string | null {
  let ok = true;
  const out = command.replace(/"?\$\(cat\s+("[^"]*"|'[^']*'|[^\s)]+)\)"?/g, (_, file: string) => {
    let f = file.replace(/^["']|["']$/g, "");
    // A relative pid file is in the folder it works in (the first root).
    if (!f.startsWith("/") && localPath(f, ctx.roots) && ctx.roots[0]) f = `${ctx.roots[0]}/${f}`;
    const text = f.startsWith("/") && inside(f, ctx.roots) ? ctx.readFile?.(f)?.trim() : undefined;
    if (!text || !/^\d+$/.test(text)) {
      ok = false;
      return "";
    }
    return text;
  });
  return ok ? out : null;
}

/** Split a command line on && || ; | outside quotes. Returns null for anything we won't reason about. */
function segments(command: string, allowBackground = false): string[] | null {
  const out: string[] = [];
  let cur = "";
  let quote: string | null = null;
  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (quote) {
      if (ch === quote) quote = null;
      cur += ch;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      cur += ch;
      continue;
    }
    if (ch === "`" || (ch === "$" && command[i + 1] === "(") || ch === "\n") return null; // substitution
    const two = command.slice(i, i + 2);
    if (two === "&&" || two === "||") {
      out.push(cur);
      cur = "";
      i++;
      continue;
    }
    if (ch === ";" || ch === "|") {
      out.push(cur);
      cur = "";
      continue;
    }
    if (ch === "&") {
      if (!allowBackground) return null; // backgrounding
      out.push(cur); // "server & next": the server runs in the background
      cur = "";
      continue;
    }
    cur += ch;
  }
  if (quote) return null;
  out.push(cur);
  return out.map((s) => s.trim()).filter(Boolean);
}

export function isSafeCommand(command: unknown, local?: LocalContext): boolean {
  if (typeof command !== "string") return false;
  if (local && localCommand(command, local)) return true;
  // Harmless redirections of output to nowhere.
  const c = command.replace(/\s*[12]?>\s*\/dev\/null/g, "").replace(/\s*2>&1/g, "").trim();
  if (!c || DANGEROUS.test(c)) return false;
  const parts = segments(c);
  if (!parts?.length) return false;
  return parts.every((raw) => {
    // Loops and tests around safe commands: "for f in a b; do cat $f; done", "if [ -e x ]; then ls; fi".
    if (/^(for \w+ in [^;]*|done|fi|else|then|esac)$/.test(raw)) return true;
    const p = raw.replace(/^(do|then|else|if|while|until|!)\s+/, "");
    // Reading a file in ("wc -c < a.txt") is fine; writing out, heredocs and process substitution are not.
    const bare = p.replace(/(^|\s)<\s*("[^"]*"|'[^']*'|[^\s<>()'"]+)/g, "$1").replace(/"[^"]*"|'[^']*'/g, "");
    if (/[<>]/.test(bare)) return false;
    return SAFE.some((re) => re.test(p));
  });
}

/** The same rules plus local testing (see LocalContext): every segment is either safe or local testing. */
function localCommand(command: string, ctx: LocalContext): boolean {
  let c = expandVars(command.trim());
  const resolved = resolvePidFiles(c, ctx);
  if (resolved === null) return false;
  c = expandVars(resolved);
  // A subshell around the whole thing, or around a background start: "(PORT=1 node s.js & echo $! > pid)".
  c = c.replace(/(^|[\s;&|])\(\s*([^()]*?)\s*\)/g, "$1$2");
  c = c.replace(/\s*\d?>&\d/g, ""); // "2>&1": not a background "&"
  if (/`|\$\(/.test(c)) return false;
  if (/\b(rm|mv|cp|chmod|chown|sudo|wget|ssh|scp|rsync|pkill|killall|dd|mkfs|truncate|xargs|eval|exec|source|open)\b/.test(c)) return false;
  if (/\bgit\b[^&;|]*\b(push|reset|checkout|clean|rebase|commit|merge|tag|restore|switch|rm|mv)\b|\b(npm|pnpm|yarn|bun)\s+(i|install|add|remove|uninstall|publish|link|exec|dlx|create)\b/.test(c)) return false;
  const parts = segments(c, true);
  if (!parts?.length) return false;
  return parts.every((raw) => {
    if (/^(for \w+ in [^;]*|done|fi|else|then|esac)$/.test(raw)) return true;
    const p = raw.replace(/^(do|then|else|if|while|until|!)\s+/, "");
    if (/^echo\s/.test(p) || /^printf\s/.test(p)) return localSegment(p.replace(/^(echo|printf)\s+("[^"]*"|'[^']*'|[^>]*?)(?=\s*\d?>|$)/, "").trim() || "", ctx) || !/>/.test(p);
    return isSafeCommand(p) || localSegment(p, ctx);
  });
}

/** Tools that write files; in team mode they're allowed when the target is inside the project. */
export const EDIT_TOOLS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);

/** Files a shell command writes with > or >> (for "files touched"). */
export function shellWrites(command: unknown): string[] {
  if (typeof command !== "string") return [];
  const out: string[] = [];
  for (const m of command.matchAll(/(?:^|[^0-9&])>>?\s*("([^"]+)"|'([^']+)'|([^\s;&|]+))/g)) {
    const target = m[2] ?? m[3] ?? m[4];
    if (target && target !== "/dev/null" && !target.startsWith("&")) out.push(target);
  }
  return out;
}

/** The local-testing context for an agent working in these folders (real process and file lookups). */
export function localContext(roots: Array<string | undefined>): LocalContext {
  return {
    // Its folders, plus scratch space: the system temp folders (Claude Code keeps an agent's scratchpad there).
    roots: [...roots.filter((r): r is string => Boolean(r)), tmpdir(), "/tmp", "/private/tmp"],
    cwdOfPid: (pid) => {
      try {
        const out = execFileSync("lsof", ["-a", "-d", "cwd", "-p", String(pid), "-Fn"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 3000 });
        return out.split("\n").find((l) => l.startsWith("n"))?.slice(1);
      } catch {
        return undefined;
      }
    },
    readFile: (path) => {
      try {
        return statSync(path).size < 64 ? readFileSync(path, "utf8") : undefined;
      } catch {
        return undefined;
      }
    },
  };
}
