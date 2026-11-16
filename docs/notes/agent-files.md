# Agent files → Telegram

The reverse of capture: the agent produces files (plots, generated PDFs, exports, logs)
and the user should get them in the Telegram chat without asking for paths and scp.

## Goal

When an agent writes a file worth sharing, it shows up in the Telegram chat as an
attachment — with the project/agent it came from, and without the user naming paths.

## Design sketch

1. **Who decides what to send?** The agent. Pi has no "send file" tool today, so add one
   the same way other tools surface: the run script writes a line to the tail stream
   (or a sidecar file under `runs/<run>/`), and silky reacts to it. Cheapest protocol:
   a marker line like `SILKY-FILE raw/assets/plot.png` — optionally followed by a
   caption on the next line. Everything else (path validation, size) happens in silky.
2. **Where files live.** Only paths inside the project folder may be sent. Reject
   anything outside (no `..`, no absolute escapes) — the agent already can't leave the
   project cwd, so this is just a guard. Prefer `raw/assets/` for things meant to be
   shared; `data/` for big artifacts.
3. **Telegram limits.** `sendDocument` / `sendPhoto` accept up to 50 MB through the Bot
   API (20 MB through the public api.telegram.org — a local Bot API server lifts this;
   see the existing download-side handling in `src/telegram.ts` and `TELEGRAM_API_ROOT`).
   Files bigger than that: send a path + one-line summary instead, or a split archive,
   or nothing (decide when we hit it).
4. **Delivery path.** `SilkyEvent` gains something like
   `{ type: "file"; project; agent; path; caption? }`. The gateway listens (it already
   listens for `finished` / `tool` events in `src/telegram.ts`), uploads via
   `bot.api.sendDocument(chat, new InputFile(...))`, and marks it with the usual
   `· project / agent ·` footer so multi-agent chats stay readable.
5. **Dedup / spam control.** One file per event, at most a few per run; if the agent
   asks for the same path twice, send it once per run. Cap events per run (say 10) and
   fold the rest into a list message.
6. **History.** Like incoming files, keep the original in the project (git or data/) —
   the chat copy is a convenience, not the archive. No need to record sends in
   `state.json`.

## Open questions

- Marker-line protocol vs. a real sidecar file vs. pi extension tool? Start with the
  marker line: zero new moving parts, the tail loop in `src/core.ts` already parses the
  run stream.
- Should the caption support markdown (converted like answers) or stay plain?
- Voice/video: send as voice notes (`sendVoice`) when the extension is `.ogg`?
- Do the other future gateways (web dashboard) need the same event, or is this
  Telegram-shaped? The event is generic; rendering is the gateway's business.
- Manager mode: the manager runs outside a project folder, so it gets no file sending
  (or only from its own `.silky/manager/` scratch dir) — decide later.

## Later, maybe

- A `/files` command listing what the active agent recently sent, with re-download buttons.
- Push on request: "send me the latest csv" as a plain message handled by the manager.
