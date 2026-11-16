import { execFile, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import type { Config } from "./config.ts";

// Sync logic is described in docs/sync.md.

/** Larger clock skew than this makes "newer file wins" unreliable, so sync refuses to run. */
const MAX_SKEW_S = 5;

export interface Remote {
	host: string;
	path: string;
}

/**
 * What one side holds: projects and the direct subdirs of non-git projects, each mapped to whether it is a git repo.
 * A git project's `data/` is listed (as not git) only when git ignores it.
 */
export type Layout = Map<string, boolean>;

export type Side = "local" | "server";

/** A git repo on one side only: the other side has nothing there, or a plain folder (`plain`). */
export interface OneSided {
	path: string;
	from: Side;
	plain: boolean;
}

export interface Plan {
	/** Git repos on both sides: `git pull` on each. */
	pull: string[];
	/** Paths rsync must not touch: all git repos (on one or both sides). */
	exclude: string[];
	/** Git repos on one side only: cloned on the other side from origin, or skipped. */
	oneSided: OneSided[];
	/** Excluded git projects whose gitignored `data/` rsync still syncs. */
	data: string[];
}

export function parseRemote(s: string): Remote {
	const i = s.indexOf(":");
	if (i <= 0 || i === s.length - 1) throw new Error(`remote must look like user@host:/path/to/projects, got "${s}"`);
	return { host: s.slice(0, i), path: s.slice(i + 1) };
}

/** Projects and, for projects that aren't git repos, their direct subdirs (hidden ones skipped, like project listing). */
export function scanLocal(root: string): Layout {
	const layout: Layout = new Map();
	const dirs = (d: string) =>
		readdirSync(d, { withFileTypes: true })
			.filter((e) => e.isDirectory() && !e.name.startsWith("."))
			.map((e) => e.name);
	for (const p of dirs(root)) {
		const git = existsSync(join(root, p, ".git"));
		layout.set(p, git);
		if (git) {
			const ignored = spawnSync("git", ["-C", join(root, p), "check-ignore", "-q", "data/"]).status === 0;
			if (ignored && existsSync(join(root, p, "data"))) layout.set(`${p}/data`, false);
			continue;
		}
		for (const s of dirs(join(root, p))) layout.set(`${p}/${s}`, existsSync(join(root, p, s, ".git")));
	}
	return layout;
}

// Prints the server clock, the resolved projects path, then one `G|D<tab>path` line per scanned path.
const PROBE = `
case $1 in "~") set -- "$HOME" ;; "~/"*) set -- "$HOME/\${1#"~/"}" ;; esac
cd -- "$1" || exit 3
date +%s
pwd
for p in */; do
  p=\${p%/}
  [ -d "$p" ] && [ ! -L "$p" ] || continue
  if [ -e "$p/.git" ]; then
    printf 'G\\t%s\\n' "$p"
    [ -d "$p/data" ] && git -C "$p" check-ignore -q data/ 2>/dev/null && printf 'D\\t%s/data\\n' "$p"
    continue
  fi
  printf 'D\\t%s\\n' "$p"
  for s in "$p"/*/; do
    s=\${s%/}
    [ -d "$s" ] && [ ! -L "$s" ] || continue
    if [ -e "$s/.git" ]; then printf 'G\\t%s\\n' "$s"; else printf 'D\\t%s\\n' "$s"; fi
  done
done
`;

// Args: projects dir, note printed when fetch fails, relay (1 on the server), repo paths.
// Per repo: fetch, fast-forward the current branch to its upstream, then push commits the upstream lacks.
// Fetch and merge run separately so a failed fetch (no credentials) can still merge origin refs the other side
// pushed in. A branch with no upstream gets origin/<branch> when that exists, else it is pushed to origin as new.
// With relay=1 a failed push prints `@relay<tab>repo<tab>branch<tab>remote<tab>url<tab>dest ref` so the laptop
// can push for it; a successful push prints `@pushed<tab>repo`.
const PULL = `
cd -- "$1" || exit 3
fetchnote=$2
relay=$3
shift 3
export GIT_TERMINAL_PROMPT=0
for d in "$@"; do
  note= new= fetch=
  if [ -z "$(git -C "$d" remote)" ]; then printf 'ok  %s (no remote)\\n' "$d"; continue; fi
  fetch=$(git -C "$d" fetch -q 2>&1) || note=" ($fetchnote)"
  b=$(git -C "$d" symbolic-ref -q --short HEAD)
  if [ -z "$b" ]; then printf 'ERR %s%s\\n    detached HEAD, nothing to pull or push\\n' "$d" "$note"; continue; fi
  if ! git -C "$d" rev-parse -q --verify '@{u}' >/dev/null 2>&1; then
    if git -C "$d" show-ref -q --verify "refs/remotes/origin/$b"; then
      git -C "$d" branch -q --set-upstream-to="origin/$b" && note="$note (upstream set to origin/$b)"
    elif git -C "$d" remote get-url origin >/dev/null 2>&1; then new=1
    else printf 'ERR %s%s\\n    branch %s has no upstream and there is no origin\\n' "$d" "$note" "$b"; continue
    fi
  fi
  if [ -n "$new" ]; then
    rem=origin dest=refs/heads/$b
    n=$(git -C "$d" rev-list --count HEAD --not --remotes)
  else
    if ! out=$(git -C "$d" merge --ff-only -q '@{u}' 2>&1); then
      printf 'ERR %s%s\\n' "$d" "$note"; printf '%s\\n%s\\n' "$fetch" "$out" | sed '/^$/d; s/^/    /'; continue
    fi
    rem=$(git -C "$d" config "branch.$b.remote") dest=$(git -C "$d" config "branch.$b.merge")
    n=$(git -C "$d" rev-list --count '@{u}..HEAD')
  fi
  if [ "$n" -gt 0 ]; then
    if out=$(git -C "$d" push -q "$rem" "HEAD:$dest" 2>&1); then
      [ -n "$new" ] && git -C "$d" branch -q --set-upstream-to="$rem/$b"
      note="$note (pushed $n commits to $rem)"
      printf '@pushed\\t%s\\n' "$d"
    elif [ "$relay" = 1 ]; then
      note="$note (can't push $n commits, pushing them through local)"
      printf '@relay\\t%s\\t%s\\t%s\\t%s\\t%s\\n' "$d" "$b" "$rem" "$(git -C "$d" remote get-url "$rem")" "$dest"
    else
      printf 'ERR %s%s\\n    push of %s commits failed:\\n' "$d" "$note" "$n"; printf '%s\\n' "$out" | sed 's/^/    /'; continue
    fi
  fi
  printf 'ok  %s%s\\n' "$d" "$note"
done
`;

// Args: projects dir, repo paths. One `path<tab>empty<tab>branch<tab>origin url` line per repo; empty = no refs at all.
const INFO = `
cd -- "$1" || exit 3
shift
for d in "$@"; do
  if [ -z "$(git -C "$d" for-each-ref --count=1 2>/dev/null)" ]; then e=1; else e=0; fi
  printf '%s\\t%s\\t%s\\t%s\\n' "$d" "$e" "$(git -C "$d" symbolic-ref -q --short HEAD)" "$(git -C "$d" remote get-url origin 2>/dev/null)"
done
`;

// Args: repo dir, branch, origin url. Turns an empty repo whose refs/silky/heads/* were just filled from the
// other side into a checkout of <branch>. Tracked files that would overwrite different untracked ones
// (template leftovers) are moved to a backup dir first.
const SEED = `
cd -- "$1" || exit 3
b=$2
git for-each-ref --format='%(refname)' refs/silky/heads/ | while IFS= read -r r; do
  git update-ref "refs/heads/\${r#refs/silky/heads/}" "$r" && git update-ref -d "$r"
done
if [ -n "$3" ]; then git remote set-url origin "$3" 2>/dev/null || git remote add origin "$3"; fi
git symbolic-ref HEAD "refs/heads/$b" && git read-tree HEAD || exit 1
bk=.silky-seed-backup-$(date +%Y%m%d-%H%M%S)
git -c core.quotepath=off diff --name-only | while IFS= read -r f; do
  [ -e "$f" ] || [ -L "$f" ] || continue
  mkdir -p "$bk/$(dirname "$f")" && mv "$f" "$bk/$f" && printf '    moved aside: %s\\n' "$bk/$f"
done
if [ -d "$bk" ]; then ex=$(git rev-parse --git-path info/exclude); mkdir -p "$(dirname "$ex")"; printf '/%s/\\n' "$bk" >> "$ex"; fi
git reset -q --hard || exit 1
if git show-ref -q --verify "refs/remotes/origin/$b"; then git branch -q --set-upstream-to="origin/$b" "$b"; fi
`;

/** Refs copied between sides: local branches (staged under refs/silky/heads for SEED), origin's refs and tags. */
const SEED_REFS = ["+refs/heads/*:refs/silky/heads/*", "+refs/remotes/origin/*:refs/remotes/origin/*", "^refs/remotes/origin/HEAD", "+refs/tags/*:refs/tags/*"];
const RELAY_REFS = ["+refs/remotes/origin/*:refs/remotes/origin/*", "^refs/remotes/origin/HEAD"];

// Args: projects dir, repo path, origin url, branch, mode (check|clone|convert). Checks this side can read origin,
// then clones it (clone) or turns the plain folder at the path into a checkout of it (convert). A convert keeps every
// file in the folder: index and HEAD come from origin, files that differ are left as uncommitted changes, files
// missing from the folder are checked out. Prints `ok`, `noaccess` or `nobranches` first, then details.
const CLONE = `
cd -- "$1" || exit 3
d=$2 url=$3 b=$4 mode=$5
export GIT_TERMINAL_PROMPT=0 GIT_SSH_COMMAND="\${GIT_SSH_COMMAND:-ssh} -o BatchMode=yes"
if ! heads=$(git ls-remote --heads -- "$url" 2>&1); then printf 'noaccess\\n%s\\n' "$heads"; exit 0; fi
[ -n "$heads" ] || { echo nobranches; exit 0; }
[ "$mode" = check ] && { echo ok; exit 0; }
set --
if printf '%s\\n' "$heads" | cut -f2 | grep -qxF "refs/heads/$b"; then set -- -b "$b"; fi
if [ "$mode" = clone ]; then
  git clone -q "$@" -- "$url" "$d" || exit 1
  echo ok
  exit 0
fi
tmp=$(mktemp -d "$d/.silky-clone.XXXXXX") || exit 1
if ! git clone -q --no-checkout "$@" -- "$url" "$tmp"; then rm -rf "$tmp"; exit 1; fi
mv "$tmp/.git" "$d/.git" && rmdir "$tmp" || exit 1
cd -- "$d" && git reset -q && git ls-files -d -z | git checkout-index -q -z --stdin || exit 1
echo ok
n=$(git status --porcelain --untracked-files=no | wc -l)
[ "$n" -gt 0 ] && printf '    %s files differ from the repo, left as uncommitted changes\\n' $n
exit 0
`;

// Args: repo dir, branch, remote, dest ref, sha. After the laptop pushed <sha> to <remote> for this repo, record it
// in the remote-tracking ref (so the commits no longer count as unpushed) and set the upstream if there is none.
const TRACK = `
cd -- "$1" || exit 3
t=$3/\${4#refs/heads/}
git update-ref "refs/remotes/$t" "$5" || exit 1
git rev-parse -q --verify "$2@{u}" >/dev/null 2>&1 || git branch -q --set-upstream-to="$t" "$2"
`;

export interface RepoInfo {
	empty: boolean;
	branch: string;
	origin: string;
}

export function parseInfo(stdout: string): Map<string, RepoInfo> {
	const out = new Map<string, RepoInfo>();
	for (const line of stdout.split("\n")) {
		const [path, empty, branch = "", origin = ""] = line.split("\t");
		if (path && empty) out.set(path, { empty: empty === "1", branch, origin });
	}
	return out;
}

/** Whether two remote URLs name the same repo: `git@github.com:a/b.git` matches `https://github.com/a/b`. */
export function sameRepo(a: string, b: string): boolean {
	const norm = (u: string) =>
		u
			.trim()
			.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "")
			.replace(/^[^@/]+@/, "")
			.replace(/^([^/:]+):(?!\d+\/)/, "$1/")
			.replace(/\/+$/, "")
			.replace(/\.git$/, "")
			.toLowerCase();
	return a !== "" && b !== "" && norm(a) === norm(b);
}

