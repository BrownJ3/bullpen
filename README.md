# Bullpen

A home for long-running coding agents you can call into any problem. Built on the architecture of T3 Code
(see `docs/t3code-harness-architecture.md`).
It drives Claude Code (through the Claude Agent SDK) or Codex (through `codex app-server`), stores everything as events in SQLite, snapshots your
repo into hidden git refs every turn, and talks to clients over a local WebSocket.

Requires Node 24+ (runs `.ts` directly, no build) and a logged-in `claude` and/or `codex` CLI; it uses your existing logins.
The Codex binary is found via `BULLPEN_CODEX_BIN`, then `PATH`, then the copy T3 Code downloads to `~/.t3/tools/codex`.

```bash
npm install
npm run install-app            # once: starts at login, adds `bullpen` to your PATH and a bullpen app

bullpen                   # open the web UI (starts the server if needed), from any folder
bullpen stop              # also: start, restart, status, logs, uninstall
```

Without `install-app`, `npm run open` / `npm run stop` do the same from this folder. The web UI has a
"Stop server" link at the bottom of the sidebar.

Lower-level commands:

```bash
npm run server                 # run the server in the foreground: http+ws on 127.0.0.1:4773, data in ~/.bullpen
npm run client -- chat --cwd /path/to/repo                       # Claude
npm run client -- chat --cwd /path/to/repo --provider codex --model gpt-6-astra   # Codex
npm run client -- list
npm run client -- chat <threadId>   # reopen; the Claude session resumes
```

In chat: type a message; answer approvals with `a` / `s` / `d` / `c`; `/interrupt`, `/diff [from] [to]`,
`/rollback <n>`, `/quit`.

## Teams

A **lead** (any agent with "Can lead a team" ticked; the Project Lead in the gallery has it) turns a goal into
tracked work for specialists. Modeled on AgentOffice: delegate → submit → one-round review → report.

1. **Start:** in a project thread, write `@lead <goal>`. Other @names in that message are suggestions for the lead,
   not separate requests. Mention the lead again any time to steer it.
2. **Plan:** the lead reads the project and calls `delegate` for each piece: one owner, a self-contained brief,
   the deliverable, the files it may change, and `depends_on` for tasks that need another's result. Small requests
   get answered directly, with no team.
3. **Work:** tasks run in the project in parallel (up to 3 at once), each on the owner's own long-running session.
   Dependent tasks start when what they wait on is accepted, and get those results in their brief.
4. **Review:** each submission wakes the lead, which accepts it or sends it back **once** with every note in one
   message; after that it fixes small leftovers itself. Wake-ups are reason-tagged and batched; nobody holds a turn
   open waiting for someone else.
