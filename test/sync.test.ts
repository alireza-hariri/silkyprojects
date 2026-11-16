import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, test } from "node:test";
import { loadConfig, ROOT } from "../src/config.ts";
import { filters, gitAction, parseRemote, plan, sameRepo, savedRemote, sync } from "../src/sync.ts";

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

test("plan: pull shared repos, one-sided repos are cloned or skipped, never rsynced", () => {
	const local = new Map([["app", true], ["data", false], ["mix", false], ["mix/lib", true], ["mix/d", false], ["c", true], ["new", true]]);
	const remote = new Map([["app", true], ["data", false], ["mix", false], ["mix/lib", true], ["c", false]]);
	assert.deepEqual(plan(local, remote), {
		pull: ["app", "mix/lib"],
		exclude: ["app", "c", "mix/lib", "new"],
		oneSided: [
			{ path: "c", from: "local", plain: true },
			{ path: "new", from: "local", plain: false },
		],
		data: [],
	});
	assert.deepEqual(filters({ exclude: ["a*b"], data: [] }), ["--exclude=/a\\*b/", "--exclude=**/node_modules/", "--exclude=**/.venv/", "--exclude=/.*", "--include=/*/", "--exclude=/*"]);
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
	assert.ok(!existsSync(join(R, "newrepo")), "empty one-sided repo has nothing to clone from: skipped");
	assert.equal(readFileSync(join(R, "big/.gitignore"), "utf8"), "/data/\n", "pulled");
	assert.equal(readFileSync(join(R, "big/data/video.mp4"), "utf8"), "big local file", "gitignored data/ is rsynced");
	assert.ok(!existsSync(join(R, "big/scratch.txt")));
	assert.equal(savedRemote(config), `box:${R}`);

	// The saved server is used when none is given.
	write(join(R, "notes/later.txt"), "y");
	await sync(config, {});
	assert.ok(existsSync(join(L, "notes/later.txt")));
});

test("sameRepo and gitAction", () => {
	assert.ok(sameRepo("git@github.com:a/b.git", "https://github.com/a/b"));
	assert.ok(sameRepo("ssh://git@github.com/a/b.git", "https://user@github.com/a/b/"));
	assert.ok(!sameRepo("git@github.com:a/b.git", "git@github.com:a/c.git"));
	assert.ok(!sameRepo("", ""));
	const full = { empty: false, branch: "main", origin: "u" };
	const empty = { empty: true, branch: "master", origin: "" };
	assert.deepEqual(gitAction(full, empty), { kind: "seed", to: "server", branch: "main", origin: "u" });
	assert.deepEqual(gitAction(empty, full), { kind: "seed", to: "local", branch: "main", origin: "u" });
	assert.deepEqual(gitAction(empty, empty), { kind: "skip" });
	assert.deepEqual(gitAction(full, full), { kind: "pull" });
});

/** What /create_project's "Git + data dir" template leaves: a repo with no commits. */
function template(at: string): void {
	git(dir, "init", "-q", "-b", "master", at);
	write(join(at, "raw/assets/.gitkeep"), "");
	write(join(at, ".gitignore"), "/data/\n");
	write(join(at, "data/server.csv"), "server data");
}

test("sync: an empty repo on one side is filled from the other, and a server that can't fetch gets local's origin refs", async () => {
	const L = join(dir, "seed-local");
	const R = join(dir, "seed-remote");
	const work = repo("seeded", join(L, "app"));
	write(join(work, ".gitignore"), "/data/\nnode_modules/\n");
	git(work, "add", ".");
	git(work, "commit", "-qm", "gitignore");
	git(work, "push", "-q");
	git(join(L, "app"), "pull", "-q");
	template(join(R, "app"));
	// The other direction: the server has the repo, the laptop has the template.
	repo("back", join(R, "back"));
	template(join(L, "back"));

	const config = loadConfig({ projectsDir: L });
	await sync(config, { remote: `box:${R}` });

	const s = join(R, "app");
	assert.equal(git(s, "rev-parse", "HEAD"), git(join(L, "app"), "rev-parse", "HEAD"));
	assert.equal(git(s, "rev-parse", "--abbrev-ref", "@{u}").trim(), "origin/main");
	assert.equal(git(s, "remote", "get-url", "origin").trim(), git(work, "remote", "get-url", "origin").trim());
	assert.equal(readFileSync(join(s, ".gitignore"), "utf8"), "/data/\nnode_modules/\n");
	assert.equal(git(s, "status", "--porcelain", "--", ".gitignore"), "", "checked out clean");
	assert.equal(readFileSync(join(s, "data/server.csv"), "utf8"), "server data", "gitignored data kept");
	assert.equal(readFileSync(join(L, "app/data/server.csv"), "utf8"), "server data", "and synced");
	assert.equal(git(join(L, "back"), "rev-parse", "--abbrev-ref", "HEAD").trim(), "main");
	assert.ok(existsSync(join(L, "back/README")));

	// The server loses access to origin; a new commit still reaches it through the laptop.
	git(s, "config", "remote.origin.uploadpack", "false");
	write(join(work, "README"), "v2");
	git(work, "commit", "-qam", "v2");
	git(work, "push", "-q");
	await sync(config, {});
	assert.equal(readFileSync(join(s, "README"), "utf8"), "v2");
});

