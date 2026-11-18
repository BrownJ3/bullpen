// Finds folders to work in, so nobody has to type a path: folders already used by threads and
// agents, plus project folders (git repos, package.json, …) found in the usual places under ~.

import { execFile } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readSync, readdirSync, statSync } from "node:fs";
import { promisify } from "node:util";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

export interface Project {
  path: string;
  name: string;
  /** Shown under the name: the parent folder, with ~ for home. */
  where: string;
}

const HOME = homedir();
const MARKERS = [".git", "package.json", "pyproject.toml", "go.mod", "Cargo.toml", "Gemfile", "pom.xml", "build.gradle", "composer.json"];
const SKIP = new Set(["node_modules", "Library", "Applications", "Pictures", "Movies", "Music", "Public", "dist", "build", "vendor"]);
/** [folder, how many levels below it to look]. */
const ROOTS: Array<[string, number]> = [
  [HOME, 1],
  ...["code", "Code", "dev", "Developer", "src", "projects", "Projects", "repos", "git", "GitHub", "work", "Documents", "Desktop"].map(
    (d): [string, number] => [join(HOME, d), 2],
  ),
];
const CACHE_MS = 30_000;
const LIMIT = 300;

let cache: { at: number; projects: Project[] } | undefined;

export function tilde(path: string): string {
  return path === HOME ? "~" : path.startsWith(HOME + "/") ? "~" + path.slice(HOME.length) : path;
}

export function expandHome(path: string): string {
  return path === "~" ? HOME : path.startsWith("~/") ? join(HOME, path.slice(2)) : path;
}

function project(path: string): Project {
  return { path, name: basename(path) || path, where: tilde(dirname(path)) };
}

function subdirs(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isDirectory() && !d.name.startsWith(".") && !SKIP.has(d.name))
      .map((d) => join(dir, d.name));
  } catch {
    return []; // unreadable or (on macOS) not allowed
  }
}

const isProject = (dir: string) => MARKERS.some((m) => existsSync(join(dir, m)));

/** Project folders under the usual places. A project's own subfolders aren't listed. */
export function discoverProjects(): Project[] {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.projects;
  const found = new Map<string, Project>();
  const walk = (dir: string, depth: number) => {
    for (const sub of subdirs(dir)) {
      if (found.size >= LIMIT) return;
      if (isProject(sub)) found.set(sub, project(sub));
      else if (depth > 1) walk(sub, depth - 1);
    }
  };
  for (const [root, depth] of ROOTS) if (existsSync(root)) walk(root, depth);
  const projects = [...found.values()].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
  cache = { at: Date.now(), projects };
  return projects;
}

/** Subfolders of `path`, for browsing to a folder that discovery missed. */
export function listDirs(path: string): { path: string; display: string; parent?: string; dirs: Project[] } {
  const dir = resolve(expandHome(path || "~"));
  if (!statSync(dir, { throwIfNoEntry: false })?.isDirectory()) throw new Error(`Not a folder: ${path}`);
  const parent = dirname(dir);
  return {
    path: dir,
    display: tilde(dir),
    parent: parent !== dir ? parent : undefined,
    dirs: subdirs(dir)
      .sort((a, b) => basename(a).localeCompare(basename(b), undefined, { sensitivity: "base" }))
      .map(project),
  };
}

export { project as projectFor };

/** Where new projects go by default: the folder that already holds most of your projects. */
export function defaultParent(): string {
  const counts = new Map<string, number>();
  for (const p of discoverProjects()) {
    const parent = dirname(p.path);
    counts.set(parent, (counts.get(parent) ?? 0) + 1);
  }
  const best = [...counts].sort((a, b) => b[1] - a[1])[0]?.[0];
  return best ?? (existsSync(join(HOME, "Documents")) ? join(HOME, "Documents") : HOME);
}

/** Make a new, empty project folder (optionally a git repo, which checkpoints need). */
export async function createFolder(parent: string, name: string, git: boolean): Promise<Project> {
  const clean = name.trim();
  if (!clean || clean === "." || clean === ".." || /[/\\\0]/.test(clean) || clean.startsWith(".")) {
    throw new Error("Use a folder name without slashes, not starting with a dot.");
  }
  const dir = resolve(expandHome(parent || defaultParent()));
  if (!statSync(dir, { throwIfNoEntry: false })?.isDirectory()) throw new Error(`Not a folder: ${parent}`);
  const path = join(dir, clean);
  if (existsSync(path)) throw new Error(`${tilde(path)} already exists.`);
  mkdirSync(path);
  if (git) await promisify(execFile)("git", ["init", "-q"], { cwd: path });
  cache = undefined;
  return project(path);
}

