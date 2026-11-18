# T3 Code as an AI Harness — Architecture Teardown

Sources: `pingdotgg/t3code` @ `bcb0604` (2026-11-16) and the installed app **T3 Code (Beta) 0.1.6** (commit `2359643`, Electron 44). Paths are repo-relative; `S/` = `apps/server/src`, `C/` = `packages/contracts/src`.

---

## 1. The one-paragraph model

T3 Code does **not** run an agent loop itself. It is a **supervisor** around existing agent runtimes ("providers": Codex, Claude Code, Cursor, OpenCode, any ACP agent…). A single Node server spawns those runtimes as child processes, normalizes everything they emit into one event vocabulary, stores it in an **event-sourced SQLite** database, snapshots the working tree into **hidden git refs** each turn, and streams compact projections to web/desktop/mobile clients over a **WebSocket RPC**. It also injects its own **MCP server** into every agent so agents can call back into the harness (delegate tasks, spawn threads, drive a browser preview).

```
 Clients (web / Electron / React Native)
        │  Effect-RPC over WS  ws://127.0.0.1:3773/ws   (+ HTTP paging)
        ▼
 ┌──────────────────────── T3 server (Node, ELECTRON_RUN_AS_NODE) ───────────────────────┐
 │ commands ─► Orchestrator (pure decider, per-thread lock)                              │
 │               └► EventSink.commitCommand  ── one SQLite txn ──►                       │
 │                     receipt · events · projections · outbox effects                   │
 │ EffectWorker (lease-claims outbox) ─► ProviderSessionManager ─► ProviderAdapterV2     │
 │                                                       │ events stream                 │
 │ ProviderEventIngestor ◄────────────────────────────────┘                              │
 │ CheckpointService (git refs) · Terminals (node-pty) · MCP HTTP /mcp · Worktrees       │
 └───────────────────────────────────────────────────────────────────────────────────────┘
        │ stdio JSON-RPC        │ Agent SDK          │ ndjson JSON-RPC     │ HTTP
     codex app-server      claude (CLI via SDK)    ACP agents          opencode serve
```

---

## 2. Process & packaging (observed on your machine)

| Piece | Detail |
|---|---|
| Electron main | `apps/desktop/dist-electron/boot.cjs` → `main.cjs` |
| Server | `child_process` spawn of the Electron binary with `ELECTRON_RUN_AS_NODE=1` running `apps/server/dist/bin.mjs --bootstrap-fd 3`; bootstrap JSON (incl. token) passed on **fd 3** |
| Port | `127.0.0.1:3773` (HTTP + WS), override `T3CODE_PORT`; LAN/Tailscale modes optional |
| State | `~/.t3/userdata/statev2.sqlite` (WAL). `~/Library/Application Support/t3code-v2` is only Chromium profile junk |
| Tools | Codex is **downloaded by T3** into `~/.t3/tools/codex/<ver>`; `claude` found on PATH (`~/.local/bin/claude`) |
| Logs | `~/.t3/userdata/logs/{server,desktop}.trace.ndjson`, raw provider frames in `logs/provider/events.<uuid>.log` |
| Extras | `t3-resource-monitor` (Rust), node-pty, Cursor SDK natives, playwright-core, CLI shim `~/.t3/bin/t3` |

