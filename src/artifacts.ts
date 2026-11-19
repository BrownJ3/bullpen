// Artifacts: pages, reports and diagrams. Two sources, one list:
//   - Bullpen: an agent calls create_artifact / update_artifact; versions are files in ~/.bullpen/artifacts/<id>/.
//   - claude.ai: your published artifacts, pulled in through Claude Code's own Artifact tool (your sign-in, no
//     separate API key). A short headless Claude session lists them every 30 minutes when turned on; "Copy into
//     Bullpen" reads one page so it can be shown here and handed to agents.
// Pages are served from /av/<key>/<version> with a CSP sandbox, so their scripts run in an opaque origin that can't
// reach Bullpen.

import { query } from "@anthropic-ai/claude-agent-sdk";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join } from "node:path";
import { HOME } from "./home.ts";
import type { Store } from "./store.ts";
import type { Artifact } from "./types.ts";

const DIR = join(HOME, "artifacts");
const SYNC_EVERY_MS = 30 * 60_000;
const MAX_BYTES = 8 * 1024 * 1024;
/** Cheapest model is plenty: it only calls one tool. */
const SYNC_MODEL = process.env.BULLPEN_ARTIFACT_MODEL ?? "claude-haiku-5-5";

const ext = (kind: Artifact["kind"]) => (kind === "markdown" ? "md" : "html");
const now = () => new Date().toISOString();
/** Stands in for "no date known". */
export const UNDATED = "2000-01-01T00:00:00.000Z";

export class Artifacts {
  readonly #store: Store;
  #timer: NodeJS.Timeout | undefined;
  #syncing: Promise<SyncResult> | undefined;
  lastSync: SyncResult | undefined;

  constructor(store: Store) {
    this.#store = store;
  }

  start() {
    // First pull shortly after start, then every 30 minutes (only when turned on).
    const tick = () => {
      if (this.enabled()) void this.sync().catch(() => {});
    };
    setTimeout(tick, 20_000).unref();
    this.#timer = setInterval(tick, SYNC_EVERY_MS);
    this.#timer.unref();
  }

