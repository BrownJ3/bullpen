// The harness server: one process owning the DB, the agent sessions, the WS endpoint and the web UI.
// Run: npm run server   (BULLPEN_PORT to change the port)

import { timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { createServer, type IncomingMessage } from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
import { DB_PATH, loadOrCreateToken } from "./home.ts";
import { CommandError, Orchestrator } from "./orchestrator.ts";
import {
  DEFAULT_PORT,
  type Push,
  type Request,
  type Response,
  type SidebarSnapshot,
  type SubscribeResult,
} from "./protocol.ts";
import { AGENT_TEMPLATES, DEPARTMENTS } from "./agent-templates.ts";
import { claudeAdapter } from "./providers/claude.ts";
import { codexAdapter } from "./providers/codex.ts";
import { acpAdapter } from "./providers/acp.ts";
import { acpEngines } from "./engines.ts";
import { handleMcp, setMcpBase } from "./mcp.ts";
import {
  createFolder,
  defaultParent,
  discoverProjects,
  iconType,
  importCandidates,
  listDirs,
  locationOf,
  projectFor,
  resolveProjectIcon,
  tilde,
} from "./projects.ts";
import { listEntries, previewFile, revealFile } from "./files.ts";
import { devScripts, localServers, startStaticPreview, staticEntry } from "./preview.ts";
import { Store } from "./store.ts";
import { pastSessions } from "./sessions.ts";
import { ROOT as APP_ROOT, updateInfo } from "./version.ts";
import { spawn } from "node:child_process";
import { openSync, closeSync } from "node:fs";
import { join as joinPath } from "node:path";
import { HOME as DATA_HOME } from "./home.ts";
import { deviceToken, pairingUrl, qrSvg, readRemote, resolveHost, sshCommand } from "./remote.ts";
import { TerminalManager } from "./terminals.ts";
import { workdirOf, type StoredEvent } from "./types.ts";

const PORT = Number(process.env.BULLPEN_PORT ?? DEFAULT_PORT);
const LIVE_FLUSH_MS = 50;
const MAX_BUFFERED_BYTES = 8 * 1024 * 1024; // drop slow clients instead of growing memory forever
const UI_HTML = new URL("../ui/index.html", import.meta.url);
/** Static files the page loads (no secrets in any of them). */
const STATIC: Record<string, { file: URL; type: string }> = {
  "/icon.svg": { file: new URL("../assets/icon.svg", import.meta.url), type: "image/svg+xml" },
  "/icon.png": { file: new URL("../assets/icon-1024.png", import.meta.url), type: "image/png" },
};
/** Browsers can't set headers on a WebSocket, so the web UI sends its token as a subprotocol. */
const SUBPROTOCOL = "bullpen";

const token = loadOrCreateToken();
const store = new Store(DB_PATH);
const extraEngines = acpEngines();
const ENGINES = [
  { id: "claude", name: "Claude" },
  { id: "codex", name: "Codex" },
  ...extraEngines.map((e) => ({ id: e.id, name: e.name })),
];
const orchestrator = new Orchestrator(store, [claudeAdapter, codexAdapter, ...extraEngines.map(acpAdapter)]);
const terminals = new TerminalManager();
/** Static sites are served on the next port, a separate origin from this UI. */
const PREVIEW_PORT = PORT + 1;
const staticPreview = startStaticPreview(PREVIEW_PORT, (threadId) => {
  const t = store.getThread(threadId);
  return t ? workdirOf(t) : undefined;
});

/** The folder a thread's terminal and file explorer work in: its project (an agent's own folder for agents). */
function threadRoot(threadId: string): string {
  const thread = store.getThread(threadId);
  if (!thread) throw new CommandError("Unknown thread.");
  return workdirOf(thread);
}

/** Vendored browser files for the terminal (node_modules is served only for these exact paths). */
const VENDOR: Record<string, { file: URL; type: string }> = {
  "/vendor/xterm.js": { file: new URL("../node_modules/@xterm/xterm/lib/xterm.js", import.meta.url), type: "text/javascript" },
  "/vendor/xterm.css": { file: new URL("../node_modules/@xterm/xterm/css/xterm.css", import.meta.url), type: "text/css" },
  "/vendor/inter.woff2": { file: new URL("../node_modules/@fontsource-variable/inter/files/inter-latin-wght-normal.woff2", import.meta.url), type: "font/woff2" },
  "/vendor/addon-fit.js": { file: new URL("../node_modules/@xterm/addon-fit/lib/addon-fit.js", import.meta.url), type: "text/javascript" },
};

const ownHosts = new Set([`127.0.0.1:${PORT}`, `localhost:${PORT}`]);
// Remote access (off unless `bullpen remote on`): also listen on the Tailscale or local-network address.
const remote = readRemote();
const remoteHost = remote.enabled ? resolveHost(remote) : undefined;
// Other devices' token (also used through an SSH tunnel); exists once remote access was set up.
const remoteToken = deviceToken(Boolean(remoteHost));
if (remoteHost) for (const h of [remoteHost.host, ...remoteHost.names]) ownHosts.add(`${h}:${PORT}`);
const ownOrigins = new Set([...ownHosts].map((h) => `http://${h}`));

function tokenMatches(candidate: string | undefined): boolean {
  if (!candidate) return false;
  const a = Buffer.from(candidate);
  return [token, remoteToken].some((t) => {
    if (!t) return false;
    const b = Buffer.from(t);
    return a.length === b.length && timingSafeEqual(a, b);
  });
}

function requestToken(req: IncomingMessage): string | undefined {
  const bearer = req.headers.authorization?.replace(/^Bearer /, "");
  if (bearer) return bearer;
  const protocols = String(req.headers["sec-websocket-protocol"] ?? "").split(",").map((p) => p.trim());
  return protocols.find((p) => p.startsWith("token."))?.slice("token.".length);
}

// Agents can run shell commands, so only this machine's own UI or CLI may connect:
// the Host must be ours (blocks DNS rebinding), any Origin must be ours (blocks other web pages),
// and the token must match.
function allowed(req: IncomingMessage): boolean {
  if (!ownHosts.has(req.headers.host ?? "")) return false;
  const origin = req.headers.origin;
  if (origin && !ownOrigins.has(origin)) return false;
  return tokenMatches(requestToken(req));
}

function handleHttp(req: IncomingMessage, res: import("node:http").ServerResponse) {
  if (!ownHosts.has(req.headers.host ?? "")) {
    res.writeHead(421).end();
    return;
  }
  // Artifact pages, sandboxed (the secret key in the URL is the access check, like a share link).
  if (req.url?.startsWith("/av/") && orchestrator.artifacts.serve(req, res)) return;
  // Harness tools for ACP engines; each session's URL holds its own secret. Only from this Mac.
  if (req.url?.startsWith("/mcp/")) {
    if (req.socket.remoteAddress !== "127.0.0.1" && req.socket.remoteAddress !== "::ffff:127.0.0.1") {
      res.writeHead(403).end();
      return;
    }
    void handleMcp(req, res).catch(() => res.headersSent || res.writeHead(500).end());
    return;
  }
  if (req.method === "GET" && (req.url === "/" || req.url?.startsWith("/?"))) {
    // The page holds no secrets: it reads the token from the URL fragment, which never reaches the server.
    res.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "content-security-policy":
        `default-src 'self'; img-src 'self' data:; frame-src http: https:; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; font-src 'self'; connect-src ws://${req.headers.host}`,
      "x-frame-options": "DENY",
    });
    res.end(readFileSync(UI_HTML));
    return;
  }
  // A project's own favicon/logo, for the sidebar. Only for added projects, only image files inside them.
  const iconMatch = req.method === "GET" ? req.url?.match(/^\/project-icon\/([\w-]+)$/) : null;
  if (iconMatch) {
    const project = store.getProject(iconMatch[1]);
    const file = project ? resolveProjectIcon(project.path) : undefined;
    if (!file) {
      res.writeHead(404, { "cache-control": "max-age=60" }).end();
      return;
    }
    res.writeHead(200, { "content-type": iconType(file)!, "cache-control": "max-age=600", "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'" });
    res.end(readFileSync(file));
    return;
  }
  const asset = req.method === "GET" ? (STATIC[(req.url ?? "").split("?")[0]] ?? VENDOR[(req.url ?? "").split("?")[0]]) : undefined;
  if (asset) {
    // Revalidate every time so a new icon shows up right away.
    res.writeHead(200, { "content-type": asset.type, "cache-control": "no-cache" });
    res.end(readFileSync(asset.file));
    return;
  }
  res.writeHead(404).end();
}

