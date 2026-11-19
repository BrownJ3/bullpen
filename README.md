# Bullpen

**A home for long-running coding agents.** Keep a bench of specialists (a reviewer, a debugger, a project lead)
that remember their work, call them into any project with an `@mention`, and let a lead run a whole team on a goal
while you watch from one window.

Bullpen runs on your Mac (or Linux box), drives **Claude Code** and **Codex** with the sign-ins you already have, and
keeps everything local.

```bash
curl -fsSL https://raw.githubusercontent.com/BrownJ3/bullpen/main/install.sh | sh
```

---

## Contents

- [What it does](#what-it-does)
- [Install](#install)
- [Getting started](#getting-started)
- [Agents](#agents)
- [Teams](#teams)
- [Jobs and lessons](#jobs-and-lessons)
- [The workspace](#the-workspace)
- [Permissions](#permissions)
- [Remote access and other engines](#remote-access-and-other-engines)
- [Command line](#command-line)
- [Security](#security)
- [Development](#development)
- [Acknowledgments](#acknowledgments)

## What it does

| | |
|---|---|
| **Agents that remember** | Named specialists, each with its own instructions, memory file and one ongoing conversation. Call one into any chat with `@name`. |
| **Teams** | `@lead <goal>` plans the work, hands tasks to specialists in parallel, reviews each one and reports back. |
| **Jobs** | Agents that run on a schedule or on new commits, and tell you only what needs you. |
| **Lessons** | Correct an agent once, approve the lesson, and it remembers in every project. |
| **Branches** | Run a chat or each team task in its own git worktree; merge when you're happy. |
| **Undo** | Every turn is checkpointed. Undo restores the files *and* rewinds the conversation. |
| **Workspace** | Terminal, file tree, a real browser, and a live Team panel beside every chat. |
| **Dictation** | Speak instructions into the message box. |
| **Your history** | Imports the projects and recent chats you already have in Claude Code and Codex. |

## Install

Paste this into Terminal:

```bash
curl -fsSL https://raw.githubusercontent.com/BrownJ3/bullpen/main/install.sh | sh
```

The installer:

- uses your Node 24+, or downloads a private copy to `~/.bullpen/node` and verifies its checksum
- puts the latest release in `~/.bullpen/app`, starts it at login, and adds the `bullpen` command and a Bullpen app
- opens Bullpen in your browser when it's done

**You also need** at least one engine, signed in: [Claude Code](https://docs.anthropic.com/en/docs/claude-code)
(`claude`) or [Codex](https://github.com/openai/codex) (`codex`). The installer tells you if neither is found.

**Updating:** click **Update to …** in the sidebar when a release is out, or run `bullpen update`. Updates wait for
running agents to finish their step.

**Uninstalling:** `bullpen uninstall` removes the service and command; your chats and agents stay in `~/.bullpen`.

## Getting started

1. **Open Bullpen** (`bullpen`, or the Bullpen app). On first run it finds folders you've used with Claude Code or
   Codex and offers to add them, along with their recent chats, which continue the same session when you reply.
2. **Start a chat** with **New chat** (⌥N): pick a project, describe the work, press Enter.
3. **Add agents** with **+** next to *Agents*. Pick from the gallery (Code Reviewer, Debugger, Architect, Project
   Lead, …) or make your own.
4. **Bring one in** by typing `@` in any chat: `@code-reviewer look at the last change`.
5. **Hand off a goal** to a lead: `@lead make the checkout flow work on mobile`, then open the Team panel (⌘⇧M).

## Agents

An agent is a long-running specialist that lives in the sidebar. Each one has:

- a **name** and **@handle** (`Rock RMS Expert` becomes `@rock-rms-expert`)
- **instructions**, an engine and model, and a permission level
- **one conversation** that carries its context across every chat it's called into, and across restarts
- a **memory file**, `~/.bullpen/agents/<name>/MEMORY.md`, for notes it wants to keep

Agents aren't tied to a project. When you `@mention` one, it works in *that chat's* project for that request.
Agents can also ask each other (`ask_agent`). When an agent is busy, a second request runs on a spare copy with the
same instructions and memory, instead of waiting in line.

## Teams

Write `@lead <goal>` in a project chat. The lead (any agent with *Can lead a team*; the gallery's Project Lead has it):

1. **Sizes the work.** It can bring in a planner to estimate the effort and suggest how many people to put on it.
2. **Delegates** small tasks (about 10 minutes each) with a clear brief, owner, deliverable and the files each may
   change. Tasks on separate files run **in parallel** (up to 4 at once); dependent tasks wait for what they need.
3. **Hires** more specialists if progress is slow, and splits the remaining work.
4. **Reviews** each submission: accept, or send it back once with every note.
5. **Reports** when everything is accepted, or after each round for open-ended goals ("keep improving until …").

**The Team panel** (⌘⇧M) shows it live: what needs you, who's doing what, a list or board (To do / Working /
In review / Done), the log, and speed. Drag its edge to resize it.

**Built to keep moving:** each task has a 12-minute budget, then submits what's done plus what's left, so nothing is
lost. A stalled goal gets nudged, then flagged. If your plan's usage limit is hit, the team pauses and resumes when
it resets. After a restart, interrupted work picks up where it was. Limits live in `src/limits.ts`.

## Jobs and lessons

**Jobs** are agents that work while you're away: an agent, a project, what to do, and when. That can be daily,
weekdays, every few hours, on new commits to a branch, or only when you press Run. Presets include nightly tests and
fixes, reviewing new commits, and a weekly dependency check. Each run ends with a summary. Anything that needs your
decision raises a notification and shows on **Home**, along with a morning briefing.

**Lessons** come from your corrections. When you say "no, we always …" or "from now on …", the agent proposes a
one-line rule. You approve or edit it on Home, and from then on that agent follows it in every project. You can
also add lessons yourself, for one agent or for all of them.

## The workspace

Everything opens from the **panels** button at the top right of a chat:

| Panel | Shortcut | What it is |
|---|---|---|
| Team | ⌘⇧M | Live status of the chat's team |
| Files | ⌘⇧E | The project's file tree with previews; Mention, Reveal and Open |
| Terminal | ⌃\` | Real shells in the project folder; they keep running when you close the page |
| Browser | ⌘⇧B | The project's site: its dev server, or its static `index.html`. Switch to a live headless Chrome to load any site, shared with the agent |

**Under the message box** you choose where the chat works (your folder, or a separate branch) and what agents may do
there. The 🎙 button dictates.

**Branches.** Start a chat *in a separate copy*, or move one later. It works in its own git worktree on
`bullpen/<name>`, and your checkout isn't touched until you **Merge**. The same menu brings in the latest base,
opens a pull request, or removes the copy. Team tasks get their own worktrees too, and are merged back when accepted.

**Artifacts.** Agents can publish HTML pages and Markdown reports (`create_artifact`), with every version kept.
You can also import artifacts you made on claude.ai. They're listed under **Artifacts** in the sidebar.

**Other shortcuts:** ⌘K search and jump · ⌥N new chat · ⌥⇧N new project · ⌘1 Home · ⌘2 Teams · ⌘[ / ⌘] back and forward · ⌘\\ toggle sidebar.

## Permissions

Each project has one access level, and every agent working there follows it:

| Level | Agents may, without asking |
|---|---|
| **Ask first** (default) | read; everything else asks |
| **Build automatically** | edit files in the project, and run tests, builds, linters, git read-only commands and the project's own scripts. They can also start a local server, `curl` localhost and stop their own processes. |
| **Full access** | anything. Use it for throwaway projects |

Approvals appear in the chat and on Home. The menu on the access chip explains *why* a level applies. The rules for
"Build automatically" are in `src/team-policy.ts` and tested by `node scripts/policy-test.ts`.

## Remote access and other engines

**Use it from your phone or another computer:**

```bash
bullpen remote on          # over Tailscale (recommended)
bullpen remote on --lan    # same Wi-Fi, unencrypted
bullpen remote ssh         # print an SSH tunnel command
bullpen remote reset       # new device token: every other device is signed out
bullpen remote off
```

The phone button in the sidebar shows a QR code to pair a device.

**Other engines.** Besides Claude Code and Codex, any [ACP](https://agentclientprotocol.com) agent works. Gemini CLI,
OpenCode, Goose and Qwen Code show up automatically when installed. Add others in `~/.bullpen/engines.json`:

```json
[{ "id": "my-agent", "name": "My Agent", "command": "my-agent", "args": ["--acp"] }]
```

## Command line

| Command | |
|---|---|
| `bullpen` | Open Bullpen (starts the server if needed) |
| `bullpen start` / `stop` / `status` / `logs` | Control the background service |
| `bullpen restart [--now]` | Restart; waits for running agent steps unless `--now` |
| `bullpen update` | Update to the newest release |
| `bullpen version` | Show the installed version |
| `bullpen remote …` | Remote access (above) |
| `bullpen uninstall` | Remove the service and command (keeps your data) |

## Security

- The server listens on `127.0.0.1:4773` only, and every connection needs the token in `~/.bullpen/token`
  (readable only by you). It checks `Host` and `Origin`, so other web pages can't reach it.
- Remote devices use a separate token, which `bullpen remote reset` revokes.
- Previewed sites and artifacts run sandboxed on a separate origin, so their scripts can't reach Bullpen.
- Agents run commands as you. Keep **Ask first** unless you trust the task. The agent browser can open any site.

## Development

Node 24+ runs the TypeScript directly; there's no build step.

```bash
git clone https://github.com/BrownJ3/bullpen && cd bullpen
npm install
npm run install-app      # optional: run this checkout as your `bullpen`
npm run server           # or run it in the foreground
```

A checkout on a branch updates from its branch instead of releases.

**How it's built.** The server (`src/server.ts`) keeps every change as an event in SQLite (`src/store.ts`).
Commands go through `src/orchestrator.ts`, and engines plug in as adapters (`src/providers/`: `claude.ts` uses
the Claude Agent SDK, `codex.ts` uses `codex app-server`, `acp.ts` covers everything else). Each turn is snapshotted
into hidden git refs (`src/checkpoints.ts`). Teams are `src/team.ts`, and the web UI is plain JavaScript in `ui/`.
`docs/t3code-harness-architecture.md` describes the design this started from.

**Adding an engine:** implement `ProviderAdapter` from `src/types.ts` and register it in `src/server.ts`.

**Tests** (each starts its own throwaway server):

```bash
node scripts/policy-test.ts        # permission rules, no agents
node scripts/worktrees-smoke.ts    # branches, no agents
node scripts/acp-smoke.ts          # ACP engine against a mock agent
node scripts/smoke.ts <repo> [claude|codex]   # one real turn
node scripts/team-smoke.ts         # teams end to end (uses real agents)
```

Also `agents-smoke`, `branch-smoke`, `tools-smoke`, `jobs-smoke` and `loops-smoke` in `scripts/`.

**Releasing:** bump `version` in `package.json`, commit, then `git tag vX.Y.Z && git push origin main --tags`.
Installs pick up the newest `v*` tag.

## Acknowledgments

Bullpen's design draws on [T3 Code](https://github.com/pingdotgg/t3code) by Ping.gg (event-sourced orchestration,
provider adapters, checkpoints, worktrees and the workspace layout), and on AgentOffice's delegate, review and
report loop for teams. Bullpen is an independent implementation and isn't affiliated with either.

## License

[MIT](LICENSE)