export type GitAction = { kind: "pull" } | { kind: "skip" } | { kind: "seed"; to: "server" | "local"; branch: string; origin: string };

/** What to do with a repo that is on both sides, given each side's info. */
export function gitAction(local: RepoInfo, remote: RepoInfo): GitAction {
	if (local.empty && remote.empty) return { kind: "skip" };
	if (remote.empty) return { kind: "seed", to: "server", branch: local.branch, origin: local.origin };
	if (local.empty) return { kind: "seed", to: "local", branch: remote.branch, origin: remote.origin };
	return { kind: "pull" };
}

/** Decide what to pull and what rsync leaves alone. rsync never copies a git repo: one-sided repos are cloned from origin or skipped. */
export function plan(local: Layout, remote: Layout): Plan {
	const out: Plan = { pull: [], exclude: [], oneSided: [], data: [] };
	for (const path of [...new Set([...local.keys(), ...remote.keys()])].sort()) {
		const l = local.get(path);
		const r = remote.get(path);
		if (l && r) {
			out.pull.push(path);
			out.exclude.push(path);
			if (local.get(`${path}/data`) === false || remote.get(`${path}/data`) === false) out.data.push(path);
		} else if (l || r) {
			out.oneSided.push({ path, from: l ? "local" : "server", plain: (l ? r : l) === false });
			out.exclude.push(path);
		}
	}
	return out;
}