// ---------- past Claude Code sessions ----------

export interface PastSession {
  /** Claude Code's session id; resuming it continues that conversation. */
  id: string;
  title: string;
  updatedAt: string;
  /** Rough size, so a long session reads as such. */
  sizeKb: number;
}

/** Claude Code stores a folder's sessions under ~/.claude/projects/<path with every non-alphanumeric as "-">. */
function claudeProjectDir(path: string): string {
  return join(HOME, ".claude", "projects", path.replace(/[^a-zA-Z0-9]/g, "-"));
}

function readSlice(file: string, from: number, length: number): string {
  const fd = openSync(file, "r");
  try {
    const buf = Buffer.alloc(length);
    const n = readSync(fd, buf, 0, length, from);
    return buf.subarray(0, n).toString("utf8");
  } finally {
    closeSync(fd);
  }
}

/** First thing the person typed, skipping command wrappers and system text. */
function firstPrompt(head: string): string | undefined {
  for (const line of head.split("\n")) {
    if (!line.includes('"type":"user"')) continue;
    try {
      const rec = JSON.parse(line);
      if (rec.type !== "user" || rec.isSidechain || rec.isMeta) continue;
      const content = rec.message?.content;
      const text =
        typeof content === "string"
          ? content
          : Array.isArray(content)
            ? content.find((b: { type?: string }) => b?.type === "text")?.text
            : undefined;
      if (typeof text === "string" && text.trim() && !text.trimStart().startsWith("<") && !text.startsWith("Caveat:")) {
        return text.trim();
      }
    } catch {
      // a line cut off at the slice boundary
    }
  }
  return undefined;
}

/** The latest custom title (from /rename) in the tail of a session file. */
function customTitle(tail: string): string | undefined {
  let title: string | undefined;
  for (const m of tail.matchAll(/"type":"custom-title","customTitle":"((?:[^"\\]|\\.)*)"/g)) {
    try {
      title = JSON.parse(`"${m[1]}"`);
    } catch {}
  }
  return title;
}

/** Recent Claude Code sessions started in `path`, newest first. */
export function pastClaudeSessions(path: string, limit = 12): PastSession[] {
  const dir = claudeProjectDir(path);
  let files: Array<{ id: string; file: string; mtime: number; size: number }>;
  try {
    files = readdirSync(dir)
      .filter((f) => f.endsWith(".jsonl"))
      .map((f) => {
        const file = join(dir, f);
        const st = statSync(file);
        return { id: f.slice(0, -".jsonl".length), file, mtime: st.mtimeMs, size: st.size };
      })
      .sort((a, b) => b.mtime - a.mtime)
      .slice(0, limit);
  } catch {
    return [];
  }
  const sessions: PastSession[] = [];
  for (const f of files) {
    const head = readSlice(f.file, 0, Math.min(f.size, 256 * 1024));
    const prompt = firstPrompt(head);
    if (!prompt) continue; // nothing the person typed: a stub or a resumed-elsewhere shell
    const tail = f.size > 256 * 1024 ? readSlice(f.file, f.size - 128 * 1024, 128 * 1024) : head;
    const title = customTitle(tail) ?? customTitle(head) ?? prompt;
    sessions.push({
      id: f.id,
      title: title.replace(/\s+/g, " ").slice(0, 90),
      updatedAt: new Date(f.mtime).toISOString(),
      sizeKb: Math.round(f.size / 1024),
    });
  }
  return sessions;
}

// ---------- import: folders worth adding as projects ----------

export interface ImportCandidate extends Project {
  /** Claude Code sessions found for this folder. */
  sessions: number;
  lastUsedAt?: string;
  /** Where it was found, for grouping in the dialog. */
  location: "documents" | "home" | "elsewhere";
}

const SKIP_IMPORT = [
  HOME,
  "/tmp",
  "/private/tmp",
  "/private/var",
  "/var/folders",
  join(HOME, "Downloads"),
  join(HOME, "Library"),
  join(HOME, ".bullpen"),
];

export function locationOf(path: string): ImportCandidate["location"] {
  if (path.startsWith(join(HOME, "Documents") + "/")) return "documents";
  if (path.startsWith(HOME + "/")) return "home";
  return "elsewhere";
}

function skipForImport(path: string): boolean {
  return SKIP_IMPORT.some((s) => path === s || (s !== HOME && path.startsWith(s + "/")));
}

