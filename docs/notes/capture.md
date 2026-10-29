# Capture (direction 3)

Goal: make getting things into a project as cheap as possible from the phone.

## Wanted

1. **Source of saved files.** When a file comes from a known source, record where it came from:
   a forwarded message (original chat or channel, author, date), a link, or a direct upload.
   For example, a sidecar `<file>.source.json` or one line per file in `raw/assets/SOURCES.md`.
2. **A place for links.** Sent URLs are saved, not just passed to the agent: for example
   `raw/links.md` with the URL, title, date, source and caption. Maybe fetch a readable copy
   later.
3. **Voice input.** Transcribe voice notes, then use them as a prompt (with the caption or
   on their own) or save them as a note. Keep the audio in `raw/assets/` and log its source
   like any other file.

## Later, maybe

- An inbox project where the manager sorts forwards, links and notes into the right project.
- More gateways (a small web dashboard) through the `Controller` interface in `src/manager.ts`.
