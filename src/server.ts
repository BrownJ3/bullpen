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
import {
  createFolder,
  defaultParent,
  discoverProjects,
  iconType,
  importCandidates,
  listDirs,
  locationOf,
  pastClaudeSessions,
  projectFor,
  resolveProjectIcon,
  tilde,
} from "./projects.ts";
import { listEntries, previewFile, revealFile } from "./files.ts";
import { devScripts, localServers, startStaticPreview, staticEntry } from "./preview.ts";
import { Store } from "./store.ts";
import { TerminalManager } from "./terminals.ts";
import type { StoredEvent } from "./types.ts";

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
const orchestrator = new Orchestrator(store, [claudeAdapter, codexAdapter]);
const terminals = new TerminalManager();
/** Static sites are served on the next port, a separate origin from this UI. */
const PREVIEW_PORT = PORT + 1;
const staticPreview = startStaticPreview(PREVIEW_PORT, (threadId) => store.getThread(threadId)?.cwd);

/** The folder a thread's terminal and file explorer work in: its project (an agent's own folder for agents). */
function threadRoot(threadId: string): string {
  const thread = store.getThread(threadId);
  if (!thread) throw new CommandError("Unknown thread.");
  return thread.cwd;
}

/** Vendored browser files for the terminal (node_modules is served only for these exact paths). */
const VENDOR: Record<string, { file: URL; type: string }> = {
  "/vendor/xterm.js": { file: new URL("../node_modules/@xterm/xterm/lib/xterm.js", import.meta.url), type: "text/javascript" },
  "/vendor/xterm.css": { file: new URL("../node_modules/@xterm/xterm/css/xterm.css", import.meta.url), type: "text/css" },
  "/vendor/addon-fit.js": { file: new URL("../node_modules/@xterm/addon-fit/lib/addon-fit.js", import.meta.url), type: "text/javascript" },
};

const ownHosts = new Set([`127.0.0.1:${PORT}`, `localhost:${PORT}`]);
const ownOrigins = new Set([...ownHosts].map((h) => `http://${h}`));

function tokenMatches(candidate: string | undefined): boolean {
  if (!candidate) return false;
  const a = Buffer.from(candidate);
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
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

const http = createServer((req, res) => {
  if (!ownHosts.has(req.headers.host ?? "")) {
    res.writeHead(421).end();
    return;
  }
  if (req.method === "GET" && (req.url === "/" || req.url?.startsWith("/?"))) {
    // The page holds no secrets: it reads the token from the URL fragment, which never reaches the server.
    res.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "content-security-policy":
        "default-src 'self'; img-src 'self' data:; frame-src http: https:; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; connect-src ws://127.0.0.1:* ws://localhost:*",
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
});

const wss = new WebSocketServer({
  server: http,
  verifyClient: ({ req }: { req: IncomingMessage }) => allowed(req),
  handleProtocols: (protocols) => (protocols.has(SUBPROTOCOL) ? SUBPROTOCOL : false),
});

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
            ...projectFor(p.path), name: p.title, sessions: 0, lastUsedAt: p.lastUsedAt, location: locationOf(p.path),
            projectId: p.id, added: true, archived: Boolean(p.archivedAt), pinned: Boolean(p.pinnedAt),
          });
        }
        return rows;
      }
      case "pastSessions": {
        // Hide sessions this Bullpen has already picked up.
        const taken = new Set(store.listThreads().map((t) => t.nativeSessionId).filter(Boolean));
        return pastClaudeSessions(req.params.path).filter((s) => !taken.has(s.id));
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
      settings: {
        briefingTime: store.getSetting("briefing.time", "08:00"),
        briefingEnabled: store.getSetting("briefing.enabled", true),
        notifications: store.getSetting("notifications", true),
      },
      pendingApprovals: store.pendingApprovals(),
    };
  }
});

http.listen(PORT, "127.0.0.1", () => {
  console.log(`Bullpen listening on ws://127.0.0.1:${PORT}  (db: ${DB_PATH})`);
  console.log(`web UI: run \`bullpen\` (or \`npm run open\` in this folder)`);
});

const shutdown = () => {
  terminals.closeAll();
  staticPreview.close();
  orchestrator.shutdown();
  wss.close();
  http.close();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