Same server runs headless via `t3 serve` (that's how SSH remote works).

---

## 3. Provider layer — how it talks to agents

### 3.1 Contract (`packages/provider-core/src/server/`)

Two layers:

- **`ProviderDriver`** (`driver.ts`) → `create()` returns a **`ProviderInstance`**: `snapshot` (status, auth, models — filled by a probe), `refreshModels`, `auth: ProviderAuthController`, `textGeneration`, and the runtime `orchestrationAdapter`.
- **`ProviderAdapterV2`** (`ProviderAdapter.ts`) → `openSession(input) → SessionRuntime`, where `input` carries `threadId`, `modelSelection`, `runtimePolicy {runtimeMode, interactionMode, cwd, approvalPolicy, sandboxPolicy}`, and `resumeFromSession`.

`SessionRuntime` (the important interface):

```ts
events: Stream<ProviderAdapterV2Event>
ensureThread / resumeThread / forkThread / rollbackThread / readThreadSnapshot
startTurn(TurnInput) / steerTurn / interruptTurn
respondToRuntimeRequest({ requestId, decision?, feedback?, answers? })
// optional: injectHistory, compactThread, applyModelSelection, stopSubagent, ...
```

Drivers registered in `S/provider/builtInDrivers.ts`: Codex, Claude, Cursor, Grok, Fx, OpenCode, Antigravity, Kiro, Pi, Muse, AcpRegistry. Big adapters live in `S/orchestration-v2/Adapters/` (`ClaudeAdapterV2.ts` is ~14.5k lines).

### 3.2 Per-runtime wiring

| Runtime | Transport | Key calls |
|---|---|---|
| **Codex** | spawn `codex app-server -c thread_unload_delay_secs=0` ; **newline-delimited JSON-RPC over stdio** (`packages/effect-codex-app-server`, typed from generated schema) | `initialize` → `thread/start` / `thread/resume` / `thread/fork` → `turn/start`, `turn/steer`, `turn/interrupt`. Notifications: `item/agentMessage/delta`, `item/started`, `item/completed`, `turn/plan/updated`, `turn/diff/updated`, `thread/tokenUsage/updated`, `turn/completed`. Server→client requests: `item/commandExecution/requestApproval`, `item/fileChange/requestApproval`, … |
| **Claude Code** | **`@anthropic-ai/claude-agent-sdk` `query()`** with streaming input (a queue of `SDKUserMessage`); SDK spawns the `claude` CLI (T3 overrides spawn to own the process group) | Options: `model`, `permissionMode`, `includePartialMessages`, `resume`/`resumeSessionAt`, `canUseTool`, `onElicitation`, `mcpServers`, `systemPrompt: {preset:"claude_code", append: <T3 instructions>}`. Interrupt = `query.interrupt()`. History/fork via a separate worker process (`S/claudeHistoryWorker.ts`) |
| **ACP agents** | ndjson JSON-RPC over stdio (`packages/effect-acp`, `packages/provider-acp`) | `initialize`, `authenticate`, `session/new`, `session/load`/`resume`, `session/prompt`, `session/cancel`, `session/request_permission`; T3 serves client-side `fs/*`, `terminal/*`. Agents installable from the public ACP registry (binary / npx / uvx) |
| **OpenCode** | spawns `opencode serve` on a local port, talks HTTP via its SDK | — |
| **Cursor** | in-process `@cursor/sdk` | resume by `agentId` |

Per-agent ACP customisation is a small "flavor" object (`AcpAdapterV2Flavor`: `makeRuntime`, `normalizeSessionUpdate`, `capabilities`…), so new ACP agents are cheap.

### 3.3 Normalized event vocabulary

Adapters emit `ProviderAdapterV2Event`:
`provider_session.updated`, `provider_thread.updated`, `provider_turn.updated`, `node.updated`, `subagent.updated`, `message.updated`, **`turn_item.updated`**, `runtime_request.updated`, `plan.updated`, `command_output.delta` (not persisted), `turn.terminal` (completed / interrupted / cancelled / failed+retry).

Most content is `turn_item.updated` carrying a **TurnItem** (`C/orchestrationV2.ts`):
`user_message`, `assistant_message` (streaming flag), `reasoning`, `command_execution`, `file_change`, `file_search`, `web_search`, `dynamic_tool`, `approval_request`, `user_input_request`, `todo_list`, `proposed_plan`, `checkpoint`, `subagent`, `compaction`, `handoff`, `fork`, `error`, `notification`, …

Streaming text = re-emit the same item with `streaming: true` (full upsert, not deltas); a coalescer batches them.

### 3.4 Approval round-trip

1. Native request arrives (Codex `…/requestApproval`, Claude `canUseTool`, ACP `session/request_permission`).
2. Adapter parks a **`Deferred`** keyed by `RuntimeRequestId`, emits `runtime_request.updated` + an `approval_request` turn item.
3. Client renders it; user answers → command `runtime-request.respond { decision: accept | acceptForSession | acceptAlways | decline | cancel }` over WS.
4. Orchestrator persists the resolution + enqueues an outbox effect → `EffectWorker` → `RuntimeRequestService` → `session.respondToRuntimeRequest`.
5. Adapter resolves the Deferred and translates back (Codex `{decision}`, Claude `allow/deny`, ACP `optionId`).

Policy: `runtimeMode` (`approval-required`, `auto-accept-edits`, `full-access` — default — and others in `C/providerPolicy.ts`) × `interactionMode` (`default | plan`), capped by an admin ceiling (`S/policy/ManagedPolicy.ts`).

### 3.5 Auth = bring-your-own-subscription

T3 reuses each CLI's existing login: `~/.claude` (or `CLAUDE_CONFIG_DIR`), `CODEX_HOME/auth.json` (watched for external login/logout), ACP `authMethods` (agent / terminal / env var), Cursor browser login or `CURSOR_API_KEY`. Optional T3-managed ChatGPT OAuth for Codex brokers tokens over local IPC.

---

## 4. Orchestration core — event sourcing

**Domain:** Environment → Project → **Thread** → **Run** (= turn) → RunAttempts → ExecutionNode tree (root + subagents). Provider side mirrored as ProviderSession / ProviderThread / ProviderTurn / RuntimeRequest. App IDs are primary; provider-native IDs are just refs (`nativeThreadRef`).

**Commands** (`C/orchestrationV2.ts`): `thread.create`, `message.dispatch` (modes: `start_immediately`, `queue_after_active`, `steer_active`, `restart_active`, `defer_start`), `run.interrupt`, `runtime-request.respond`, `checkpoint.rollback`, `thread.fork`, `provider.switch`, `delegated_task.request`, …

**Write path** (`S/orchestration-v2/EventSink.ts` `commitCommand`) — one SQLite transaction:
1. reserve idempotent command receipt
2. append domain events (`thread.*`, `run.*`, `turn-item.updated`, `checkpoint.captured`, …; most carry the **full row** = upsert semantics)
3. apply projections (`ProjectionStore.ts` reducer → per-entity tables)
4. enqueue **outbox effects** (`provider-turn.start/interrupt/steer`, `runtime-request.respond`, `checkpoint.capture`, `thread-title.generate`, …)
5. publish to in-memory PubSub after commit

`EffectWorker` claims outbox rows by lease and performs the I/O; results flow back as commands/events. Provider events enter via `ProviderEventIngestor` with ownership guards (`writeIfRunCurrent`, `writeIfProviderThreadOwner`) and batching (≤64 events / 1 MiB).

**Pragmatic twist:** the event log is **pruned to ~1 day** — projections are the source of truth, the log is for streaming/catch-up, not full replay.

**Persistence:** `node:sqlite` + Effect SQL, WAL, ~96 migrations. Tables: `orchestration_v2_events`, `…_command_receipts`, `…_effect_outbox`, `orchestration_v2_projection_{threads,runs,run_attempts,nodes,subagents,provider_sessions,provider_threads,provider_turns,runtime_requests,messages,plans,turn_items,checkpoints,…}`, FTS5 trigram `orchestration_v2_message_search`. Rows are `payload_json` + indexed columns. (Your live DB: 25 threads, ~2.6k messages, ~3.3k turn items.)

---

## 5. Checkpoints, diffs, undo

- Each run captures a **baseline** at start and a **checkpoint** at end as hidden git refs:
  `refs/t3/orchestration-v2/checkpoints/<b64(sha256(scope))>/ordinal/<n>`
- Capture uses a **temp `GIT_INDEX_FILE` + temp object dir** → `add` → `write-tree` → `commit-tree` → `update-ref`. User's index/branch untouched.
- Diffs = diff between two refs (`S/checkpointing/CheckpointDiffQuery.ts`).
- Rollback: first `session.rollbackThread` on the provider conversation, then `git restore --source <oid> --worktree --staged` + `git clean -fd`. Providers that can't roll back must refuse before files change.

---

## 6. Client transport

- **Effect RPC over WebSocket** at `/ws`, JSON + permessage-deflate, per-method scope authorization.
- Core methods: `orchestration.dispatchCommand`, `subscribeShell` (sidebar), `subscribeThread`, `subscribeCommandOutput`, `getTurnDiff`, `getFullThreadDiff`, `terminal.*`, `vcs.createWorktree`, `projects.*`.
- **Snapshot + cursor**: `subscribeThread({ threadId, afterSequence })` replays events after the cursor (bounded) or sends a fresh bounded snapshot, then live events.
- Bandwidth discipline: bounded snapshot windows + HTTP history paging, compact/deduped turn items, 50 ms live-event coalescing, per-subscriber caps (1000 items / 8 MiB), terminal flow-control window, unpersisted command-output tail stream.
- Shared client logic lives in `packages/client-runtime` (connection supervisor, reducers) so web/desktop/mobile behave identically.

---

## 7. Harness-side capabilities agents get

- **MCP server injected into every session**: `http://127.0.0.1:<port>/mcp`, with a per-session bearer token scoped to env/thread/session, revoked on release. Codex gets it in `thread/start` config; Claude via `mcpServers["t3-code"]`.
  Toolkits (`S/mcp/toolkits/`): orchestrator (`delegate_task`, `t3_thread_launch/list/read/send/wait/interrupt`, `schedule_task`, `request_secret`), browser preview (`preview_open/act/snapshot`), pull requests, worktrees, devices.
- **Worktrees**: thread launch picks `root | existing_worktree | worktree{baseRef, branch}`; `git worktree add` under `~/.t3/worktrees` + setup script stage.
- **Terminals**: server-owned node-pty, clients attach over RPC.
- **Remote**: same server reachable via LAN, Tailscale, SSH tunnel, or T3 Connect (Clerk identity + Cloudflare tunnel; relay only bootstraps, traffic goes direct). Peer environments can delegate work to each other over `/mcp`.

---

## 8. Blueprint: building your own harness the T3 way

Minimum viable slice, in build order:

1. **Provider adapter interface** — `openSession → { events, startTurn, interruptTurn, respondToRuntimeRequest }`. Start with one runtime:
   - easiest: **Claude Agent SDK `query()`** with streaming input + `canUseTool`, or
   - **`codex app-server`** (stdio JSON-RPC), or
   - any **ACP** agent (one protocol, many agents).
2. **Normalized TurnItem vocabulary** — message, reasoning, command, file_change, tool, approval_request, plan/todo, error, terminal. Upsert by item id; streaming flag instead of deltas.
3. **Approval bridge** — Deferred map keyed by request id; expose `respond(requestId, decision)`.
4. **Persistence** — SQLite with: `events(sequence, thread_id, type, payload_json)`, projection tables, `outbox(lease)`. Commit command → events → projections → outbox in one txn.
5. **Checkpoints** — temp-index `write-tree`/`commit-tree` into `refs/<you>/checkpoints/<thread>/<n>` before and after each turn; diff + restore from those.
6. **WS API** — `dispatchCommand` + `subscribeThread(afterSequence)` returning snapshot-then-events.
7. **Your own MCP server** injected into each session for harness tools (spawn sub-threads, ask user, open browser).

Things worth copying deliberately: app-owned IDs with provider IDs as refs; full-row upsert events; outbox for all side effects; hidden git refs for undo; bounded snapshots. Things you can skip early: event replay (T3 prunes anyway), multi-surface, remote relay, managed policy.