const http = createServer(handleHttp);
const remoteHttp = remoteHost ? createServer(handleHttp) : undefined;
const wss = new WebSocketServer({
  noServer: true,
  handleProtocols: (protocols) => (protocols.has(SUBPROTOCOL) ? SUBPROTOCOL : false),
});
for (const server of [http, remoteHttp]) {
  server?.on("upgrade", (req, socket, head) => {
    if (!allowed(req)) {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
  });
}

wss.on("connection", (socket: WebSocket) => {
  const subscriptions = new Map<number, () => void>();
  let nextSubscription = 1;

  const send = (msg: Response | Push) => {
    if (socket.bufferedAmount > MAX_BUFFERED_BYTES) {
      socket.close(1013, "client too slow");
      return;
    }
    socket.send(JSON.stringify(msg));
  };

  socket.on("message", async (raw) => {
    let req: Request;
    try {
      req = JSON.parse(String(raw));
    } catch {
      return;
    }
    try {
      send({ id: req.id, result: await handle(req) });
    } catch (err) {
      if (!(err instanceof CommandError)) console.error(err);
      send({ id: req.id, error: err instanceof Error ? err.message : String(err) });
    }
  });

  socket.on("close", () => {
    for (const unsubscribe of subscriptions.values()) unsubscribe();
  });

  async function handle(req: Request): Promise<unknown> {
    switch (req.method) {
      case "dispatch":
        return orchestrator.dispatch(req.params);
      case "listThreads":
        return store.listThreads();
      case "listAgents":
        return store.listAgents();
      case "listAgentTemplates":
        return { departments: DEPARTMENTS, templates: AGENT_TEMPLATES };
      case "listProjects": {
        const used = [...store.listThreads(), ...store.listAgents()]
          .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
          .map((x) => x.cwd);
        const recent = [...new Set(used)].filter((p) => existsSync(p)).slice(0, 8).map(projectFor);
        const seen = new Set(recent.map((p) => p.path));
        const parent = defaultParent();
        return {
          recent,
          found: discoverProjects().filter((p) => !seen.has(p.path)),
          defaultParent: { path: parent, display: tilde(parent) },
        };
      }
      case "shutdown":
        setTimeout(shutdown, 100); // after this reply goes out
        return { ok: true };
      case "importCandidates": {
        // Everything you could show in the sidebar: found folders plus projects already added (even by hand).
        const projects = new Map(store.listProjects().map((p) => [p.path, p]));
        const rows = importCandidates().map((c) => {
          const p = projects.get(c.path);
          projects.delete(c.path);
          return { ...c, projectId: p?.id, added: Boolean(p), archived: Boolean(p?.archivedAt), pinned: Boolean(p?.pinnedAt) };
        });
        for (const p of projects.values()) {
          rows.push({
            ...projectFor(p.path), name: p.title, sessions: 0, tools: [], lastUsedAt: p.lastUsedAt, location: locationOf(p.path),
            projectId: p.id, added: true, archived: Boolean(p.archivedAt), pinned: Boolean(p.pinnedAt),
          });
        }
        return rows;
      }
      case "projectSuggestions": {
        // Folders you've used Claude Code or Codex in that aren't in the sidebar yet (and you haven't waved off).
        const have = new Set(store.listProjects().map((p) => p.path));
        const dismissed = new Set(store.getSetting<string[]>("projects.dismissed", []));
        const items = importCandidates()
          .filter((c) => c.tools.length && !have.has(c.path) && !dismissed.has(c.path))
          .sort((a, b) => (b.lastUsedAt ?? "").localeCompare(a.lastUsedAt ?? ""));
        return { firstRun: !have.size && !store.getSetting("projects.onboarded", false), items };
      }
      case "pastSessions": {
        // Hide sessions this Bullpen has already picked up.
        const taken = new Set(store.listThreads().map((t) => t.nativeSessionId).filter(Boolean));
        return pastSessions(req.params.path).filter((s) => !taken.has(s.id)).map(({ file: _file, ...s }) => s);
      }
      case "terminal.list":
        return terminals.list(req.params.threadId);
      case "terminal.open":
        return terminals.open(req.params.threadId, threadRoot(req.params.threadId));
      case "terminal.attach": {
        const subscription = nextSubscription++;
        const att = terminals.attach(req.params.terminalId, (msg) => send({ subscription, ...msg }));
        subscriptions.set(subscription, att.detach);
        return { subscription, history: att.history, info: att.info };
      }
      case "terminal.input":
        terminals.write(req.params.terminalId, req.params.data);
        return { ok: true };
      case "terminal.resize":
        terminals.resize(req.params.terminalId, req.params.cols, req.params.rows);
        return { ok: true };
      case "terminal.close":
        terminals.close(req.params.terminalId);
        return { ok: true };
      case "files.list":
        try {
          return await listEntries(threadRoot(req.params.threadId), req.params.path);
        } catch (err) {
          throw new CommandError((err as Error).message);
        }
      case "files.read":
        try {
          return previewFile(threadRoot(req.params.threadId), req.params.path);
        } catch (err) {
          throw new CommandError((err as Error).message);
        }
      case "files.reveal":
        revealFile(threadRoot(req.params.threadId), req.params.path, req.params.how);
        return { ok: true };
      case "preview.info": {
        const root = threadRoot(req.params.threadId);
        const entry = staticEntry(root);
        return {
          servers: await localServers(root, [PORT, PREVIEW_PORT]),
          scripts: devScripts(root),
          staticUrl: entry ? `http://127.0.0.1:${PREVIEW_PORT}/t/${req.params.threadId}/${entry}` : undefined,
        };
      }
      case "inbox": {
        const latest = store.getSetting<unknown>("briefing.latest", null);
        const since = new Date(Date.now() - 24 * 3600_000).toISOString();
        return {
          latest,
          recent: orchestrator.briefing(since),
          runs: store.jobRunsSince(since).slice(0, 50),
          pausedUntil: store.getSetting<string | null>("jobs.pausedUntil", null),
        };
      }
      case "teams":
        return orchestrator.teams();
      case "browser.open": {
        const p = req.params as { threadId: string; url: string };
        threadRoot(p.threadId);
        return orchestrator.browser.open(p.threadId, p.url).catch((err) => { throw new CommandError((err as Error).message.split("\n")[0]); });
      }
      case "browser.frame": {
        const p = req.params as { threadId: string };
        return (await orchestrator.browser.frame(p.threadId).catch(() => undefined)) ?? null;
      }
      case "browser.input": {
        const p = req.params as { threadId: string; event: Parameters<typeof orchestrator.browser.input>[1] };
        threadRoot(p.threadId);
        await orchestrator.browser.input(p.threadId, p.event).catch(() => {});
        return { ok: true };
      }
      case "browser.close":
        await orchestrator.browser.close(String((req.params as { threadId: string }).threadId));
        return { ok: true };
      case "artifact.content": {
        const p = req.params as { artifactId: string; version?: number };
        try {
          return orchestrator.artifacts.content(p.artifactId, p.version);
        } catch (err) {
          throw new CommandError((err as Error).message);
        }
      }
      case "version":
        return updateInfo();
      case "update.run": {
        // Runs `bullpen update` on its own: it restarts this server onto the new version.
        const log = openSync(joinPath(DATA_HOME, "update.log"), "a");
        const child = spawn(process.execPath, [joinPath(APP_ROOT, "src", "cli.ts"), "update"], { cwd: APP_ROOT, detached: true, stdio: ["ignore", log, log] });
        closeSync(log);
        child.unref();
        return { ok: true };
      }
      case "listEngines":
        return ENGINES;
      case "remote.info": {
        const url = remoteHost && remoteToken ? pairingUrl(remoteHost.names[0] && remote.via === "tailscale" ? remoteHost.names[0] : remoteHost.host, PORT, remoteToken) : undefined;
        return {
          enabled: remote.enabled,
          via: remote.via,
          listening: Boolean(remoteHost),
          host: remoteHost?.host,
          names: remoteHost?.names ?? [],
          url,
          qr: url ? await qrSvg(url) : undefined,
          ssh: sshCommand(PORT),
        };
      }
      case "worktreeStatus":
        return orchestrator.worktreeStatus(String(req.params?.threadId ?? ""));
      case "jobRuns":
        return store.jobRunsFor(req.params.jobId, 30);
      case "createFolder":
        try {
          return await createFolder(req.params.parent, req.params.name, req.params.git);
        } catch (err) {
          throw new CommandError((err as Error).message);
        }
      case "listDirs":
        try {
          return listDirs(req.params.path);
        } catch (err) {
          throw new CommandError((err as Error).message);
        }
      case "getDiff":
        return orchestrator.diff(req.params.threadId, req.params.fromOrdinal, req.params.toOrdinal);
      case "unsubscribe":
        subscriptions.get(req.params.subscription)?.();
        subscriptions.delete(req.params.subscription);
        return { ok: true };
      case "subscribeThread":
        return subscribeThread(req.params.threadId, req.params.afterSequence);
      case "subscribeSidebar":
        return subscribeSidebar();
    }
  }

  /** Coalesce live events into 50ms batches for one subscription. */
  function batcher(subscription: number) {
    let buffer: StoredEvent[] = [];
    let timer: NodeJS.Timeout | undefined;
    const flush = () => {
      timer = undefined;
      if (buffer.length) send({ subscription, items: buffer });
      buffer = [];
    };
    return {
      push(event: StoredEvent) {
        buffer.push(event);
        timer ??= setTimeout(flush, LIVE_FLUSH_MS);
      },
      stop() {
        if (timer) clearTimeout(timer);
      },
    };
  }

  // Snapshot-or-replay, then live events (T3: subscribeThread).
  function subscribeThread(threadId: string, afterSequence?: number): SubscribeResult {
    const thread = store.getThread(threadId);
    if (!thread) throw new CommandError(`Unknown thread ${threadId}.`);
    const subscription = nextSubscription++;
    const batch = batcher(subscription);
    const unsubscribe = store.subscribe(threadId, batch.push);
    subscriptions.set(subscription, () => {
      unsubscribe();
      batch.stop();
    });

    // Cheap catch-up if the client already has state and the gap is small; otherwise a bounded snapshot.
    if (afterSequence !== undefined) {
      const missed = store.eventsAfter(threadId, afterSequence, 500);
      if (missed.length < 500) {
        if (missed.length) send({ subscription, items: missed });
        return { subscription, mode: "replay", replayed: missed.length };
      }
    }
    return {
      subscription,
      mode: "snapshot",
      snapshot: {
        thread,
        runs: store.listRuns(threadId),
        turnItems: store.listTurnItems(threadId),
        sequence: store.latestSequence(threadId),
      },
    };
  }

  // Everything the sidebar shows, across all threads: thread/agent changes and approval prompts.
  function subscribeSidebar(): SidebarSnapshot {
    const subscription = nextSubscription++;
    const batch = batcher(subscription);
    const unsubscribe = store.subscribeAll((e) => {
      const ev = e.event;
      if (
        ev.type === "thread.upserted" ||
        ev.type === "agent.upserted" ||
        ev.type === "agent.deleted" ||
        ev.type === "project.upserted" ||
        ev.type === "job.upserted" ||
        ev.type === "job.deleted" ||
        ev.type === "jobrun.upserted" ||
        ev.type === "lesson.upserted" ||
        ev.type === "lesson.deleted" ||
        ev.type === "setting.upserted" ||
        ev.type === "project.removed" ||
        ev.type === "artifact.upserted" ||
        ev.type === "artifact.deleted" ||
        (ev.type === "turn-item.upserted" && (ev.item.kind === "approval_request" || ev.item.kind === "agent_reply"))
      ) {
        batch.push(e);
      }
    });
    subscriptions.set(subscription, () => {
      unsubscribe();
      batch.stop();
    });
    return {
      subscription,
      threads: store.listThreads(),
      agents: store.listAgents(),
      projects: store.listProjects(),
      jobs: store.listJobs(),
      lessons: store.listLessons().filter((l) => l.status !== "rejected"),
      artifacts: store.listArtifacts(),
      settings: {
        briefingTime: store.getSetting("briefing.time", "08:00"),
        briefingEnabled: store.getSetting("briefing.enabled", true),
        notifications: store.getSetting("notifications", true),
        claudeArtifacts: store.getSetting("artifacts.claude", false),
        artifactsLastSync: store.getSetting<unknown>("artifacts.lastSync", null),
      },
      pendingApprovals: store.pendingApprovals(),
    };
  }
});

if (remoteHttp && remoteHost) {
  remoteHttp.on("error", (err) => console.error(`[remote] can't listen on ${remoteHost.host}:${PORT}: ${err.message}`));
  remoteHttp.listen(PORT, remoteHost.host, () => console.log(`Remote access on http://${remoteHost.host}:${PORT} (${remote.via})`));
} else if (remote.enabled) {
  console.error(`[remote] turned on, but no ${remote.via === "lan" ? "local network" : "Tailscale"} address was found; only this Mac can connect.`);
}

setMcpBase(`http://127.0.0.1:${PORT}`);
http.listen(PORT, "127.0.0.1", () => {
  orchestrator.resumeInterrupted();
  console.log(`Bullpen listening on ws://127.0.0.1:${PORT}  (db: ${DB_PATH})`);
  console.log(`web UI: run \`bullpen\` (or \`npm run open\` in this folder)`);
});

const shutdown = () => {
  terminals.closeAll();
  staticPreview.close();
  orchestrator.shutdown();
  wss.close();
  http.close();
  remoteHttp?.close();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
