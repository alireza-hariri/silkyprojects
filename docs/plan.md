# Silky — Plan

Builds on [idea.md](idea.md) and [notes/suggestions.md](notes/suggestions.md).

## 1. Architecture

```
Telegram ──► silky daemon (Node/TS, grammY)
               ├─ Router: plain text → active agent, "/..." → command
               ├─ Store: PROJECTS_DIR/.silky (JSON files)
               ├─ Reconciler: folders + .silky + tmux → consistent state
               ├─ Runner: one `pi --mode json` process per prompt, inside the agent's tmux window
               └─ Manager: pi SDK session in-process, cwd = PROJECTS_DIR, silky tools
```

### How an agent runs (JSON mode)

An agent is **not** a long-lived process. It is a name, a tmux window and a pi session ID.
Each user message starts a single run:

1. The bot writes the prompt to `.silky/projects/<p>/agents/<a>/prompt.md`.
2. The bot sends the `silky-run <p> <a>` command to the agent's tmux window. That script runs
   `pi --mode json [--session <sid>] <prompt> | tee -a runs/<ts>.jsonl | silky-pretty`
   and writes `runs/<ts>.exit` when it finishes.
3. The bot tails `runs/<ts>.jsonl`:
   - `session` header → store `sessionId`. This only matters for the first run or after `/clear`.
   - `tool_execution_start` → log it. If the agent is active, show a short status line.
   - `agent_end` / the last `message_end` → the final answer.
4. Idle state is a plain shell prompt in the tmux window. Attaching shows a readable log of
   every run, because the output goes through `silky-pretty`.

This model survives a bot restart. tmux keeps the run going, the output is in a file, and the
bot resumes tailing from the byte offset it saved.

## 2. `.silky` layout

```
PROJECTS_DIR/.silky/
  state.json                 # { gateways: { telegram: { ownerId, chatId, active } } }
                             #   active = {mode:"manager"} | {mode:"agent", project, agent}
  manager/                   # manager pi session files
  projects/<project>/
    project.json             # { tmuxSession, nextAgentNum }
    agents/<project>-agent-<n>/
      agent.json             # { window, sessionId|null, status: idle|running, lastRun, unread }
      prompt.md
      runs/<ts>.jsonl, <ts>.exit, <ts>.offset
  archive/<ts>-<project>/... # archived projects and agents, moved here as they were
```

Rules:
- Every subfolder of `PROJECTS_DIR` that isn't a dotfolder is a project.
- A folder with no metadata is a valid project with **zero agents**.
- Metadata whose folder is gone means the project was deleted. Move its metadata to `archive/`
  and kill its tmux session.
- Nothing else writes to `.silky`, so no locking beyond a single in-process write queue.
- Agent names are `<project>-agent-<n>`. `n` comes from `nextAgentNum` and is never reused,
  so archived names can't collide with new ones.
- The tmux session name is the project name with characters outside `[A-Za-z0-9_-]` replaced
  by `_`.

## 3. Reconcile (on startup, and before each command that touches a project)

1. Scan the folders and apply the rules above.
2. For each agent, make sure the tmux session and window exist. Recreate any that are missing
   as an idle shell in the project folder.
3. Check each agent's last run:
   - It has an `.exit` file → finished. Process any events that weren't read yet.
   - It has no `.exit` and the window shell is busy → still running. Resume tailing.
   - It has no `.exit` and the shell is idle → interrupted. Mark it idle and notify the owner.
4. If the active mode points to something that's gone, fall back to manager mode.

## 4. Commands (Telegram)

