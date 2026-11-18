// What a team task may do without asking (decision 3: "team mode").
// Edits inside the project are allowed by the adapters' accept-edits modes; this file decides which shell
// commands are safe enough to run unattended. Anything else still comes to the person as an approval.

/** Read-only inspection, tests, builds, linters and type checks. */
const SAFE: RegExp[] = [
  /^(ls|pwd|cat|head|tail|wc|file|stat|tree|du|which|echo|printf|date|env|printenv|basename|dirname|realpath|true|test|\[)(\s|$)/,
  /^(grep|rg|ag|find|fd|sort|uniq|cut|diff|cmp|jq|yq|od|xxd|hexdump|md5|shasum|sha256sum)(\s|$)/,
  /^git (status|diff|log|show|branch|rev-parse|ls-files|blame|grep|remote -v|stash list|describe|shortlog)(\s|$)/,
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

/** Never unattended, wherever they appear. */
const DANGEROUS = /\b(rm|mv|cp|chmod|chown|sudo|curl|wget|ssh|scp|rsync|kill|pkill|dd|mkfs|tee|truncate|xargs|eval|exec|source|open)\b|\bgit\b[^&;|]*\b(push|reset|checkout|clean|rebase|commit|merge|tag|restore|switch|rm|mv)\b|\b(npm|pnpm|yarn|bun)\s+(i|install|add|remove|uninstall|publish|link|exec|dlx|create)\b|\bnpx\b(?!\s+(--no-install\s+)?(tsc|vitest|jest|eslint|prettier --check|playwright test|astro check|svelte-check|next lint))/;

/** Split a command line on && || ; | outside quotes. Returns null for anything we won't reason about. */
function segments(command: string): string[] | null {
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
    if (ch === "&") return null; // backgrounding
    cur += ch;
  }
  if (quote) return null;
  out.push(cur);
  return out.map((s) => s.trim()).filter(Boolean);
}

export function isSafeCommand(command: unknown): boolean {
  if (typeof command !== "string") return false;
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
