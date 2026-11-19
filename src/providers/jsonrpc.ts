// Newline-delimited JSON-RPC with an agent process over stdio, shared by the Codex and ACP engines: our requests
// and their answers, the agent's own requests (approvals, file reads) and its notifications.

import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";

type Json = Record<string, any>;

export class JsonRpc {
  readonly #proc: ChildProcessWithoutNullStreams;
  readonly #version: boolean;
  #nextId = 1;
  readonly #calls = new Map<number, { resolve: (v: Json) => void; reject: (e: Error) => void }>();

  constructor(
    proc: ChildProcessWithoutNullStreams,
    handlers: { request: (id: number | string, method: string, params: Json) => void; notification: (method: string, params: Json) => void },
    /** Send `"jsonrpc": "2.0"` on every message (ACP does; Codex's app-server doesn't need it). */
    opts: { jsonrpcField?: boolean } = {},
  ) {
    this.#proc = proc;
    this.#version = Boolean(opts.jsonrpcField);
    createInterface({ input: proc.stdout }).on("line", (line) => {
      let msg: Json;
      try {
        msg = JSON.parse(line);
      } catch {
        return;
      }
      if (msg.method && msg.id !== undefined) return handlers.request(msg.id, msg.method, msg.params ?? {});
      if (msg.method) return handlers.notification(msg.method, msg.params ?? {});
      const call = this.#calls.get(msg.id);
      if (!call) return;
      this.#calls.delete(msg.id);
      if (msg.error) call.reject(new Error(msg.error.message ?? JSON.stringify(msg.error)));
      else call.resolve(msg.result ?? {});
    });
  }

  write(msg: Json) {
    if (this.#proc.stdin.writable) this.#proc.stdin.write(`${JSON.stringify(this.#version ? { jsonrpc: "2.0", ...msg } : msg)}\n`);
  }

  notify(method: string, params?: Json) {
    this.write(params ? { method, params } : { method });
  }

  request(method: string, params: Json): Promise<Json> {
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      this.#calls.set(id, { resolve, reject });
      this.write({ id, method, params });
    });
  }

  /** The process is gone: every call waiting for an answer fails with this reason. */
  rejectAll(reason: string) {
    for (const c of this.#calls.values()) c.reject(new Error(reason));
    this.#calls.clear();
  }
}
