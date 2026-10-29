# silky

A Telegram bot that manages a folder of projects. Each project gets a tmux session, and each
of its agents is a tmux window where every prompt runs as one `pi --mode json` process.
A manager agent (pi SDK, in-process) can do the same things as the commands.

Design: [docs/plan.md](docs/plan.md).

## Requirements

- Node 24+ (TypeScript runs directly, no build step)
- tmux 3.0+
- [pi](https://www.npmjs.com/package/@earendil-works/pi-coding-agent) on `PATH`, with a model configured

## Install

```bash
curl -fsSL https://raw.githubusercontent.com/alireza-hariri/silkyprojects/main/install.sh | sh
```

This downloads the latest release (or the `main` branch), installs dependencies, and links
`silky` into `~/.local/bin`. Override the paths with `SILKY_PREFIX` and `SILKY_BIN`, e.g.
`sudo env SILKY_PREFIX=/usr/local/share/silky SILKY_BIN=/usr/local/bin sh -c "$(curl -fsSL ...)"`.

## Setup

```bash
npm install
export PROJECTS_DIR=~/projects TELEGRAM_BOT_TOKEN=... SILKY_OWNER_ID=<your telegram user id>
bin/silky daemon
```

Settings can also go in a `.env` at the repo root (see [contrib/env.example](contrib/env.example));
`bin/silky` loads it. To run `silky` from anywhere, link it into a bin dir on your `PATH`:
`ln -s "$PWD/bin/silky" ~/.local/bin/silky`.

Then send `/start` to the bot. The first user to do so becomes the owner (only `SILKY_OWNER_ID`,
if set); everyone else is ignored. To run it as a service, see [contrib/silky.service](contrib/silky.service).

## Using it

Plain messages go to the active agent, or to the manager. Every reply ends with the active mode,
for example `· myproj / myproj-agent-2 ·`.

| Command | |
|---|---|
| `/create_project <name>` | Create the folder from a template (or adopt an existing one), its first agent, and switch to it |
| `/proj [name]` | Switch project; buttons if no name |
| `/create_agent` | Add an agent to the current project |
| `/agent [name]` | Switch agent; buttons if no name |
| `/delete` | Archive the current agent (after a confirm) |
| `/clear` | Fresh pi session on the next message (manager: new manager session) |
| `/stop` | Ctrl-C the current run |
| `/status` | Projects, agents, running/idle, unread and queued |
| `/manage` | Manager mode |

- Messages sent while an agent is busy are queued and run together when the run ends.
- Agents you aren't looking at send a one-line ping when they finish; the answer is held until
  you switch to them.
- Answers over 3500 characters come as a short preview plus a `.md` file.
- Files and photos you send are saved into the active project (see below). A caption is sent to
  the agent together with the saved path.
- `tmux -L silky attach -t <project>` shows a readable log of every run. silky runs its own tmux
  server on the `silky` socket (`SILKY_TMUX_SOCKET` to change it), so its sessions stay out of
  your default `tmux ls`.

## Project templates and files

`/create_project` asks how a new folder should start:

| Template | What you get |
|---|---|
| Empty folder | just the folder |
| Git | `git init` and `raw/assets/` (kept in git with a `.gitkeep`) |
| Git + data dir | the same, plus `data/`, which `.gitignore` keeps out of git |

A file you send goes to `raw/assets/`. If it is over 20 MB and the project has a `data/` dir, it
goes to `data/` instead, so big files stay out of git. Existing files are never overwritten
(`name-1.ext`, …).

Telegram's public Bot API can't download files over 20 MB. To receive bigger ones, run a
[local Bot API server](https://github.com/tdlib/telegram-bot-api) with `--local` and set
`TELEGRAM_API_ROOT` (for example `http://localhost:8081`).

### When Telegram is unreachable

silky talks to Telegram directly. When a request can't connect, it reads a proxy URL from
`~/.proxyaddr` (or `SILKY_PROXY_FILE`), checks it by fetching `https://telegram.org/robots.txt`,
and switches to it. The file is read again each time the current route fails, so a proxy that
changes over time is picked up; `http://` and `socks5h://` URLs both work. Every 10 minutes on a
proxy it checks whether the direct route is back. With a local `TELEGRAM_API_ROOT` there is no
fallback.

## CLI

The same core without Telegram, useful for testing:

```bash
bin/silky status
bin/silky create-project demo git-data   # template: empty (default), git, git-data
bin/silky send demo demo-agent-1 "what is in this folder?"
bin/silky help
```

Don't run CLI commands that change state while the daemon is running: only one process should
write `.silky`.

## Sync with a server

```bash
bin/silky sync me@server:~/projects   # first time; the server is remembered
bin/silky sync                        # later runs
```

Git repos get a `git pull` on both sides, and everything else is synced with rsync, newer file
wins. Details: [docs/sync.md](docs/sync.md).

## Development

```bash
npm test          # uses a fake pi (test/fixtures/fake-pi) and a real tmux server
npm run typecheck
```
