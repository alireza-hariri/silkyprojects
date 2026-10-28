# silky

A Telegram bot that manages a folder of projects. Each project gets a tmux session, and each
of its agents is a tmux window where every prompt runs as one `pi --mode json` process.
A manager agent (pi SDK, in-process) can do the same things as the commands.

Design: [docs/plan.md](docs/plan.md).

## Requirements

- Node 24+ (TypeScript runs directly, no build step)
- tmux 3.0+
- [pi](https://www.npmjs.com/package/@earendil-works/pi-coding-agent) on `PATH`, with a model configured

## Setup

```bash
npm install
export PROJECTS_DIR=~/projects TELEGRAM_BOT_TOKEN=... SILKY_OWNER_ID=<your telegram user id>
bin/silky daemon
```

Then send `/start` to the bot. The first user to do so becomes the owner (only `SILKY_OWNER_ID`,
if set); everyone else is ignored. To run it as a service, see [contrib/silky.service](contrib/silky.service).

## Using it

Plain messages go to the active agent, or to the manager. Every reply ends with the active mode,
for example `· myproj / myproj-agent-2 ·`.

| Command | |
|---|---|
| `/create_project <name>` | Create the folder (or adopt an existing one), its first agent, and switch to it |
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
- `tmux attach -t <project>` shows a readable log of every run.

## CLI

The same core without Telegram, useful for testing:

```bash
bin/silky status
bin/silky create-project demo
bin/silky send demo demo-agent-1 "what is in this folder?"
bin/silky help
```

Don't run CLI commands that change state while the daemon is running: only one process should
write `.silky`.

## Development

```bash
npm test          # uses a fake pi (test/fixtures/fake-pi) and a real tmux server
npm run typecheck
```
