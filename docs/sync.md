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
2. **Git dirs with no remote.** A repo that has commits but no remote on either side: when sync runs in
   a terminal and `gh` is logged in on the laptop, it asks whether to create a private GitHub repo
   (default name: the folder name; type another name to use that) and pushes there. The laptop pushes all
   its branches; on the server only `origin` is set, and its branch goes up in the next step.
3. **Git dirs**, on each side that has them (laptop first): `git fetch`, fast-forward the
   current branch to its upstream, then **push** the commits the upstream doesn't have yet (a branch with
   no upstream is pushed to `origin` as a new branch). Nothing else inside them is touched (uncommitted or
   untracked files stay where they are). A failed pull or push (diverged branches, no origin) is reported
   and sync carries on.
   - **Empty repo on one side** (`git init` with no commits, e.g. a project made from a template
     on one machine and cloned on the other): sync fills it from the other side over ssh (branches,
     `origin/*` refs, tags), checks out the same branch, and sets `origin` and the upstream. Files
     the checkout would overwrite are moved to `.silky-seed-backup-<time>/` (git-excluded) in that
     project. Empty on both sides: skipped.
   - **No upstream**: a branch without one gets `origin/<branch>` when that exists.
   - **Server can't fetch** (private repo, no key on the server): when both sides have the same
     `origin`, the laptop pushes its freshly fetched `origin/*` refs to the server before the server
     pulls, so the server fast-forwards without needing its own credentials.
   - **Server can't push**: the laptop fetches the server's branch over ssh and pushes it to the
     server's remote itself (using its own git credentials, or the `gh` login for GitHub https URLs),
     then pulls it locally too.
4. **Git dirs on one side only** (usually: a repo on one side, nothing on the other). After the push in
   step 3, the other side checks that it can read `origin` (`git ls-remote`) and clones it. If it can't
   (no remote, no credentials, an empty repo), the folder is **left out entirely**: no clone, no rsync of
   the folder or its `data/`. A half-copied project would turn into a plain folder next to a repo, which
   is the conflict this avoids. Fix access on that side (e.g. a deploy key) and the next sync clones it.
   - If the other side has a **plain folder** there instead (an old copy), it becomes a checkout of
     `origin` in place: files that differ from the repo stay as uncommitted changes, files missing from
     the folder are checked out, extra files stay untracked. Nothing is overwritten.
5. **Data dirs**: `rsync -a --update` local → server, then server → local. A file that exists on
   one side is copied; a file on both sides is replaced by whichever copy has the newer
   modification time. Loose files directly inside a project with git subdirs are synced too.
   A git project's gitignored `data/` is synced once the repo is on both sides.

Edge cases:

- rsync never copies a git repo (`.git` or its working tree): repos only move through git.
- Deletions are not synced: a file deleted on one side comes back from the other.
- `.silky/`, hidden top-level folders and loose top-level files of `PROJECTS_DIR` are not synced, nor
  `node_modules/` and `.venv/` anywhere.
- `--dry-run` shows what rsync would copy, which repos would be pulled and pushed, which one-sided repos
  would be cloned or skipped (it checks access), and changes nothing.

Requires `ssh` access to the server (key-based, so it doesn't prompt mid-sync) and `rsync` and
`git` on both sides. `gh` on the laptop is optional (only for creating GitHub repos).
