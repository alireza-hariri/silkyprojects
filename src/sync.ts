import { execFile, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
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

export interface Plan {
	/** Git repos on both sides: `git pull` on each. */
	pull: string[];
	/** Paths rsync must not touch: git repos on both sides, and conflicts. */
	exclude: string[];
	/** Paths that are a git repo on one side but a plain folder on the other. */
	conflicts: string[];
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

const PULL = `
cd -- "$1" || exit 3
shift
export GIT_TERMINAL_PROMPT=0
for d in "$@"; do
  if out=$(git -C "$d" pull --ff-only 2>&1); then printf 'ok  %s\\n' "$d"; else printf 'ERR %s\\n' "$d"; printf '%s\\n' "$out" | sed 's/^/    /'; fi
done
`;

/** Decide what to pull and what rsync leaves alone. A git path that exists on one side only is copied whole by rsync. */
export function plan(local: Layout, remote: Layout): Plan {
	const out: Plan = { pull: [], exclude: [], conflicts: [], data: [] };
	for (const path of [...new Set([...local.keys(), ...remote.keys()])].sort()) {
		const l = local.get(path);
		const r = remote.get(path);
		if (l && r) {
			out.pull.push(path);
			out.exclude.push(path);
			if (local.get(`${path}/data`) === false || remote.get(`${path}/data`) === false) out.data.push(path);
		} else if (l !== undefined && r !== undefined && l !== r) {
			out.conflicts.push(path);
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
	return [...rules, "--exclude=/.*", "--include=/*/", "--exclude=/*"];
}

const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

function run(cmd: string, args: string[], input?: string): Promise<{ code: number; stdout: string; stderr: string }> {
	return new Promise((resolve) => {
		const child = execFile(cmd, args, { maxBuffer: 64 << 20 }, (err, stdout, stderr) =>
			resolve({ code: err ? (typeof err.code === "number" ? err.code : 1) : 0, stdout, stderr }),
		);
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
		this.opts = ["-o", "ControlMaster=auto", "-o", `ControlPath=${join(tmpdir(), "silky-ssh-%C")}`, "-o", "ControlPersist=60"];
	}
	script(script: string, args: string[]) {
		return run("ssh", [...this.opts, this.host, `sh -s -- ${args.map(q).join(" ")}`], script);
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

async function pullLocal(root: string, paths: string[]): Promise<void> {
	process.env.GIT_TERMINAL_PROMPT = "0";
	for (const p of paths) {
		const res = await run("git", ["-C", join(root, p), "pull", "--ff-only"]);
		if (res.code === 0) console.log(`ok  ${p}`);
		else console.log(`ERR ${p}\n${(res.stderr || res.stdout).trim().replace(/^/gm, "    ")}`);
	}
}

export interface SyncOptions {
	remote?: string;
	dryRun?: boolean;
	force?: boolean;
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

		let p = plan(scanLocal(config.projectsDir), remoteLayout);
		for (const c of p.conflicts) console.log(`skip ${c}: git repo on one side, plain folder on the other`);

		if (p.pull.length) {
			if (opts.dryRun) for (const r of p.pull) console.log(`would pull ${r}`);
			else {
				console.log("git pull (local)");
				await pullLocal(config.projectsDir, p.pull);
				console.log("git pull (server)");
				const res = await ssh.script(PULL, [path, ...p.pull]);
				process.stdout.write(res.stdout);
				if (res.code !== 0) throw new Error(`git pull on server failed: ${res.stderr.trim()}`);
				// A pull can change what is gitignored, and so which data/ dirs rsync syncs.
				const again = await ssh.script(PROBE, [path]);
				if (again.code !== 0) throw new Error(`ssh ${remote.host} failed: ${again.stderr.trim()}`);
				p = plan(scanLocal(config.projectsDir), parseProbe(again.stdout).layout);
			}
		}

		const rsync = ["-a", "--update", "-e", ["ssh", ...ssh.opts].map(q).join(" "), ...filters(p)];
		if (opts.dryRun) rsync.push("--dry-run");
		const there = `${remote.host}:${path}/`;
		const here = `${config.projectsDir}/`;
		console.log("rsync data (local → server)");
		if ((await runInherit("rsync", [...rsync, "--out-format=↑ %n", here, there])) !== 0) throw new Error("rsync to server failed");
		console.log("rsync data (server → local)");
		if ((await runInherit("rsync", [...rsync, "--out-format=↓ %n", there, here])) !== 0) throw new Error("rsync from server failed");
	} finally {
		await ssh.close();
	}
}
