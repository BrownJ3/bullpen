// The file explorer's server side (T3: apps/server/src/workspace/WorkspaceEntries.ts, FilePreviewPanel).
// Everything is confined to one root folder (the thread's project); paths are relative to it.

import { execFile, execFileSync } from "node:child_process";
import { existsSync, openSync, readSync, closeSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { extname, join, relative, resolve, sep } from "node:path";

export interface FileEntry {
  name: string;
  /** Relative to the root, with "/" separators. */
  path: string;
  dir: boolean;
  size?: number;
  /** Matched by .gitignore: shown dimmed, like T3. */
  ignored?: boolean;
}

export type FilePreview =
  | { kind: "text"; path: string; size: number; text: string; truncated: boolean }
  | { kind: "image"; path: string; size: number; dataUrl: string }
  | { kind: "binary"; path: string; size: number }
  | { kind: "too-large"; path: string; size: number };

const HIDDEN = new Set([".git", ".DS_Store"]);
const TEXT_LIMIT = 1024 * 1024;
const IMAGE_LIMIT = 5 * 1024 * 1024;
const IMAGE_TYPES: Record<string, string> = {
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif",
  ".webp": "image/webp", ".svg": "image/svg+xml", ".ico": "image/x-icon", ".bmp": "image/bmp",
};

/** Absolute path for `rel` inside `root`, refusing anything that escapes it (../, symlinks out). */
export function inside(root: string, rel: string): string {
  const base = realpathSync(root);
  const target = resolve(base, rel || ".");
  const real = existsSync(target) ? realpathSync(target) : target;
  if (real !== base && !real.startsWith(base + sep)) throw new Error("That path is outside the project.");
  return real;
}

function isGitRepo(root: string): boolean {
  try {
    return execFileSync("git", ["-C", root, "rev-parse", "--is-inside-work-tree"], { stdio: ["ignore", "pipe", "ignore"] }).toString().trim() === "true";
  } catch {
    return false;
  }
}

/** Which of `paths` git ignores (one `git check-ignore --stdin` call per folder, as T3 does). */
function ignoredPaths(root: string, paths: string[]): Promise<Set<string>> {
  return new Promise((done) => {
    if (!paths.length || !isGitRepo(root)) return done(new Set());
    const child = execFile("git", ["-C", root, "-c", "core.fsmonitor=false", "check-ignore", "-z", "--stdin"], (_err, stdout) => {
      done(new Set(String(stdout ?? "").split("\0").filter(Boolean)));
    });
    child.stdin?.end(paths.join("\0") + "\0");
  });
}

export async function listEntries(root: string, rel: string): Promise<FileEntry[]> {
  const dir = inside(root, rel);
  const base = realpathSync(root);
  const entries: FileEntry[] = [];
  for (const d of readdirSync(dir, { withFileTypes: true })) {
    if (HIDDEN.has(d.name)) continue;
    const abs = join(dir, d.name);
    let isDir = d.isDirectory();
    let size: number | undefined;
    try {
      const st = statSync(abs); // follows symlinks
      isDir = st.isDirectory();
      if (!isDir) size = st.size;
    } catch {
      continue; // broken link
    }
    entries.push({ name: d.name, path: relative(base, abs).split(sep).join("/"), dir: isDir, size });
  }
  const ignored = await ignoredPaths(base, entries.map((e) => (e.dir ? e.path + "/" : e.path)));
  for (const e of entries) if (ignored.has(e.dir ? e.path + "/" : e.path) || ignored.has(e.path)) e.ignored = true;
  return entries.sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name, undefined, { sensitivity: "base", numeric: true }));
}

export function previewFile(root: string, rel: string): FilePreview {
  const abs = inside(root, rel);
  const st = statSync(abs);
  if (st.isDirectory()) throw new Error("That's a folder.");
  const path = rel;
  const type = IMAGE_TYPES[extname(abs).toLowerCase()];
  if (type) {
    if (st.size > IMAGE_LIMIT) return { kind: "too-large", path, size: st.size };
    return { kind: "image", path, size: st.size, dataUrl: `data:${type};base64,${readFileSync(abs).toString("base64")}` };
  }
  // Binary sniff: a NUL byte in the first 8 KB.
  const head = Buffer.alloc(Math.min(8192, st.size));
  const fd = openSync(abs, "r");
  try {
    readSync(fd, head, 0, head.length, 0);
  } finally {
    closeSync(fd);
  }
  if (head.includes(0)) return { kind: "binary", path, size: st.size };
  if (st.size > TEXT_LIMIT * 4) return { kind: "too-large", path, size: st.size };
  const text = readFileSync(abs, "utf8");
  return { kind: "text", path, size: st.size, text: text.length > TEXT_LIMIT ? text.slice(0, TEXT_LIMIT) : text, truncated: text.length > TEXT_LIMIT };
}

/** Show it in Finder, or open it with its default app (macOS `open`). */
export function revealFile(root: string, rel: string, how: "reveal" | "open") {
  const abs = inside(root, rel);
  execFile("open", how === "reveal" ? ["-R", abs] : [abs], () => {});
}