test("sync: a repo on one side only is cloned where origin is readable, else left out entirely", async () => {
	const L = join(dir, "one-local");
	const R = join(dir, "one-remote");
	// Local only, with an unpushed commit and gitignored data: pushed, then cloned on the server.
	const solo = join(L, "solo");
	repo("solo", solo);
	write(join(solo, ".gitignore"), "/data/\n");
	git(solo, "add", ".");
	git(solo, "commit", "-qm", "unpushed");
	write(join(solo, "data/d.csv"), "solo data");
	// Local only, but the server can't read its origin: neither the repo nor its data/ goes to the server.
	mkdirSync(join(dir, "denied"));
	const origin = join(dir, "denied/secret.git");
	git(dir, "init", "-q", "--bare", origin);
	git(dir, "clone", "-q", origin, join(L, "secret"));
	write(join(L, "secret/README"), "s");
	write(join(L, "secret/.gitignore"), "/data/\n");
	write(join(L, "secret/data/d.csv"), "secret data");
	git(join(L, "secret"), "add", ".");
	git(join(L, "secret"), "commit", "-qm", "s");
	// Server only: cloned on the laptop.
	repo("back2", join(R, "back2"));
	// Git locally, plain folder (an old copy, edited) on the server: turned into a checkout, edits kept.
	const conv = repo("conv", join(L, "conv"));
	write(join(conv, "b.txt"), "b");
	git(conv, "add", ".");
	git(conv, "commit", "-qm", "b");
	git(conv, "push", "-q");
	git(join(L, "conv"), "pull", "-q");
	write(join(R, "conv/README"), "edited on the server");
	write(join(R, "conv/extra.txt"), "only on the server");

	process.env.FAKE_DENY = join(dir, "denied");
	try {
		await sync(loadConfig({ projectsDir: L }), { remote: `box:${R}` });
	} finally {
		delete process.env.FAKE_DENY;
	}

	assert.equal(git(join(dir, "origins/solo.git"), "log", "-1", "--format=%s").trim(), "unpushed", "pushed to origin");
	assert.equal(git(join(R, "solo"), "log", "-1", "--format=%s").trim(), "unpushed", "cloned on the server");
	assert.equal(readFileSync(join(R, "solo/data/d.csv"), "utf8"), "solo data", "and its data/ synced");
	assert.equal(git(origin, "log", "-1", "--format=%s").trim(), "s", "pushed even though the server can't read it");
	assert.ok(!existsSync(join(R, "secret")), "unreadable origin: the folder is left out entirely");
	assert.equal(git(join(L, "back2"), "rev-parse", "--abbrev-ref", "@{u}").trim(), "origin/main");
	const c = join(R, "conv");
	assert.equal(readFileSync(join(c, "README"), "utf8"), "edited on the server");
	assert.equal(git(c, "status", "--porcelain").split("\n").filter(Boolean).sort().join("|"), " M README|?? extra.txt");
	assert.equal(readFileSync(join(c, "b.txt"), "utf8"), "b", "missing files checked out");
});

test("sync: server commits are pushed through the laptop when the server can't push", async () => {
	const L = join(dir, "push-local");
	const R = join(dir, "push-remote");
	repo("pp", join(L, "pp"), join(R, "pp"));
	const s = join(R, "pp");
	git(s, "config", "remote.origin.receivepack", "false");
	write(join(s, "server.txt"), "from server");
	git(s, "add", ".");
	git(s, "commit", "-qm", "server commit");
	await sync(loadConfig({ projectsDir: L }), { remote: `box:${R}` });
	assert.equal(git(join(dir, "origins/pp.git"), "log", "-1", "--format=%s").trim(), "server commit");
	assert.equal(readFileSync(join(L, "pp/server.txt"), "utf8"), "from server", "and pulled on the laptop");
	assert.equal(git(s, "rev-list", "--count", "@{u}..HEAD").trim(), "0", "server no longer sees it as unpushed");
});

test("sync: offers a GitHub repo for a repo with commits and no remote", async () => {
	const L = join(dir, "gh-local");
	const R = join(dir, "gh-remote");
	process.env.FAKE_GH = join(dir, "github");
	mkdirSync(process.env.FAKE_GH);
	git(dir, "init", "-q", join(L, "fresh"));
	write(join(L, "fresh/a.txt"), "a");
	git(join(L, "fresh"), "add", ".");
	git(join(L, "fresh"), "commit", "-qm", "first");
	mkdirSync(R);
	const asked: string[] = [];
	try {
		await sync(loadConfig({ projectsDir: L }), { remote: `box:${R}`, ask: async (q) => (asked.push(q), "renamed") });
	} finally {
		delete process.env.FAKE_GH;
	}
	assert.match(asked[0], /^fresh \(only on the local\) has commits but no remote\. Create private GitHub repo me\/fresh/);
	const gh = join(dir, "github/renamed.git");
	assert.equal(git(gh, "log", "-1", "--format=%s").trim(), "first");
	assert.equal(git(join(L, "fresh"), "rev-parse", "--abbrev-ref", "@{u}").trim(), "origin/main");
	assert.equal(readFileSync(join(R, "fresh/a.txt"), "utf8"), "a", "then cloned on the server");
});
