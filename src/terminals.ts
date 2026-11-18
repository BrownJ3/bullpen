// Real shells for the terminal drawer (T3: apps/server/src/terminal/Manager.ts + NodePtyAdapter).
// Terminals belong to a thread, run in its project folder, and live on the server: closing or
// reloading the page doesn't kill them, and reattaching replays recent output.

import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import type { IPty } from "node-pty";

const require = createRequire(import.meta.url);
const pty = require("node-pty") as typeof import("node-pty");

/** Scrollback kept for reattaching (T3 keeps a bounded history too). */
const HISTORY_BYTES = 256 * 1024;

// npm may skip node-pty's post-install, leaving its spawn helper non-executable ("posix_spawnp failed").
try {
  const helper = join(dirname(require.resolve("node-pty/package.json")), "prebuilds", `${process.platform}-${process.arch}`, "spawn-helper");
  if (existsSync(helper) && !(statSync(helper).mode & 0o111)) chmodSync(helper, 0o755);
} catch {}

export interface TerminalInfo {
  id: string;
  threadId: string;
  cwd: string;
  title: string;
  exitCode?: number;
  createdAt: string;
}

type Listener = (msg: { data?: string; exitCode?: number }) => void;

interface Terminal extends TerminalInfo {
  pty: IPty;
  history: string;
  listeners: Set<Listener>;
}

export class TerminalManager {
  readonly #terminals = new Map<string, Terminal>();

  open(threadId: string, cwd: string): TerminalInfo {
    const shell = process.env.SHELL || "/bin/zsh";
    const count = [...this.#terminals.values()].filter((t) => t.threadId === threadId).length;
    const proc = pty.spawn(shell, ["-l"], {
      name: "xterm-256color",
      cols: 100,
      rows: 24,
      cwd,
      env: { ...process.env, TERM: "xterm-256color", COLORTERM: "truecolor", TERM_PROGRAM: "Bullpen" } as Record<string, string>,
    });
    const term: Terminal = {
      id: randomUUID(),
      threadId,
      cwd,
      title: `Terminal ${count + 1}`,
      createdAt: new Date().toISOString(),
      pty: proc,
      history: "",
      listeners: new Set(),
    };
    proc.onData((data) => {
      term.history += data;
      if (term.history.length > HISTORY_BYTES) term.history = term.history.slice(-HISTORY_BYTES);
      for (const l of term.listeners) l({ data });
    });
    proc.onExit(({ exitCode }) => {
      term.exitCode = exitCode;
      for (const l of term.listeners) l({ exitCode });
    });
    this.#terminals.set(term.id, term);
    return this.#info(term);
  }

  list(threadId: string): TerminalInfo[] {
    return [...this.#terminals.values()]
      .filter((t) => t.threadId === threadId)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .map((t) => this.#info(t));
  }

  /** Recent output, then live output until the returned function is called. */
  attach(id: string, listener: Listener): { history: string; info: TerminalInfo; detach: () => void } {
    const term = this.#require(id);
    term.listeners.add(listener);
    return { history: term.history, info: this.#info(term), detach: () => term.listeners.delete(listener) };
  }

  write(id: string, data: string) {
    const term = this.#require(id);
    if (term.exitCode === undefined) term.pty.write(data);
  }

  resize(id: string, cols: number, rows: number) {
    const term = this.#require(id);
    if (term.exitCode === undefined && cols > 1 && rows > 1) term.pty.resize(Math.min(cols, 500), Math.min(rows, 200));
  }

  close(id: string) {
    const term = this.#terminals.get(id);
    if (!term) return;
    this.#terminals.delete(id);
    try {
      term.pty.kill();
    } catch {}
  }

  closeAll() {
    for (const id of [...this.#terminals.keys()]) this.close(id);
  }

  #require(id: string): Terminal {
    const term = this.#terminals.get(id);
    if (!term) throw new Error("That terminal is gone (the server may have restarted).");
    return term;
  }

  #info(t: Terminal): TerminalInfo {
    return { id: t.id, threadId: t.threadId, cwd: t.cwd, title: t.title, exitCode: t.exitCode, createdAt: t.createdAt };
  }
}