  stop() {
    clearInterval(this.#timer);
  }

  enabled(): boolean {
    // Off unless turned on: Claude Code only offers its Artifact tool inside the Claude desktop app.
    return this.#store.getSetting("artifacts.claude", false);
  }

  // ---------------------------------------------------------------- Bullpen's own

  create(input: { title: string; content: string; kind?: "html" | "markdown"; description?: string; threadId?: string; agentId?: string; project?: string }): Artifact {
    const kind = input.kind ?? (/^\s*(<!doctype|<html|<svg|<div|<body|<head|<style|<script)/i.test(input.content) ? "html" : "markdown");
    const artifact: Artifact = {
      id: randomUUID(),
      source: "bullpen",
      title: input.title.trim().slice(0, 120) || "Untitled",
      kind,
      description: input.description?.trim().slice(0, 300) || undefined,
      version: 0,
      key: randomBytes(18).toString("hex"),
      threadId: input.threadId,
      agentId: input.agentId,
      project: input.project,
      createdAt: now(),
      updatedAt: now(),
    };
    return this.#write(artifact, input.content);
  }

  /**
   * Bring in a page you have: pasted or from a file. With a claude.ai link it's filed as that claude.ai artifact
   * (filling in the synced entry, if there is one); otherwise as one made here.
   */
  import(input: { content: string; title?: string; url?: string; kind?: "html" | "markdown" }): Artifact {
    const url = input.url?.trim() || undefined;
    if (url && !/^https:\/\/claude\.ai\/(code\/)?artifact\/[\w-]+/.test(url)) throw new Error("That isn't a claude.ai artifact link (claude.ai/artifact/…).");
    if (!input.content.trim()) throw new Error("Paste the page, or choose a file.");
    const kind = input.kind ?? (/^\s*</.test(input.content) ? "html" : "markdown");
    const title = input.title?.trim() || input.content.match(/<title>([^<]{1,120})<\/title>/i)?.[1]?.trim() || input.content.match(/^#\s+(.{1,120})$/m)?.[1]?.trim() || "Imported";
    const existing = url ? this.#store.listArtifacts().find((a) => a.url === url) : undefined;
    if (existing) return this.#write({ ...existing, kind, title: input.title?.trim() || existing.title }, input.content);
    const artifact: Artifact = {
      id: randomUUID(),
      source: url ? "claude" : "bullpen",
      title: title.slice(0, 120),
      kind,
      url,
      owner: url ? "mine" : undefined,
      imported: true,
      version: 0,
      key: randomBytes(18).toString("hex"),
      createdAt: now(),
      updatedAt: now(),
    };
    return this.#write(artifact, input.content);
  }

  update(id: string, content: string, title?: string): Artifact {
    const a = this.#require(id);
    return this.#write({ ...a, title: title?.trim().slice(0, 120) || a.title }, content);
  }

  #write(a: Artifact, content: string): Artifact {
    if (Buffer.byteLength(content) > MAX_BYTES) throw new Error("That's over 8 MB; keep artifacts smaller.");
    if (a.kind === "link") a = { ...a, kind: /^\s*</.test(content) ? "html" : "markdown" };
    const next = { ...a, version: a.version + 1, updatedAt: now() };
    mkdirSync(join(DIR, a.id), { recursive: true });
    writeFileSync(join(DIR, a.id, `v${next.version}.${ext(next.kind)}`), content);
    this.#store.commit(`artifact:${a.id}`, [{ type: "artifact.upserted", artifact: next }]);
    return next;
  }

  content(id: string, version?: number): { artifact: Artifact; content: string; version: number } {
    const a = this.#require(id);
    const v = version && version >= 1 && version <= a.version ? version : a.version;
    if (!v) throw new Error("Nothing is stored for this artifact yet.");
    return { artifact: a, content: readFileSync(join(DIR, a.id, `v${v}.${ext(a.kind)}`), "utf8"), version: v };
  }

  delete(id: string) {
    rmSync(join(DIR, id), { recursive: true, force: true });
    this.#store.commit(`artifact:${id}`, [{ type: "artifact.deleted", artifactId: id }]);
  }

  #require(id: string): Artifact {
    const a = this.#store.getArtifact(id) ?? this.#store.listArtifacts().find((x) => x.id.startsWith(id) && id.length >= 6);
    if (!a) throw new Error(`No artifact ${id}.`);
    return a;
  }

  /** GET /av/<key>/<version>: the page itself, sandboxed. Returns false if the URL isn't one of these. */
  serve(req: IncomingMessage, res: ServerResponse): boolean {
    const m = (req.url ?? "").match(/^\/av\/([0-9a-f]{36})(?:\/(\d+))?(?:\?.*)?$/);
    if (!m || req.method !== "GET") return false;
    const a = this.#store.listArtifacts().find((x) => x.key === m[1]);
    if (!a || !a.version || a.kind !== "html") {
      res.writeHead(404).end();
      return true;
    }
    const { content } = this.content(a.id, m[2] ? Number(m[2]) : undefined);
    res.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      // Its own opaque origin: scripts run, but can't read Bullpen's storage or call its server.
      "content-security-policy": "sandbox allow-scripts allow-forms allow-popups allow-modals allow-downloads",
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
    });
    res.end(content);
    return true;
  }

  // ---------------------------------------------------------------- claude.ai

  /** List your claude.ai artifacts and add/refresh them here. Concurrent calls share one run. */
  sync(): Promise<SyncResult> {
    this.#syncing ??= this.#sync().finally(() => (this.#syncing = undefined));
    return this.#syncing;
  }

  async #sync(): Promise<SyncResult> {
    const started = now();
    let results: string[];
    try {
      results = await artifactTool(
        'Call the Artifact tool with action "list", scope "all" and limit 50. If the result says more exist, call it again with that page_token, ' +
          "at most 3 calls in all. Then reply with just: done.",
        ["list"],
      );
    } catch (err) {
      this.lastSync = { at: started, ok: false, error: (err as Error).message, added: 0, updated: 0, total: 0 };
      return this.lastSync;
    }
    const found = results.flatMap(parseList);
    if (!found.length && !results.some((r) => /artifacts? \(|no (published )?artifacts/i.test(r))) {
      const why = results.join(" ").slice(0, 300) || "Claude Code didn't return a list (is the Artifact tool available on your plan?).";
      this.lastSync = { at: started, ok: false, error: why, added: 0, updated: 0, total: 0 };
      return this.lastSync;
    }
    const existing = new Map(this.#store.listArtifacts().filter((a) => a.source === "claude").map((a) => [a.url, a]));
    let added = 0;
    let updated = 0;
    for (const f of found) {
      const prev = existing.get(f.url);
      if (!prev) {
        added++;
        const a: Artifact = {
          id: randomUUID(),
          source: "claude",
          title: f.title,
          kind: "link",
          url: f.url,
          owner: f.owner,
          version: 0,
          key: randomBytes(18).toString("hex"),
          // claude.ai doesn't say when shared ones changed: sort them last rather than as brand new.
          createdAt: f.updated ?? UNDATED,
          updatedAt: f.updated ?? UNDATED,
        };
        this.#store.commit(`artifact:${a.id}`, [{ type: "artifact.upserted", artifact: a }]);
      } else if (prev.title !== f.title || (f.updated && f.updated.slice(0, 10) !== prev.updatedAt.slice(0, 10) && prev.version === 0)) {
        updated++;
        this.#store.commit(`artifact:${prev.id}`, [
          { type: "artifact.upserted", artifact: { ...prev, title: f.title, owner: f.owner, updatedAt: f.updated ?? prev.updatedAt } },
        ]);
      }
    }
    this.lastSync = { at: started, ok: true, added, updated, total: found.length };
    this.#store.commit("settings", [{ type: "setting.upserted", key: "artifacts.lastSync", value: this.lastSync }]);
    return this.lastSync;
  }


}

