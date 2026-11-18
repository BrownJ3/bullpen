// The Browser panel's server side: find dev servers a project is running, suggest how to start one,
// and serve static sites (an index.html) from a separate origin so their scripts can't reach Bullpen.

import { execFile } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { extname, join, sep } from "node:path";
import { promisify } from "node:util";
import { inside } from "./files.ts";

const run = promisify(execFile);

export interface LocalServer {
  url: string;
  port: number;
  pid: number;
  command: string;
  /** Started from inside this project's folder. */
  inProject: boolean;
}

export interface DevScript {
  label: string;
  command: string;
}

/** Listening TCP ports on this machine, with each process's working folder (via lsof). */
export async function localServers(root: string, skipPorts: number[]): Promise<LocalServer[]> {
  let out: string;
  try {
    ({ stdout: out } = await run("lsof", ["-nP", "-iTCP", "-sTCP:LISTEN", "-F", "pcn"], { maxBuffer: 4 * 1024 * 1024 }));
  } catch (err) {
    out = (err as { stdout?: string }).stdout ?? ""; // lsof exits 1 when some processes can't be read
  }
  const found = new Map<number, { pid: number; command: string }>();
  let pid = 0;
  let command = "";
  for (const line of out.split("\n")) {
    if (line.startsWith("p")) pid = Number(line.slice(1));
    else if (line.startsWith("c")) command = line.slice(1);
    else if (line.startsWith("n")) {
      const m = line.match(/^n(?:\*|127\.0\.0\.1|\[::1\]|\[::\]|0\.0\.0\.0|localhost):(\d+)$/);
      if (!m) continue;
      const port = Number(m[1]);
      if (!skipPorts.includes(port) && pid !== process.pid && !found.has(port)) found.set(port, { pid, command });
    }
  }
  if (!found.size) return [];
  const pids = [...new Set([...found.values()].map((f) => f.pid))];
  const cwds = new Map<number, string>();
  try {
    const { stdout } = await run("lsof", ["-a", "-d", "cwd", "-p", pids.join(","), "-F", "pn"]);
    let p = 0;
    for (const line of stdout.split("\n")) {
      if (line.startsWith("p")) p = Number(line.slice(1));
      else if (line.startsWith("n")) cwds.set(p, line.slice(1));
    }
  } catch (err) {
    const stdout = (err as { stdout?: string }).stdout ?? "";
    let p = 0;
    for (const line of stdout.split("\n")) {
      if (line.startsWith("p")) p = Number(line.slice(1));
      else if (line.startsWith("n")) cwds.set(p, line.slice(1));
    }
  }
  const all = [...found].map(([port, f]) => {
    const cwd = cwds.get(f.pid) ?? "";
    return { url: `http://localhost:${port}/`, port, pid: f.pid, command: f.command, inProject: cwd === root || cwd.startsWith(root + sep) };
  });
  // Keep only ports that answer like a web server (skips databases, Docker, AirPlay and the like).
  const web = await Promise.all(all.map(async (s) => (NOT_WEB.test(s.command) ? false : speaksHttp(s.port))));
  return all.filter((_, i) => web[i]).sort((a, b) => Number(b.inProject) - Number(a.inProject) || a.port - b.port);
}

const NOT_WEB = /^(ControlCenter|rapportd|postgres|mysqld|mongod|redis-server|com\.docker|sharingd|identityservicesd|Spotify|Dropbox|launchd)/i;

async function speaksHttp(port: number): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/`, { method: "GET", redirect: "manual", signal: AbortSignal.timeout(700) });
    await res.body?.cancel();
    const type = res.headers.get("content-type") ?? "";
    return res.status < 500 && (type.includes("html") || res.status === 404 || (res.status >= 300 && res.status < 400) || type === "");
  } catch {
    return false;
  }
}

/** "npm run dev" and friends, from package.json, using the project's package manager. */
export function devScripts(root: string): DevScript[] {
  const pkgFile = join(root, "package.json");
  if (!existsSync(pkgFile)) return [];
  let scripts: Record<string, string> = {};
  try {
    scripts = JSON.parse(readFileSync(pkgFile, "utf8")).scripts ?? {};
  } catch {
    return [];
  }
  const runner = existsSync(join(root, "pnpm-lock.yaml"))
    ? "pnpm"
    : existsSync(join(root, "yarn.lock"))
      ? "yarn"
      : existsSync(join(root, "bun.lockb")) || existsSync(join(root, "bun.lock"))
        ? "bun run"
        : "npm run";
  return ["dev", "start", "serve", "preview", "develop"]
    .filter((name) => scripts[name])
    .map((name) => ({ label: `${runner} ${name}`, command: `${runner} ${name}` }));
}

/** The index.html a static site would open with, relative to the root. */
export function staticEntry(root: string): string | undefined {
  return ["index.html", "public/index.html", "dist/index.html", "build/index.html", "docs/index.html"].find((p) => existsSync(join(root, p)));
}

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".htm": "text/html; charset=utf-8", ".css": "text/css", ".js": "text/javascript",
  ".mjs": "text/javascript", ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp", ".ico": "image/x-icon", ".woff": "font/woff",
  ".woff2": "font/woff2", ".ttf": "font/ttf", ".txt": "text/plain; charset=utf-8", ".md": "text/plain; charset=utf-8",
  ".wasm": "application/wasm", ".mp4": "video/mp4", ".webm": "video/webm", ".mp3": "audio/mpeg", ".pdf": "application/pdf",
};

/**
 * Static file server for /t/<threadId>/<path> on its own port (a different origin from Bullpen's UI,
 * so a previewed page can't read Bullpen's token or call its API). Read-only, local only.
 */
export function startStaticPreview(port: number, rootFor: (threadId: string) => string | undefined): Server {
  const hosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
  const server = createServer((req, res) => {
    if (!hosts.has(req.headers.host ?? "") || req.method !== "GET") return void res.writeHead(404).end();
    const m = decodeURIComponent((req.url ?? "").split("?")[0]).match(/^\/t\/([\w-]+)(\/.*)?$/);
    const root = m ? rootFor(m[1]) : undefined;
    if (!m || !root) return void res.writeHead(404).end("Not found");
    try {
      let file = inside(root, (m[2] ?? "/").slice(1));
      if (statSync(file).isDirectory()) file = join(file, "index.html");
      if (!existsSync(file)) return void res.writeHead(404, { "content-type": "text/plain" }).end("Not found");
      res.writeHead(200, { "content-type": TYPES[extname(file).toLowerCase()] ?? "application/octet-stream", "cache-control": "no-cache" });
      res.end(readFileSync(file));
    } catch {
      res.writeHead(404, { "content-type": "text/plain" }).end("Not found");
    }
  });
  server.on("error", (err) => console.error(`[preview] static server on ${port}: ${(err as Error).message}`));
  server.listen(port, "127.0.0.1");
  return server;
}