/** rsync filter rules: skip the excluded paths (but keep their gitignored `data/`), hidden top-level entries (`.silky`) and loose top-level files. */
export function filters(p: Pick<Plan, "exclude" | "data">): string[] {
	const glob = (s: string) => s.replace(/[*?[\\]/g, "\\$&");
	const rules = p.exclude.flatMap((e) =>
		p.data.includes(e) ? [`--include=/${glob(e)}/`, `--include=/${glob(e)}/data/`, `--exclude=/${glob(e)}/*`] : [`--exclude=/${glob(e)}/`],
	);
	// These directories hold large build/dependency artifacts that don't need to be synced.
	const alwaysExcluded = ["node_modules", ".venv"];
	return [...rules, ...alwaysExcluded.map((d) => `--exclude=**/${d}/`), "--exclude=/.*", "--include=/*/", "--exclude=/*"];
}

const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

function run(
	cmd: string,
	args: string[],
	input?: string,
	timeoutMs = 120_000,
	env?: NodeJS.ProcessEnv,
): Promise<{ code: number; stdout: string; stderr: string }> {
	return new Promise((resolve) => {
		const child = execFile(cmd, args, { maxBuffer: 64 << 20, env: env && { ...process.env, ...env } }, (err, stdout, stderr) =>
			resolve({ code: err ? (typeof err.code === "number" ? err.code : 1) : 0, stdout, stderr }),
		);
		const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
		child.on("close", () => clearTimeout(timer));
		child.stdin!.end(input ?? "");
	});
}

function runInherit(cmd: string, args: string[]): Promise<number> {
	return new Promise((resolve) => spawn(cmd, args, { stdio: "inherit" }).on("close", (code) => resolve(code ?? 1)));
}

class Ssh {
	readonly host: string;
	readonly opts: string[];
	constructor(host: string) {
		this.host = host;
		// One connection for the whole sync instead of one per ssh/rsync call.
		// BatchMode: prompts (password, host key) can never be answered through pipes, so fail fast instead of hanging.
		this.opts = [
			"-o", "ControlMaster=auto",
			"-o", `ControlPath=${join(tmpdir(), "silky-ssh-%C")}`,
			"-o", "ControlPersist=60",
			"-o", "ConnectTimeout=10",
			"-o", "BatchMode=yes",
		];
	}
	script(script: string, args: string[], timeoutMs?: number) {
		return run("ssh", [...this.opts, this.host, `sh -s -- ${args.map(q).join(" ")}`], script, timeoutMs);
	}
	/** git in a local repo, talking to the server over this connection. Transfers can be big, so a long timeout. */
	git(dir: string, args: string[]) {
		const env = { GIT_TERMINAL_PROMPT: "0", GIT_SSH_COMMAND: ["ssh", ...this.opts].map(q).join(" ") };
		return run("git", ["-C", dir, ...args], undefined, 30 * 60_000, env);
	}
	close() {
		return run("ssh", [...this.opts, "-O", "exit", this.host]);
	}
}

interface SyncFile {
	remote: string;
}

const syncFile = (config: Config) => join(config.silkyDir, "sync.json");

export function savedRemote(config: Config): string | undefined {
	try {
		return (JSON.parse(readFileSync(syncFile(config), "utf8")) as SyncFile).remote;
	} catch {
		return undefined;
	}
}

function saveRemote(config: Config, remote: string): void {
	mkdirSync(config.silkyDir, { recursive: true });
	writeFileSync(syncFile(config), `${JSON.stringify({ remote } satisfies SyncFile, null, "\t")}\n`);
}

async function ask(): Promise<string> {
	if (!process.stdin.isTTY) throw new Error("no saved server: run `silky sync user@host:/path/to/projects` once");
	const rl = createInterface({ input: process.stdin, output: process.stdout });
	try {
		const host = (await rl.question("Server (user@host): ")).trim();
		const path = (await rl.question("Projects dir on the server: ")).trim();
		return `${host}:${path}`;
	} finally {
		rl.close();
	}
}

function parseProbe(stdout: string): { clock: number; path: string; layout: Layout } {
	const [clock, path, ...lines] = stdout.trim().split("\n");
	const layout: Layout = new Map();
	for (const line of lines) {
		const [kind, p] = line.split("\t");
		if (p) layout.set(p, kind === "G");
	}
	return { clock: Number(clock), path, layout };
}

const localScript = (script: string, args: string[], timeoutMs?: number) => run("sh", ["-s", "--", ...args], script, timeoutMs);

const indent = (s: string) => s.trim().replace(/^/gm, "    ");

/**
 * Fill an empty repo on one side from the other side's history over ssh, then check out its branch.
 * Returns whether the repo can now be pulled like any other.
 */
async function seed(ssh: Ssh, root: string, path: string, repo: string, a: Extract<GitAction, { kind: "seed" }>): Promise<boolean> {
	const local = join(root, repo);
	const there = `${ssh.host}:${path}/${repo}`;
	console.log(`seed ${repo}: ${a.to === "server" ? "local → server" : "server → local"}, branch ${a.branch}`);
	if (!a.branch) {
		console.log(`ERR ${repo}\n    the ${a.to === "server" ? "local" : "server"} repo has a detached HEAD; check out a branch and sync again`);
		return false;
	}
	const xfer = a.to === "server" ? await ssh.git(local, ["push", "-q", there, ...SEED_REFS]) : await ssh.git(local, ["fetch", "-q", there, ...SEED_REFS]);
	if (xfer.code !== 0) {
		console.log(`ERR ${repo}\n${indent(xfer.stderr || xfer.stdout)}`);
		return false;
	}
	const args = [a.to === "server" ? `${path}/${repo}` : local, a.branch, a.origin];
	const res = a.to === "server" ? await ssh.script(SEED, args) : await localScript(SEED, args);
	process.stdout.write(res.stdout);
	if (res.code !== 0) {
		console.log(`ERR ${repo}\n${indent(res.stderr)}`);
		return false;
	}
	return true;
}

type Infos = Record<Side, Map<string, RepoInfo>>;

const other = (s: Side): Side => (s === "local" ? "server" : "local");

/** Info on every git repo each side holds. */
async function repoInfo(ssh: Ssh, root: string, path: string, p: Plan): Promise<Infos> {
	const mine = (s: Side) => [...p.pull, ...p.oneSided.filter((o) => o.from === s).map((o) => o.path)];
	const [li, ri] = await Promise.all([localScript(INFO, [root, ...mine("local")]), ssh.script(INFO, [path, ...mine("server")])]);
	if (li.code !== 0 || ri.code !== 0) throw new Error(`reading git repos failed: ${(li.stderr || ri.stderr).trim()}`);
	return { local: parseInfo(li.stdout), server: parseInfo(ri.stdout) };
}

/** Repos on both sides that can be pulled, after seeding empty ones. Prints what it skips or fails. */
async function prepareRepos(ssh: Ssh, root: string, path: string, repos: string[], info: Infos, dryRun?: boolean): Promise<string[]> {
	const out: string[] = [];
	for (const repo of repos) {
		const l = info.local.get(repo);
		const r = info.server.get(repo);
		if (!l || !r) continue;
		const a = gitAction(l, r);
		if (a.kind === "skip") {
			console.log(`skip ${repo}: empty git repo on both sides`);
			continue;
		}
		if (a.kind === "seed") {
			if (dryRun) console.log(`would seed ${repo} on the ${a.to} from the other side`);
			else if (await seed(ssh, root, path, repo, a)) {
				// The seeded side now matches the other one.
				const from = a.to === "server" ? l : r;
				info[a.to].set(repo, { ...from });
				out.push(repo);
			}
			continue;
		}
		out.push(repo);
	}
	return out;
}

export type Ask = (question: string) => Promise<string>;

function ttyAsk(): Ask | undefined {
	if (!process.stdin.isTTY) return undefined;
	return async (question) => {
		const rl = createInterface({ input: process.stdin, output: process.stdout });
		try {
			return (await rl.question(question)).trim();
		} finally {
			rl.close();
		}
	};
}

/** For pushes from the laptop: never prompt, and use the gh CLI's login for https://github.com. */
const PUSH_ENV = {
	GIT_TERMINAL_PROMPT: "0",
	GIT_CONFIG_COUNT: "1",
	GIT_CONFIG_KEY_0: "credential.https://github.com.helper",
	GIT_CONFIG_VALUE_0: "!gh auth git-credential",
};

// Args: repo dir, url. Points origin at url.
const SET_ORIGIN = `
cd -- "$1" || exit 3
git remote set-url origin "$2" 2>/dev/null || git remote add origin "$2"
`;

/**
 * Offer to create a private GitHub repo (with the laptop's gh login) for each repo that has commits but no remote
 * on any side, and push to it. The laptop pushes all its branches; the server's branch goes up in the pull step.
 */
async function offerGithub(ssh: Ssh, root: string, path: string, repos: { repo: string; sides: Side[] }[], info: Infos, opts: SyncOptions): Promise<void> {
	if (!repos.length) return;
	const names = repos.map((r) => r.repo).join(", ");
	if (opts.dryRun) {
		for (const r of repos) console.log(`would offer to create a GitHub repo for ${r.repo} (has commits, no remote)`);
		return;
	}
	const ask = opts.ask ?? ttyAsk();
	if (!ask) return void console.log(`note ${names}: no remote; run sync in a terminal to have it offer to create a GitHub repo`);
	if ((await run("gh", ["auth", "status"])).code !== 0) {
		return void console.log(`note ${names}: no remote; log in with \`gh auth login\` to have sync offer to create a GitHub repo`);
	}
	const owner = (await run("gh", ["api", "user", "-q", ".login"])).stdout.trim();
	const useSsh = (await run("gh", ["config", "get", "git_protocol"])).stdout.trim() === "ssh";
	for (const { repo, sides } of repos) {
		const def = repo.split("/").at(-1)!;
		const where = sides.length === 1 ? ` (only on the ${sides[0]})` : "";
		const a = await ask(`${repo}${where} has commits but no remote. Create private GitHub repo ${owner}/${def} and push? [y/N/other name] `);
		if (!a || /^no?$/i.test(a)) {
			console.log(`skip ${repo}: no GitHub repo created`);
			continue;
		}
		const name = /^y(es)?$/i.test(a) ? def : a;
		if (!/^[\w.-]+$/.test(name)) {
			console.log(`skip ${repo}: "${name}" is not a valid repo name`);
			continue;
		}
		const full = `${owner}/${name}`;
		const made = await run("gh", ["repo", "create", full, "--private"]);
		if (made.code !== 0) {
			console.log(`ERR ${repo}: could not create ${full}\n${indent(made.stderr || made.stdout)}`);
			continue;
		}
		const view = await run("gh", ["repo", "view", full, "--json", "url,sshUrl"]);
		const urls = JSON.parse(view.stdout || "{}") as { url?: string; sshUrl?: string };
		const url = (useSsh ? urls.sshUrl : urls.url) ?? `https://github.com/${full}`;
		console.log(`created ${full}`);
		if (sides.includes("local")) {
			const g = (...args: string[]) => run("git", ["-C", join(root, repo), ...args], undefined, 30 * 60_000, PUSH_ENV);
			let res = await g("remote", "add", "origin", url);
			if (res.code === 0) res = await g("push", "-q", "-u", "origin", "--all");
			if (res.code === 0) res = await g("push", "-q", "origin", "--tags");
			if (res.code === 0) console.log(`ok  ${repo}: pushed all local branches to ${full}`);
			else console.log(`ERR ${repo}: push to ${full} failed\n${indent(res.stderr || res.stdout)}`);
			info.local.get(repo)!.origin = url;
		}
		if (sides.includes("server")) {
			const res = await ssh.script(SET_ORIGIN, [`${path}/${repo}`, url]);
			if (res.code === 0) info.server.get(repo)!.origin = url;
			else console.log(`ERR ${repo}: could not set origin on the server\n${indent(res.stderr)}`);
		}
	}
}

interface Relay {
	repo: string;
	branch: string;
	remote: string;
	url: string;
	dest: string;
}

/** Print PULL's output, minus the machine lines it returns. */
function pullReport(stdout: string): { pushed: string[]; relay: Relay[] } {
	const out = { pushed: [] as string[], relay: [] as Relay[] };
	for (const line of stdout.split("\n")) {
		const f = line.split("\t");
		if (f[0] === "@pushed") out.pushed.push(f[1]);
		else if (f[0] === "@relay") out.relay.push({ repo: f[1], branch: f[2], remote: f[3], url: f[4], dest: f[5] });
		else if (line) console.log(line);
	}
	return out;
}

/** The server can't push (no credentials): fetch its branch to the laptop and push it from here. */
async function relayPush(ssh: Ssh, root: string, path: string, r: Relay): Promise<boolean> {
	const own = join(root, r.repo);
	const tmp = existsSync(join(own, ".git")) ? undefined : mkdtempSync(join(tmpdir(), "silky-relay-"));
	const dir = tmp ?? own;
	const ref = "refs/silky/relay";
	try {
		let res = tmp ? await run("git", ["init", "-q", "--bare", tmp]) : { code: 0, stdout: "", stderr: "" };
		if (res.code === 0) res = await ssh.git(dir, ["fetch", "-q", `${ssh.host}:${path}/${r.repo}`, `+refs/heads/${r.branch}:${ref}`]);
		const sha = res.code === 0 ? (await run("git", ["-C", dir, "rev-parse", ref])).stdout.trim() : "";
		if (res.code === 0) res = await run("git", ["-C", dir, "push", "-q", r.url, `${ref}:${r.dest}`], undefined, 30 * 60_000, PUSH_ENV);
		if (res.code === 0) res = await ssh.script(TRACK, [`${path}/${r.repo}`, r.branch, r.remote, r.dest, sha]);
		if (res.code !== 0) {
			console.log(`ERR ${r.repo}: pushing the server's ${r.branch} through local failed\n${indent(res.stderr || res.stdout)}`);
			return false;
		}
		console.log(`ok  ${r.repo}: pushed the server's ${r.branch} to ${r.remote} through local`);
		return true;
	} finally {
		if (tmp) rmSync(tmp, { recursive: true, force: true });
		else await run("git", ["-C", dir, "update-ref", "-d", ref]);
	}
}

/** Pull and push every repo on both sides; the server's pushes go through the laptop when it has no credentials. */
async function pullPush(ssh: Ssh, root: string, path: string, both: string[], repos: Record<Side, string[]>, info: Infos): Promise<void> {
	const long = 30 * 60_000;
	if (repos.local.length) {
		console.log("git pull/push (local)");
		const res = await localScript(PULL, [root, "fetch failed, merged the last fetched refs", "0", ...repos.local], long);
		pullReport(res.stdout);
		if (res.code !== 0) throw new Error(`git pull failed: ${res.stderr.trim()}`);
	}
	// The server often can't reach origin (private repo, no key), so hand it the origin refs just fetched here.
	for (const r of both.filter((r) => sameRepo(info.local.get(r)!.origin, info.server.get(r)!.origin))) {
		const res = await ssh.git(join(root, r), ["push", "-q", `${ssh.host}:${path}/${r}`, ...RELAY_REFS]);
		if (res.code !== 0) console.log(`warn ${r}: could not copy origin refs to the server\n${indent(res.stderr)}`);
	}
	if (!repos.server.length) return;
	console.log("git pull/push (server)");
	const res = await ssh.script(PULL, [path, "server can't fetch, used origin refs from local", "1", ...repos.server], long);
	const { pushed, relay } = pullReport(res.stdout);
	if (res.code !== 0) throw new Error(`git pull on server failed: ${res.stderr.trim()}`);
	for (const r of relay) if (await relayPush(ssh, root, path, r)) pushed.push(r.repo);
	// The server's new commits are on origin now: bring them to the laptop too.
	const again = pushed.filter((r) => both.includes(r));
	if (again.length) {
		console.log("git pull (local, commits pushed from the server)");
		pullReport((await localScript(PULL, [root, "fetch failed", "0", ...again], long)).stdout);
	}
}

/**
 * A git repo on one side only: if the other side can read its origin, clone it there (or turn the plain folder there
 * into a checkout). Otherwise it is skipped, and rsync leaves it alone on both sides. Returns whether anything changed.
 */
async function cloneOneSided(ssh: Ssh, root: string, path: string, repos: OneSided[], info: Infos, dryRun?: boolean): Promise<boolean> {
	let changed = false;
	for (const o of repos) {
		const to = other(o.from);
		const { origin, branch } = info[o.from].get(o.path)!;
		const what = o.plain ? "turn the plain folder into a checkout of" : "clone";
		if (!origin) {
			console.log(`skip ${o.path}: git repo on the ${o.from} only, with no remote to clone from`);
			continue;
		}
		const args = [to === "server" ? path : root, o.path, origin, branch, dryRun ? "check" : o.plain ? "convert" : "clone"];
		const res = to === "server" ? await ssh.script(CLONE, args, 30 * 60_000) : await localScript(CLONE, args, 30 * 60_000);
		const [status, ...rest] = res.stdout.trim().split("\n");
		if (res.code !== 0) console.log(`ERR ${o.path}: could not ${what} ${origin} on the ${to}\n${indent(res.stderr || res.stdout)}`);
		else if (status === "noaccess") console.log(`skip ${o.path}: the ${to} can't read ${origin}\n${indent(rest.join("\n"))}`);
		else if (status === "nobranches") console.log(`skip ${o.path}: ${origin} has no branches yet`);
		else if (dryRun) console.log(`would ${what} ${origin} at ${o.path} on the ${to}`);
		else {
			console.log(`${o.plain ? "convert" : "clone"} ${o.path} on the ${to} from ${origin}`);
			if (rest.length) console.log(rest.join("\n"));
			changed = true;
		}
	}
	return changed;
}

export interface SyncOptions {
	remote?: string;
	dryRun?: boolean;
	force?: boolean;
	/** Asks the user a question; defaults to the terminal when there is one. */
	ask?: Ask;
}

export async function sync(config: Config, opts: SyncOptions): Promise<void> {
	const remoteStr = opts.remote ?? savedRemote(config) ?? (await ask());
	const remote = parseRemote(remoteStr);
	const ssh = new Ssh(remote.host);
	try {
		const t0 = Math.floor(Date.now() / 1000);
		const probe = await ssh.script(PROBE, [remote.path]);
		const t1 = Math.ceil(Date.now() / 1000);
		if (probe.code !== 0) {
			if (probe.code === 3) throw new Error(`${remote.path} does not exist on ${remote.host}`);
			throw new Error(`ssh ${remote.host} failed: ${probe.stderr.trim()}`);
		}
		const { clock, path, layout: remoteLayout } = parseProbe(probe.stdout);
		// The server's clock was read somewhere between t0 and t1.
		const skew = clock < t0 ? clock - t0 : clock > t1 ? clock - t1 : 0;
		console.log(`server ${remote.host}:${path}, clock skew ${skew >= 0 ? "+" : ""}${skew}s`);
		if (Math.abs(skew) > MAX_SKEW_S && !opts.force) {
			throw new Error(`server clock is off by ${skew}s (max ${MAX_SKEW_S}s): newer-file-wins would pick wrong files. Fix the clock (NTP) or pass --force.`);
		}
		saveRemote(config, `${remote.host}:${path}`);

		const root = config.projectsDir;
		let p = plan(scanLocal(root), remoteLayout);
		if (p.pull.length || p.oneSided.length) {
			const info = await repoInfo(ssh, root, path, p);
			const both = await prepareRepos(ssh, root, path, p.pull, info, opts.dryRun);
			const one = p.oneSided.filter((o) => {
				if (!info[o.from].get(o.path)?.empty) return true;
				console.log(`skip ${o.path}: empty git repo on the ${o.from} only`);
				return false;
			});
			const noRemote = [
				...both.filter((r) => !info.local.get(r)!.origin && !info.server.get(r)!.origin).map((repo) => ({ repo, sides: ["local", "server"] as Side[] })),
				...one.filter((o) => !info[o.from].get(o.path)!.origin).map((o) => ({ repo: o.path, sides: [o.from] })),
			];
			await offerGithub(ssh, root, path, noRemote, info, opts);
			const repos = { local: [...both, ...one.filter((o) => o.from === "local").map((o) => o.path)], server: [...both, ...one.filter((o) => o.from === "server").map((o) => o.path)] };
			if (opts.dryRun) for (const r of new Set([...repos.local, ...repos.server])) console.log(`would pull and push ${r}`);
			else await pullPush(ssh, root, path, both, repos, info);
			await cloneOneSided(ssh, root, path, one, info, opts.dryRun);
			if (!opts.dryRun) {
				// Pulls and clones change what is gitignored and which repos are on both sides, and so what rsync syncs.
				const again = await ssh.script(PROBE, [path]);
				if (again.code !== 0) throw new Error(`ssh ${remote.host} failed: ${again.stderr.trim()}`);
				p = plan(scanLocal(root), parseProbe(again.stdout).layout);
			}
		}

		const rsync = ["-a", "--update", "-e", ["ssh", ...ssh.opts].map(q).join(" "), ...filters(p)];
		if (opts.dryRun) rsync.push("--dry-run");
		const there = `${remote.host}:${path}/`;
		const here = `${root}/`;
		console.log("rsync data (local → server)");
		if ((await runInherit("rsync", [...rsync, "--out-format=↑ %n", here, there])) !== 0) throw new Error("rsync to server failed");
		console.log("rsync data (server → local)");
		if ((await runInherit("rsync", [...rsync, "--out-format=↓ %n", there, here])) !== 0) throw new Error("rsync from server failed");
	} finally {
		await ssh.close();
	}
}
