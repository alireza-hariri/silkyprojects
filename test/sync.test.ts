import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, test } from "node:test";
import { loadConfig, ROOT } from "../src/config.ts";
import { filters, parseRemote, plan, savedRemote, sync } from "../src/sync.ts";

let dir: string;

const git = (cwd: string, ...args: string[]) =>
	execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "init.defaultBranch=main", ...args], { cwd, encoding: "utf8" });

function write(path: string, text: string, ageS = 0): void {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, text);
	const t = Date.now() / 1000 - ageS;
	utimesSync(path, t, t);
}

/** A bare origin with one commit, cloned to `to` on both sides. */
function repo(name: string, ...to: string[]): string {
	const origin = join(dir, "origins", `${name}.git`);
	const work = join(dir, "work", name);
	git(dir, "init", "-q", "--bare", origin);
	git(dir, "clone", "-q", origin, work);
	write(join(work, "README"), "v1");
	git(work, "add", ".");
	git(work, "commit", "-qm", "v1");
	git(work, "push", "-q", "origin", "HEAD");
	for (const t of to) git(dir, "clone", "-q", origin, t);
	return work;
}

before(() => {
	dir = mkdtempSync(join(tmpdir(), "silky-sync-"));
	process.env.PATH = `${join(ROOT, "test/fixtures/bin")}:${process.env.PATH}`;
});

after(() => rmSync(dir, { recursive: true, force: true }));

test("plan: pull shared repos, skip conflicts, copy one-sided repos", () => {
	const local = new Map([["app", true], ["data", false], ["mix", false], ["mix/lib", true], ["mix/d", false], ["c", true], ["new", true]]);
	const remote = new Map([["app", true], ["data", false], ["mix", false], ["mix/lib", true], ["c", false]]);
	assert.deepEqual(plan(local, remote), { pull: ["app", "mix/lib"], exclude: ["app", "c", "mix/lib"], conflicts: ["c"], data: [] });
	assert.deepEqual(filters({ exclude: ["a*b"], data: [] }), ["--exclude=/a\\*b/", "--exclude=/.*", "--include=/*/", "--exclude=/*"]);
	local.set("app/data", false);
	assert.deepEqual(plan(local, remote).data, ["app"]);
	assert.deepEqual(parseRemote("me@box:/srv/p"), { host: "me@box", path: "/srv/p" });
	assert.throws(() => parseRemote("box"));
});

test("sync: git pull on both sides, newer data file wins", async () => {
	const L = join(dir, "local");
	const R = join(dir, "remote");
	const work = repo("app", join(L, "app"), join(R, "app"));
	repo("lib", join(L, "mixed/lib"), join(R, "mixed/lib"));
	const big = repo("big", join(L, "big"), join(R, "big"));
	write(join(big, ".gitignore"), "/data/\n");
	git(big, "add", ".");
	git(big, "commit", "-qm", "ignore data");
	git(big, "push", "-q");
	write(join(work, "README"), "v2");
	git(work, "commit", "-qam", "v2");
	git(work, "push", "-q");

	write(join(L, "notes/a.txt"), "local new", 10);
	write(join(R, "notes/a.txt"), "remote old", 100);
	write(join(L, "notes/b.txt"), "local old", 100);
	write(join(R, "notes/b.txt"), "remote new", 10);
	write(join(L, "notes/only-local.txt"), "x");
	write(join(R, "mixed/data/r.txt"), "from server");
	write(join(L, "mixed/lib/untracked.txt"), "stays local");
	write(join(L, ".silky/state.json"), "{}");
	write(join(L, "loose.txt"), "top-level file");
	git(L, "init", "-q", join(L, "conflict"));
	write(join(R, "conflict/f.txt"), "plain folder on the server");
	git(L, "init", "-q", join(L, "newrepo"));
	write(join(L, "big/data/video.mp4"), "big local file");
	write(join(L, "big/scratch.txt"), "untracked, stays local");

	const config = loadConfig({ projectsDir: L });
	await sync(config, { remote: `box:${R}` });

	assert.equal(readFileSync(join(L, "app/README"), "utf8"), "v2");
	assert.equal(readFileSync(join(R, "app/README"), "utf8"), "v2");
	assert.equal(readFileSync(join(R, "notes/a.txt"), "utf8"), "local new");
	assert.equal(readFileSync(join(L, "notes/b.txt"), "utf8"), "remote new");
	assert.ok(existsSync(join(R, "notes/only-local.txt")));
	assert.equal(readFileSync(join(L, "mixed/data/r.txt"), "utf8"), "from server");
	assert.ok(!existsSync(join(R, "mixed/lib/untracked.txt")));
	assert.ok(!existsSync(join(R, ".silky")));
	assert.ok(!existsSync(join(R, "loose.txt")));
	assert.ok(!existsSync(join(L, "conflict/f.txt")));
	assert.ok(existsSync(join(R, "newrepo/.git")));
	assert.equal(readFileSync(join(R, "big/.gitignore"), "utf8"), "/data/\n", "pulled");
	assert.equal(readFileSync(join(R, "big/data/video.mp4"), "utf8"), "big local file", "gitignored data/ is rsynced");
	assert.ok(!existsSync(join(R, "big/scratch.txt")));
	assert.equal(savedRemote(config), `box:${R}`);

	// The saved server is used when none is given.
	write(join(R, "notes/later.txt"), "y");
	await sync(config, {});
	assert.ok(existsSync(join(L, "notes/later.txt")));
});