| Command | Behavior |
|---|---|
| `/start` | Bind the owner's user ID and chat on first run. Ignore everyone else. |
| `/create_project <name>` | `mkdir`, create the tmux session and `<name>-agent-1`, then activate it. |
| `/proj [name]` | Activate the project. Inline buttons if no name is given. If it has no agent, create one. |
| `/create_agent` | Add the next `<project>-agent-n` to the active project and activate it. |
| `/agent [name]` | Switch agent within the project. Buttons if no name is given. |
| `/delete` | Confirm with a button → archive the agent (kill its window, move its metadata). Switch to another agent in the project, or to manager mode if none is left. |
| `/clear` | Set `sessionId = null` so the next run starts a fresh pi session. The old session stays on disk. |
| `/stop` | Kill the agent's current run with Ctrl-C in its window. |
| `/status` | List projects and agents with their running/idle state and unread finished runs. |
| `/manage` | Switch to manager mode. |

**Messages sent while an agent is busy:** JSON mode can't steer a run that's in progress, so
the message is **queued** and runs when the current run ends. The bot replies "queued (1)".
Use `/stop` to cut the current run short.

**Footer:** every reply ends with a short line such as `· myproj / myproj-agent-2 ·` or `· manager ·`.

**Inactive agents:**
- Their tool calls are logged and not sent to you.
- When a run ends, you get a one-line ping: `✓ myproj-agent-2 finished` (or `✗ failed`).
- The final message is held and delivered when you switch to that agent.

**Long output:** past about 3500 characters, send a short preview plus the full text as a `.md`
file. Use Telegram's HTML parse mode so MarkdownV2 escaping is never needed.

## 5. Manager mode

- A pi SDK `createAgentSession` with cwd `PROJECTS_DIR` and its session persisted under
  `.silky/manager/`.
- It gets custom tools that call the same functions as the commands: `list_projects`,
  `create_project`, `create_agent`, `archive_agent`, `set_active`, `status`, and
  `send_to_agent` (optional, later).
- It also keeps pi's normal tools (bash, read, write and so on) on `PROJECTS_DIR`. This is
  accepted, and projects will be under git.
- `/clear` in manager mode starts a new manager session.

## 6. Milestones

**M0 — Spike pi JSON mode (half a day).** Results (pi 0.84.1):
- [x] A new run without `--session` prints the session header with an `id`, and
      `--session <id>` resumes it.
- [x] Long or multiline prompts: pipe them on **stdin**. `@prompt.md` works but wraps the
      text in a `<file name=...>` tag, and an argument is limited to 128 KB.
- [x] Project trust doesn't block non-interactive runs: JSON mode never prompts and falls back
      to `defaultProjectTrust`. Nothing to write on project creation.
- [x] Ctrl-C mid-run: the session file stays valid and the next `--session` run continues.
      Ctrl-C kills the whole command line, so `silky-run` traps INT to still write `.exit`.
      tmux's `pane_current_command` showed `bash` during a run, so "busy" is detected from a
      `runs/<ts>.pid` file instead.
- [x] Startup overhead is about 2 s of CPU per run.
- [x] The SDK doesn't apply the CLI's HTTP setup. Without raising Node's
      `autoSelectFamilyAttemptTimeout` (CLI: 2 s), manager requests timed out.

**M1 — Core, with no Telegram.** Store, reconcile, tmux wrapper, `silky-run`, `silky-pretty`
and the event tailer. Drive it from a small CLI (`silky create-project`, `silky send`, ...) to
test it.

**M2 — Telegram gateway.** Owner binding, router, all commands, footer, queueing, ping on
finish, held messages, long-output files.

**M3 — Manager mode.** SDK session plus the silky tools, and switching the active mode from
tool calls.

**M4 — Polish.** Inline buttons, `/status` detail, nicer `silky-pretty`, and a systemd
user unit for the daemon.

## 7. Decided while implementing

- Held messages: only the last final answer is kept, shown with "(+N earlier runs)".
- Models: pi defaults (`~/.pi/agent/settings.json`) for both project agents and the manager.
- `/create_project` for a folder that already exists adopts it: it gets an agent if it has
  none, and becomes active.
- Messages queued while an agent is busy run together as one prompt. `/stop` keeps the queue.
- `send_to_agent` is in the manager's tools from the start.
