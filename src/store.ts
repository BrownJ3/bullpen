// Event-sourced store (T3: EventSink + ProjectionStore), on Node's built-in SQLite.
// commit() appends events and applies projections in ONE transaction, then notifies
// subscribers. Events are full-row upserts, so the projector is a trivial switch.

import { DatabaseSync } from "node:sqlite";
import type { Agent, Checkpoint, Goal, Project, TeamTask, DomainEvent, Run, StoredEvent, Thread, TurnItem } from "./types.ts";

type Listener = (event: StoredEvent) => void;

export class Store {
  readonly #db: DatabaseSync;
  readonly #listeners = new Map<string, Set<Listener>>(); // threadId -> listeners
  readonly #globalListeners = new Set<Listener>();

  constructor(path: string) {
    this.#db = new DatabaseSync(path);
    this.#db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      PRAGMA busy_timeout = 5000;

      CREATE TABLE IF NOT EXISTS events (
        sequence     INTEGER PRIMARY KEY AUTOINCREMENT,
        thread_id    TEXT NOT NULL,
        type         TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      );
      CREATE INDEX IF NOT EXISTS events_thread ON events(thread_id, sequence);

      CREATE TABLE IF NOT EXISTS threads (
        id TEXT PRIMARY KEY, created_at TEXT NOT NULL, payload_json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS runs (
        id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, ordinal INTEGER NOT NULL, payload_json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS turn_items (
        id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL,
        first_sequence INTEGER NOT NULL,  -- stable display order = when the item first appeared
        payload_json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS turn_items_thread ON turn_items(thread_id, first_sequence);
      CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY, path TEXT NOT NULL UNIQUE, payload_json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS goals (
        id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, status TEXT NOT NULL, payload_json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY, goal_id TEXT NOT NULL, payload_json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS tasks_goal ON tasks(goal_id);
      CREATE TABLE IF NOT EXISTS agents (
        id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, payload_json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS checkpoints (
        thread_id TEXT NOT NULL, ordinal INTEGER NOT NULL, payload_json TEXT NOT NULL,
        PRIMARY KEY (thread_id, ordinal)
      );
    `);
  }

  // ---------- write path ----------

  commit(threadId: string, events: DomainEvent[]): StoredEvent[] {
    if (events.length === 0) return [];
    const stored: StoredEvent[] = [];
    const insert = this.#db.prepare("INSERT INTO events (thread_id, type, payload_json) VALUES (?, ?, ?)");
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      for (const event of events) {
        const { lastInsertRowid } = insert.run(threadId, event.type, JSON.stringify(event));
        const sequence = Number(lastInsertRowid);
        this.#project(event, sequence);
        stored.push({ sequence, threadId, event });
      }
      this.#db.exec("COMMIT");
    } catch (err) {
      this.#db.exec("ROLLBACK");
      throw err;
    }
    // Publish only after commit, like T3.
    for (const s of stored) {
      for (const l of this.#listeners.get(threadId) ?? []) l(s);
      for (const l of this.#globalListeners) l(s);
    }
    return stored;
  }

  #project(event: DomainEvent, sequence: number) {
    switch (event.type) {
      case "thread.upserted":
        this.#db
          .prepare(
            `INSERT INTO threads (id, created_at, payload_json) VALUES (?, ?, ?)
             ON CONFLICT(id) DO UPDATE SET payload_json = excluded.payload_json`,
          )
          .run(event.thread.id, event.thread.createdAt, JSON.stringify(event.thread));
        return;
      case "run.upserted":
        this.#db
          .prepare(
            `INSERT INTO runs (id, thread_id, ordinal, payload_json) VALUES (?, ?, ?, ?)
             ON CONFLICT(id) DO UPDATE SET payload_json = excluded.payload_json`,
          )
          .run(event.run.id, event.run.threadId, event.run.ordinal, JSON.stringify(event.run));
        return;
      case "turn-item.upserted":
        this.#db
          .prepare(
            `INSERT INTO turn_items (id, thread_id, first_sequence, payload_json) VALUES (?, ?, ?, ?)
             ON CONFLICT(id) DO UPDATE SET payload_json = excluded.payload_json`,
          )
          .run(event.item.id, event.item.threadId, sequence, JSON.stringify(event.item));
        return;
      case "checkpoint.captured":
        this.#db
          .prepare(
            `INSERT INTO checkpoints (thread_id, ordinal, payload_json) VALUES (?, ?, ?)
             ON CONFLICT(thread_id, ordinal) DO UPDATE SET payload_json = excluded.payload_json`,
          )
          .run(event.checkpoint.threadId, event.checkpoint.ordinal, JSON.stringify(event.checkpoint));
        return;
      case "agent.upserted":
        this.#db
          .prepare(
            `INSERT INTO agents (id, name, payload_json) VALUES (?, ?, ?)
             ON CONFLICT(id) DO UPDATE SET name = excluded.name, payload_json = excluded.payload_json`,
          )
          .run(event.agent.id, event.agent.name, JSON.stringify(event.agent));
        return;
      case "project.upserted":
        this.#db
          .prepare(
            `INSERT INTO projects (id, path, payload_json) VALUES (?, ?, ?)
             ON CONFLICT(id) DO UPDATE SET path = excluded.path, payload_json = excluded.payload_json`,
          )
          .run(event.project.id, event.project.path, JSON.stringify(event.project));
        return;
      case "goal.upserted":
        this.#db
          .prepare(
            `INSERT INTO goals (id, thread_id, status, payload_json) VALUES (?, ?, ?, ?)
             ON CONFLICT(id) DO UPDATE SET status = excluded.status, payload_json = excluded.payload_json`,
          )
          .run(event.goal.id, event.goal.threadId, event.goal.status, JSON.stringify(event.goal));
        return;
      case "task.upserted":
        this.#db
          .prepare(
            `INSERT INTO tasks (id, goal_id, payload_json) VALUES (?, ?, ?)
             ON CONFLICT(id) DO UPDATE SET payload_json = excluded.payload_json`,
          )
          .run(event.task.id, event.task.goalId, JSON.stringify(event.task));
        return;
      case "project.removed":
        this.#db.prepare("DELETE FROM projects WHERE id = ?").run(event.projectId);
        return;
      case "agent.deleted":
        this.#db.prepare("DELETE FROM agents WHERE id = ?").run(event.agentId);
        return;
    }
  }

  // ---------- read path ----------

  getThread(id: string): Thread | undefined {
    const row = this.#db.prepare("SELECT payload_json FROM threads WHERE id = ?").get(id) as
      | { payload_json: string }
      | undefined;
    return row ? JSON.parse(row.payload_json) : undefined;
  }

  listThreads(): Thread[] {
    return this.#rows("SELECT payload_json FROM threads ORDER BY created_at DESC");
  }

  getGoal(id: string): Goal | undefined {
    return this.#rows<Goal>("SELECT payload_json FROM goals WHERE id = ?", id)[0];
  }

  /** Goals not finished yet (planning, working, paused, stuck). */
  openGoals(): Goal[] {
    return this.#rows("SELECT payload_json FROM goals WHERE status IN ('planning','working','paused','stuck')");
  }

  goalsForThread(threadId: string): Goal[] {
    return this.#rows("SELECT payload_json FROM goals WHERE thread_id = ?", threadId);
  }

  listTasks(goalId: string): TeamTask[] {
    return this.#rows<TeamTask>("SELECT payload_json FROM tasks WHERE goal_id = ?", goalId).sort(
      (a, b) => Number(a.ref.slice(1)) - Number(b.ref.slice(1)),
    );
  }

  getTask(id: string): TeamTask | undefined {
    return this.#rows<TeamTask>("SELECT payload_json FROM tasks WHERE id = ?", id)[0];
  }

  /** Pending approval prompts in one thread's run. */
  pendingApprovalsFor(threadId: string, runId: string): TurnItem[] {
    return this.#rows(
      `SELECT payload_json FROM turn_items WHERE thread_id = ?
         AND json_extract(payload_json, '$.kind') = 'approval_request'
         AND json_extract(payload_json, '$.status') = 'pending'
         AND json_extract(payload_json, '$.runId') = ?`,
      threadId,
      runId,
    );
  }

  listProjects(): Project[] {
    return this.#rows("SELECT payload_json FROM projects ORDER BY path");
  }

  getProject(id: string): Project | undefined {
    return this.#rows<Project>("SELECT payload_json FROM projects WHERE id = ?", id)[0];
  }

  getProjectByPath(path: string): Project | undefined {
    return this.#rows<Project>("SELECT payload_json FROM projects WHERE path = ?", path)[0];
  }

  listAgents(): Agent[] {
    return this.#rows("SELECT payload_json FROM agents ORDER BY name");
  }

  getAgent(id: string): Agent | undefined {
    return this.#rows<Agent>("SELECT payload_json FROM agents WHERE id = ?", id)[0];
  }

  getAgentByName(name: string): Agent | undefined {
    return this.#rows<Agent>("SELECT payload_json FROM agents WHERE name = ?", name)[0];
  }

  /** Approval prompts still waiting on the user, for sidebar badges. */
  pendingApprovals(): TurnItem[] {
    return this.#rows(
      `SELECT payload_json FROM turn_items
       WHERE json_extract(payload_json, '$.kind') = 'approval_request'
         AND json_extract(payload_json, '$.status') = 'pending'`,
    );
  }

  /** @mention replies still marked as being worked on. */
  runningReplies(): TurnItem[] {
    return this.#rows(
      `SELECT payload_json FROM turn_items
       WHERE json_extract(payload_json, '$.kind') = 'agent_reply'
         AND json_extract(payload_json, '$.status') = 'running'`,
    );
  }

  /** Items of one run, in display order. */
  listRunItems(threadId: string, runId: string): TurnItem[] {
    return this.#rows(
      `SELECT payload_json FROM turn_items WHERE thread_id = ? AND json_extract(payload_json, '$.runId') = ?
       ORDER BY first_sequence`,
      threadId,
      runId,
    );
  }

  /** @mention replies not yet handed to the thread's own agent. */
  undeliveredReplies(threadId: string): TurnItem[] {
    return this.#rows(
      `SELECT payload_json FROM turn_items WHERE thread_id = ?
         AND json_extract(payload_json, '$.kind') = 'agent_reply'
         AND json_extract(payload_json, '$.status') != 'running'
         AND json_extract(payload_json, '$.delivered') = 0
       ORDER BY first_sequence`,
      threadId,
    );
  }

  listRuns(threadId: string): Run[] {
    return this.#rows("SELECT payload_json FROM runs WHERE thread_id = ? ORDER BY ordinal", threadId);
  }

  getRun(id: string): Run | undefined {
    const row = this.#db.prepare("SELECT payload_json FROM runs WHERE id = ?").get(id) as
      | { payload_json: string }
      | undefined;
    return row ? JSON.parse(row.payload_json) : undefined;
  }

  /** Bounded snapshot: newest `limit` items, returned oldest-first. */
  listTurnItems(threadId: string, limit = 200): TurnItem[] {
    return this.#rows<TurnItem>(
      "SELECT payload_json FROM turn_items WHERE thread_id = ? ORDER BY first_sequence DESC LIMIT ?",
      threadId,
      limit,
    ).reverse();
  }

  getTurnItem(id: string): TurnItem | undefined {
    const row = this.#db.prepare("SELECT payload_json FROM turn_items WHERE id = ?").get(id) as
      | { payload_json: string }
      | undefined;
    return row ? JSON.parse(row.payload_json) : undefined;
  }

  getCheckpoint(threadId: string, ordinal: number): Checkpoint | undefined {
    const row = this.#db
      .prepare("SELECT payload_json FROM checkpoints WHERE thread_id = ? AND ordinal = ?")
      .get(threadId, ordinal) as { payload_json: string } | undefined;
    return row ? JSON.parse(row.payload_json) : undefined;
  }

  latestSequence(threadId: string): number {
    const row = this.#db.prepare("SELECT MAX(sequence) AS s FROM events WHERE thread_id = ?").get(threadId) as {
      s: number | null;
    };
    return row.s ?? 0;
  }

  eventsAfter(threadId: string, afterSequence: number, limit = 1000): StoredEvent[] {
    const rows = this.#db
      .prepare("SELECT sequence, payload_json FROM events WHERE thread_id = ? AND sequence > ? ORDER BY sequence LIMIT ?")
      .all(threadId, afterSequence, limit) as Array<{ sequence: number; payload_json: string }>;
    return rows.map((r) => ({ sequence: r.sequence, threadId, event: JSON.parse(r.payload_json) }));
  }

  subscribe(threadId: string, listener: Listener): () => void {
    let set = this.#listeners.get(threadId);
    if (!set) this.#listeners.set(threadId, (set = new Set()));
    set.add(listener);
    return () => set.delete(listener);
  }

  subscribeAll(listener: Listener): () => void {
    this.#globalListeners.add(listener);
    return () => this.#globalListeners.delete(listener);
  }

  #rows<T>(sql: string, ...params: Array<string | number>): T[] {
    const rows = this.#db.prepare(sql).all(...params) as Array<{ payload_json: string }>;
    return rows.map((r) => JSON.parse(r.payload_json));
  }
}