/** Folders you've used Claude Code in (from its session files), plus project folders in ~/Documents (T3: AgentSessionScanner). */
export function importCandidates(): ImportCandidate[] {
  const byPath = new Map<string, ImportCandidate>();
  const docs = join(HOME, "Documents");
  const add = (path: string, sessions: number, lastUsedAt?: string) => {
    if (skipForImport(path) || !existsSync(path)) return;
    const prev = byPath.get(path);
    if (prev) {
      prev.sessions += sessions;
      if (lastUsedAt && (!prev.lastUsedAt || lastUsedAt > prev.lastUsedAt)) prev.lastUsedAt = lastUsedAt;
      return;
    }
    byPath.set(path, { ...project(path), sessions, lastUsedAt, location: locationOf(path) });
  };

  const root = join(HOME, ".claude", "projects");
  let dirs: string[] = [];
  try {
    dirs = readdirSync(root);
  } catch {}
  for (const d of dirs) {
    const dir = join(root, d);
    let files: Array<{ file: string; mtime: number }>;
    try {
      files = readdirSync(dir)
        .filter((f) => f.endsWith(".jsonl"))
        .map((f) => ({ file: join(dir, f), mtime: statSync(join(dir, f)).mtimeMs }))
        .sort((a, b) => b.mtime - a.mtime);
    } catch {
      continue;
    }
    if (!files.length) continue;
    // The folder name is lossy (every non-alphanumeric became "-"), so read the real cwd from a session.
    const cwd = readSlice(files[0].file, 0, 64 * 1024).match(/"cwd":"((?:[^"\\]|\\.)*)"/)?.[1];
    if (!cwd) continue;
    let path: string;
    try {
      path = JSON.parse(`"${cwd}"`);
    } catch {
      continue;
    }
    add(path, files.length, new Date(files[0].mtime).toISOString());
  }
  // Project folders found on disk: ~/Documents, the home folder itself, and the usual code folders under it.
  for (const p of discoverProjects()) add(p.path, 0);

  const rank = { documents: 0, home: 1, elsewhere: 2 };
  return [...byPath.values()].sort(
    (a, b) =>
      rank[a.location] - rank[b.location] ||
      (b.lastUsedAt ?? "").localeCompare(a.lastUsedAt ?? "") ||
      a.name.localeCompare(b.name, undefined, { sensitivity: "base" }),
  );
}

// ---------- project icons (T3: ProjectFaviconResolver) ----------

const ICON_FILES = [
  "favicon.svg", "favicon.ico", "favicon.png",
  "public/favicon.svg", "public/favicon.ico", "public/favicon.png",
  "app/favicon.ico", "app/icon.svg", "app/icon.png",
  "src/favicon.svg", "src/favicon.ico", "src/favicon.png", "src/app/favicon.ico", "src/app/icon.svg", "src/app/icon.png",
  "assets/icon.svg", "assets/icon.png", "assets/logo.svg", "assets/logo.png",
  ".idea/icon.svg",
];
const ICON_TYPES: Record<string, string> = { svg: "image/svg+xml", ico: "image/x-icon", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp" };
const iconCache = new Map<string, { at: number; file?: string }>();

export function iconType(file: string): string | undefined {
  return ICON_TYPES[file.split(".").pop()?.toLowerCase() ?? ""];
}

/** An image file inside the project that it uses as its icon, if any. */
export function resolveProjectIcon(dir: string): string | undefined {
  const cached = iconCache.get(dir);
  if (cached && Date.now() - cached.at < (cached.file ? 600_000 : 60_000)) return cached.file;
  let found: string | undefined;
  for (const rel of ICON_FILES) {
    const file = join(dir, rel);
    if (existsSync(file)) {
      found = file;
      break;
    }
  }
  if (!found) {
    // <link rel="icon" href="…"> in an index.html
    for (const html of ["index.html", "public/index.html", "src/index.html"]) {
      const file = join(dir, html);
      if (!existsSync(file)) continue;
      const href = readSlice(file, 0, 32 * 1024).match(/<link[^>]+rel=["'][^"']*icon[^"']*["'][^>]*href=["']([^"'?#]+)/i)?.[1];
      if (!href || /^(https?:|data:|\/\/)/.test(href)) continue;
      for (const base of [dir, join(dir, "public"), dirname(file)]) {
        const candidate = resolve(base, href.replace(/^\//, ""));
        if (candidate.startsWith(dir + "/") && existsSync(candidate)) {
          found = candidate;
          break;
        }
      }
      if (found) break;
    }
  }
  if (found && (!iconType(found) || (statSync(found, { throwIfNoEntry: false })?.size ?? 0) > 1_000_000)) found = undefined;
  iconCache.set(dir, { at: Date.now(), file: found });
  return found;
}
