# Notes

## Decisions

0. Every project with agents has one tmux session, and each agent gets its own window.
1. Agents use pi **JSON mode** (`pi --mode json`), not RPC. Each prompt is a single run inside the agent's tmux window. The output is tee'd to a file that the bot tails. The pi session ID is the lasting link between runs.
2. Plain messages go to the active agent; messages starting with `/` are commands.
3. Inactive agents: their tool calls are logged and not sent to the user. When a run finishes, the bot sends a one-line ping. The final message is held and delivered when that agent becomes active.
4. Multiple agents can share one project folder, each in its own tmux window. (No worktrees for now; the agents share the same files.)
5. Single user. Still restrict the bot to the owner's Telegram user ID.
6. Metadata lives in `PROJECTS_DIR/.silky`. Only silky touches it.
7. A folder with no metadata is a valid project with no agents. Metadata whose folder is gone means the project was deleted.
8. Agents are named `<project>-agent-<n>`. Numbers are never reused.
9. `/delete` archives the agent rather than destroying it.
10. Projects get their own git repos later (inside PROJECTS_DIR). The manager agent's broad access is accepted.

## Open

Decided: see [plan.md §7](../plan.md#7-decided-while-implementing).