export interface SyncResult {
  at: string;
  ok: boolean;
  error?: string;
  added: number;
  updated: number;
  total: number;
}

/**
 * Run a tiny headless Claude Code session whose only allowed tool is Artifact (with only the given actions), and
 * return the tool results' text. Uses your Claude Code sign-in.
 */
async function artifactTool(prompt: string, actions: string[]): Promise<string[]> {
  const out: string[] = [];
  const q = query({
    prompt,
    options: {
      model: SYNC_MODEL,
      maxTurns: 6,
      cwd: HOME,
      permissionMode: "default",
      settingSources: [],
      canUseTool: async (name, input) =>
        name === "Artifact" && actions.includes(String(input.action))
          ? { behavior: "allow", updatedInput: input }
          : { behavior: "deny", message: "Only reading your artifact list is allowed here." },
    },
  });
  let sawTool = false;
  for await (const m of q) {
    if (m.type === "system" && m.subtype === "init" && !m.tools.includes("Artifact")) {
      q.close();
      throw new Error(
        "Claude Code only lets the Claude desktop app read your claude.ai artifacts, so Bullpen can't sync them. Use Import to bring one in (paste its page, or drop the file).",
      );
    }
    if (m.type === "user" && Array.isArray(m.message.content)) {
      for (const b of m.message.content) {
        if (b.type !== "tool_result") continue;
        sawTool = true;
        out.push(typeof b.content === "string" ? b.content : (b.content ?? []).map((c) => ("text" in c ? c.text : "")).join("\n"));
      }
    }
    if (m.type === "result" && m.subtype !== "success" && !sawTool) throw new Error(`Claude Code: ${m.subtype}`);
  }
  return out;
}

/** "- (mine) Title — https://claude.ai/artifact/X — updated 2026-11-18" */
export function parseList(text: string): Array<{ title: string; url: string; owner: "mine" | "shared"; updated?: string }> {
  const rows: Array<{ title: string; url: string; owner: "mine" | "shared"; updated?: string }> = [];
  for (const line of text.split("\n")) {
    const m = line.match(/^\s*-\s*(?:\((mine|shared)\)\s*)?(.+?)\s+[—-]\s+(https:\/\/claude\.ai\/(?:code\/)?artifact\/[\w-]+)(?:\s+[—-]\s+updated\s+([\d-T:.Z]+))?/);
    if (!m) continue;
    rows.push({ owner: m[1] === "shared" ? "shared" : "mine", title: m[2].trim(), url: m[3], updated: m[4] ? new Date(m[4]).toISOString() : undefined });
  }
  return rows;
}