5. **Report:** when everything is accepted, the lead checks the whole and calls `finish_goal`; the report is posted
   in the thread (and handed to the thread's own agent on your next message).

**The team card** in the thread shows every task (owner, status, elapsed time, submission, review notes, files
touched), as a list or a board (To do / Working / In review / Done), with Watch links, Retry and Stop. The
sidebar shows a working dot for threads with a team and a badge when one needs you.

**Team mode (permissions):** team tasks and the lead's goal turns may edit files inside the project and run safe
commands (tests, builds, type checks, linters, git status/diff/log, read-only inspection, including loops and
pipes of those) without asking. Installs, pushes, deletes, writes by shell redirection, network commands and
anything outside the project still ask; those approvals appear right on the team card. The rules are in
`src/team-policy.ts`.

**Guardrails** (`LIMITS` in `src/team.ts`): 12 tasks per goal, 3 in parallel, 20 minutes per task, one automatic
retry then **parked** (with a Retry button), one send-back per task, 30 lead turns per goal, duplicate tasks
refused, and `ask_agent` blocked for leads during a goal so work always goes through `delegate`. A sweep every
30 seconds nudges a goal where nothing is moving, then marks it **Needs you**. If your plan's usage limit is hit,
the team **pauses** and resumes when the limit resets. After a server restart, interrupted tasks are requeued.

`scripts/team-smoke.ts` runs three scenarios end to end: a parallel team with a dependent check, a one-round
send-back, and stopping a team mid-way.

## Projects

The sidebar groups threads under **projects**, the folders you work in (modeled on T3 Code's folder mode).
Starting a thread in a folder adds it as a project.

**Choosing what shows.** The ☰ button next to Projects opens a list of every project folder Bullpen can
find: in `~/Documents`, anywhere in your home folder (`~/*` and the usual code folders such as `~/code`,
`~/dev`, `~/Desktop`), and any folder you've used Claude Code in. Tick the ones you want in the sidebar;
unticked ones are **archived** (hidden, never deleted). **Add a folder…** adds one from anywhere.

**Pinning and archiving.** Hover a project for ☆ (pin), + (new thread) and ⋯ (menu: pin, archive, copy
path, remove), or right-click it. Pinned projects stay at the top, marked ★; the rest are ordered by when
you last worked in them. Archived projects collapse into "Archived (N)" at the bottom; starting a thread in
one brings it back.

Each project shows its own favicon or logo if it has one, otherwise a monogram. A collapsed project shows a
dot when a thread inside needs you. Click a project with no threads (or +) to start work there; the start
screen lists that folder's recent **Claude Code sessions**, and "Resume" continues one in Bullpen with its
full history (earlier messages aren't shown in the thread).

## Terminal and files

Each thread has a **Terminal** drawer and a **Files** panel (buttons at the top right; ⌃\` and ⌘⇧E), as in T3 Code.

- **Terminal:** real shells (`node-pty`, your login shell) running in the thread's project folder, shown with
  xterm.js. Open several as tabs. Shells live on the server: closing or reloading the page keeps them running,
  and reopening replays recent output. Drag the top edge to resize.
- **Files:** the project's folder tree, loaded as you expand it. Git-ignored files are dimmed, as in T3. Click a
  file to preview it (text with line numbers, images); **Mention** adds its path to your message, **Reveal** shows
  it in Finder, **Open** opens it in its default app. Everything stays inside the project folder.

`node-pty` is a native module; its install script is allowed in `package.json` (`allowScripts`). If shells fail
with "posix_spawnp failed", Bullpen makes its helper executable at startup.

## Browser

The **Browser** panel (⌘⇧B) previews a project's site next to the conversation. Its start page lists:

- **Running in this project:** local web servers started from the project's folder (found with `lsof`).
- **Start a dev server:** `npm run dev`/`start`/`preview` (or pnpm/yarn/bun) from `package.json`. Bullpen runs it
  in a new terminal tab and opens the page as soon as the server is listening.
- **Static site:** an `index.html` (root, `public/`, `dist/`, `build/`, `docs/`), served read-only by Bullpen on the
  next port (4774), a separate origin, so the site's scripts can't reach Bullpen.
- Other web servers running on this Mac.

There's an address bar (`3000` means `localhost:3000`), back/forward, reload, Fit/Tablet/Phone widths, and ↗ to open
in your real browser. The page is sandboxed and can't navigate or script Bullpen. Unlike T3's Electron/server-side
browser, this is an embedded page: local sites work, but many public sites refuse to be shown inside another page.

## Named agents

**Adding agents.** The + next to Agents opens a gallery of ready-made specialists: Code Reviewer, Architect,
Debugger, Test Writer, Security Reviewer, Docs Writer, Refactorer, Planner, Researcher, UX Critic,
SQL & Data, Git Helper (defined in `src/agent-templates.ts`). "Add" creates one immediately; "Customize first…"
opens it in the form. "Create your own…" starts from a blank form.

**Names.** Name an agent anything ("Rock RMS Expert ⛪"). Its **@handle**, used in mentions and `ask_agent`, is
made from the name (`@rock-rms-expert`) and can be edited; duplicates get `-2`, `-3`. Both can be changed
later from the agent's Edit dialog.

Agents are long-running specialists that live in the web UI's sidebar. Each has a name, a one-line
description, instructions, a provider and model, and a permission level. Each also keeps one conversation
that carries its context across everything it's pulled into and across restarts.

An agent isn't tied to a project. It has its own folder, `~/.bullpen/agents/<name>/`, holding a `MEMORY.md`
that it reads at the start of a conversation and adds durable notes to. When it's called into a thread,
it works in **that thread's project** for that request. Claude agents get the folder added to their
session; Codex agents switch their working folder for the turn. The conversation stays the same.

- **Talk to it directly:** click it in the sidebar. There's no project then, so it just answers, or
  works on paths you name.
- **Bring it into a problem:** in any thread, write `@name …`. The agent gets the recent conversation
  plus your message, and its answer is posted in that thread. A message with an @mention goes only to
  the mentioned agents; the thread's own agent is handed their answers at the start of your next message.
- **Let agents call agents:** every session gets two harness tools, `list_agents` and `ask_agent(agent, question)`
  (an in-process MCP server for Claude, Codex dynamic tools for Codex). The call blocks until the agent
  answers, and the consulted agent works in the same project as the caller.

Requests to one agent queue up. A request that would come back to an agent already waiting further up
the chain (A asks B asks A) is refused instead of deadlocking, and chains stop at 3 agents deep. If a
consulted agent needs an approval, the prompt appears in its own thread and the sidebar shows a badge.
"Reset context" starts its conversation over (its memory file stays); edited instructions apply from its
next turn (reset to be certain, since Claude may keep the system prompt it recorded at the start).

Changes an agent makes during an @mention aren't checkpointed in the calling thread; changes made through
`ask_agent` land in the caller's next checkpoint. Each consult is a full agent turn and costs like one;
in testing, a one-line Claude answer cost $0.70–$1.30.

## Layout

| File | T3 equivalent | Role |
|---|---|---|
| `src/types.ts` | `packages/contracts` | Thread / Run / TurnItem projections, domain events, commands, adapter contract |
| `src/providers/claude.ts` | `ClaudeAdapterV2.ts` | `query()` with streaming input; maps SDK messages → TurnItems; parks `canUseTool` on a promise until the user answers |
| `src/providers/codex.ts` | `CodexAdapterV2.ts` | Spawns `codex app-server`; ndjson JSON-RPC (`initialize` → `thread/start` or `thread/resume` → `turn/start`); maps `item/*` notifications → TurnItems; answers `item/*/requestApproval` server requests with the user's decision |
| `src/store.ts` | `EventSink` + `ProjectionStore` | `node:sqlite`; events + projections written in one transaction, published after commit |
| `src/orchestrator.ts` | `OrchestratorV2` + `RunExecutionService` | Commands → events, per-thread lock, provider event ingestion with a stale-run guard, crash recovery |
| `src/checkpoints.ts` | `CheckpointService` + `GitVcsDriver` | Temp-index `write-tree`/`commit-tree` into `refs/bullpen/checkpoints/<thread>/<n>`; diff; restore with an undo ref |
| `src/server.ts` | `ws.ts` | Token-authed WS on 127.0.0.1; snapshot-or-replay subscriptions; 50 ms live batching; slow-client cutoff |
| `src/client.ts` | `client-runtime` | Terminal client keeping a local projection; `ui` opens the web UI |
| `ui/index.html` | `apps/web` | Web UI, no build step: agent/thread sidebar, transcript, approvals, @mention autocomplete, diff and restore |
| `scripts/agents-smoke.ts` | — | Agents test: create, @mention, `ask_agent`, delivery, self-mention: `node scripts/agents-smoke.ts <dir> [threadProvider] [agentProvider]` |
| `scripts/smoke.ts` | — | End-to-end test: `node scripts/smoke.ts <repo> [claude\|codex] [model]` (one real turn) |

## Adding a provider

Implement `ProviderAdapter` from `src/types.ts`: `openSession()` returns `startTurn`, `interruptTurn`,
`respondToRuntimeRequest` and `close`, and calls `emit()` with `turn_item.updated` / `turn.terminal` /
`native_session.updated`. Register it in `server.ts`. `codex.ts` is the template for any agent that speaks JSON-RPC over stdio (e.g. ACP agents).

## Deliberate simplifications vs T3

- No transactional outbox: side effects run in-process after commit. A crash mid-turn marks the run `interrupted` on restart.
- Rollback restores **files only**; the agent's conversation is not rewound.
- Event log is never pruned; subscriptions replay up to 500 missed events, then fall back to a 200-item snapshot.
- Subagent internals are skipped (Claude Task tool, Codex child threads); only top-level items are recorded.
- Codex: the model comes from the thread or `~/.codex/config.toml`. Codex user-input prompts, MCP elicitations and permission-grant requests are refused rather than shown. No cost is reported (app-server only gives token counts).
- Runtime modes for Codex: `approval-required` = `untrusted` + read-only sandbox, `auto-accept-edits` = `on-request` + workspace-write, `full-access` = `never` + no sandbox.
- No MCP server injected into the agent, no worktrees, no remote access.

## Security

The server binds to 127.0.0.1 and requires the token in `~/.bullpen/token` (0600): as a bearer header
from the CLI, or as a WebSocket subprotocol from the web UI, which reads it from the URL fragment that
`npm run client -- ui` opens (fragments never reach the server; the page keeps it in sessionStorage).
Connections must carry this server's own `Host` (blocks DNS rebinding) and, if they have an `Origin`,
this server's own origin (blocks other web pages). The agent can run commands in the thread's
directory, so keep `approval-required` (the default) unless you trust the task.
