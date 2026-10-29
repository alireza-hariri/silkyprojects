# silky sync

`silky sync [user@host:/path] [--dry-run] [--force]` syncs your local `PROJECTS_DIR` with the
projects dir on a server. The first run asks for the server (or takes it as an argument) and
saves it to `PROJECTS_DIR/.silky/sync.json`; later runs reuse it. Pass a new `user@host:/path`
to change it.

## Git dirs and data dirs

Each side is scanned one level deep, never recursively:

- A **git dir** is a project with a `.git`, or a direct subdir of a project with a `.git`.
- A **data dir** is everything else: a project that is not a git repo and has no git subdirs,
  and, in a project that does have git subdirs, every subdir that is not a git repo.
- One exception inside git projects: a top-level `data/` that git ignores is a data dir too.
  This is what the "Git + data dir" project template creates.

```
projects/
  app/        .git        git dir
    data/     gitignored    data dir
  notes/                  data dir
  mixed/                  not git, has a git subdir:
    lib/      .git          git dir
    assets/                 data dir
```

## What sync does

1. **Clock check.** Reads the server's clock. If it is more than 5s off from yours, sync stops,
   since "newer file wins" would pick the wrong file. Fix the clock (NTP) or pass `--force`.
2. **Git dirs** that exist on both sides: `git pull --ff-only` locally, then on the server.
   Nothing else inside them is touched (uncommitted or untracked files stay where they are).
   A failed pull (diverged branches, no upstream) is reported and sync carries on.
3. **Data dirs**: `rsync -a --update` local → server, then server → local. A file that exists on
   one side is copied; a file on both sides is replaced by whichever copy has the newer
   modification time. Loose files directly inside a project with git subdirs are synced too.

Edge cases:

- A git dir that exists on one side only is copied whole (including `.git`) by rsync.
- A path that is a git repo on one side but a plain folder on the other is skipped with a warning.
- Deletions are not synced: a file deleted on one side comes back from the other.
- `.silky/`, hidden top-level folders and loose files at the top of `PROJECTS_DIR` are not synced.
- `--dry-run` shows what rsync would copy and which repos would be pulled, and changes nothing.

Requires `ssh` access to the server (key-based, so it doesn't prompt mid-sync) and `rsync` and
`git` on both sides.
