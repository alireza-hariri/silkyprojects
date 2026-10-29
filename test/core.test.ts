import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { loadConfig, ROOT } from "../src/config.ts";
import { Silky, type SilkyEvent } from "../src/core.ts";

// Every test session gets a unique prefix so a real tmux server is safe to share.
const prefix = `t${process.pid}`;
let dir: string;

function make(): Silky {
	return new Silky(loadConfig({ projectsDir: dir, piBin: join(ROOT, "test/fixtures/fake-pi"), pollMs: 50 }));
}

function next(silky: Silky, type: SilkyEvent["type"], agent?: string): Promise<SilkyEvent> {
	return new Promise((resolve) => {
		const off = silky.on((e) => {
			if (e.type === type && (!agent || ("agent" in e && e.agent === agent))) {
				off();
				resolve(e);
			}
		});
	});
}

const sessions = () => {
	try {
		return execFileSync("tmux", ["list-sessions", "-F", "#{session_name}"], { encoding: "utf8" }).split("\n");
	} catch {
		return [];
	}
};

before(() => {
	dir = mkdtempSync(join(tmpdir(), "silky-test-"));
});

after(() => {
	for (const s of sessions()) if (s.startsWith(prefix)) execFileSync("tmux", ["kill-session", "-t", `=${s}`]);
	rmSync(dir, { recursive: true, force: true });
});

test("create project, run, resume session", async () => {
	const silky = make();
	await silky.start();
	const p = `${prefix}-a`;
	const { agent, existed } = await silky.createProject(p);
	assert.equal(agent, `${p}-agent-1`);
	assert.equal(existed, false);
	assert.ok(sessions().includes(p));

	let done = next(silky, "finished", agent);
	await silky.send(p, agent, "first");
	const first = (await done) as Extract<SilkyEvent, { type: "finished" }>;
	assert.ok(first.ok);
	assert.match(first.text, /first$/);
	const sid = (await silky.agent(p, agent))!.sessionId;
	assert.ok(sid);

	done = next(silky, "finished", agent);
	await silky.send(p, agent, "second");
	const second = (await done) as Extract<SilkyEvent, { type: "finished" }>;
	assert.ok(second.text.includes(sid!), "second run reuses the session");

	await silky.clear(p, agent);
	done = next(silky, "finished", agent);
	await silky.send(p, agent, "third");
	await done;
	assert.notEqual((await silky.agent(p, agent))!.sessionId, sid);
	silky.stopAll();
});

test("queue while busy, then stop", async () => {
	const silky = make();
	await silky.start();
	const p = `${prefix}-b`;
	const { agent } = await silky.createProject(p);
	const tool = next(silky, "tool", agent);
	await silky.send(p, agent, "SLEEP30");
	await tool;
	assert.deepEqual(await silky.send(p, agent, "later 1"), { queued: 1 });
	assert.deepEqual(await silky.send(p, agent, "later 2"), { queued: 2 });

	const stopped = next(silky, "finished", agent);
	assert.equal(await silky.stop(p, agent), true);
	const s = (await stopped) as Extract<SilkyEvent, { type: "finished" }>;
	assert.equal(s.ok, false);
	assert.equal(s.error, "stopped");

	const queued = (await next(silky, "finished", agent)) as Extract<SilkyEvent, { type: "finished" }>;
	assert.match(queued.text, /later 1\n\nlater 2$/);
	silky.stopAll();
});

test("failed run reports stderr", async () => {
	const silky = make();
	await silky.start();
	const p = `${prefix}-c`;
	const { agent } = await silky.createProject(p);
	const done = next(silky, "finished", agent);
	await silky.send(p, agent, "FAIL");
	const e = (await done) as Extract<SilkyEvent, { type: "finished" }>;
	assert.equal(e.ok, false);
	assert.match(e.error!, /boom/);
	silky.stopAll();
});

test("daemon restart resumes tailing a running agent", async () => {
	const p = `${prefix}-d`;
	const first = make();
	await first.start();
	const { agent } = await first.createProject(p);
	const tool = next(first, "tool", agent);
	await first.send(p, agent, "SLEEP2 survive");
	await tool;
	first.stopAll();

	const second = make();
	const done = next(second, "finished", agent);
	await second.start();
	const e = (await done) as Extract<SilkyEvent, { type: "finished" }>;
	assert.match(e.text, /survive$/);
	second.stopAll();
});

test("restart after the window died marks the run interrupted", async () => {
	const p = `${prefix}-e`;
	const first = make();
	await first.start();
	const { agent } = await first.createProject(p);
	const tool = next(first, "tool", agent);
	await first.send(p, agent, "SLEEP30");
	await tool;
	first.stopAll();
	execFileSync("tmux", ["kill-session", "-t", `=${p}`]);

	const second = make();
	const interrupted = next(second, "interrupted", agent);
	await second.start();
	await interrupted;
	assert.equal((await second.agent(p, agent))!.status, "idle");
	assert.ok(sessions().includes(p), "window recreated");
	second.stopAll();
});

test("archive agent, agent numbers are never reused, deleted folder archives the project", async () => {
	const silky = make();
	await silky.start();
	const p = `${prefix}-f`;
	await silky.createProject(p);
	const a2 = await silky.createAgent(p);
	assert.equal(a2, `${p}-agent-2`);
	assert.deepEqual(await silky.archiveAgent(p, a2), [`${p}-agent-1`]);
	assert.equal(await silky.createAgent(p), `${p}-agent-3`);

	await silky.store.updateGateway("telegram", (g) => void (g.active = { mode: "agent", project: p, agent: `${p}-agent-1` }));
	rmSync(join(dir, p), { recursive: true });
	await silky.reconcile();
	assert.ok(!existsSync(join(dir, ".silky/projects", p)));
	assert.ok(readdirSync(join(dir, ".silky/archive")).some((d) => d.endsWith(`-${p}`)));
	assert.ok(!sessions().includes(p));
	assert.deepEqual((await silky.store.gateway("telegram")).active, { mode: "manager" });
	silky.stopAll();
});

test("folder without metadata is a project with zero agents; held answers stack", async () => {
	const silky = make();
	await silky.start();
	const p = `${prefix}-g`;
	execFileSync("mkdir", [join(dir, p)]);
	const status = await silky.status();
	assert.deepEqual(status.find((s) => s.name === p)?.agents, []);
	const agent = await silky.ensureAgent(p);
	await silky.hold(p, agent, "one", true);
	await silky.hold(p, agent, "two", true);
	assert.deepEqual(await silky.takeHeld(p, agent), { text: "two", ok: true, earlier: 1 });
	assert.equal(await silky.takeHeld(p, agent), null);
	silky.stopAll();
});

test("templates and where received files go", async () => {
	const silky = make();
	await silky.start();
	const plain = `${prefix}-plain`;
	const withData = `${prefix}-gd`;
	await silky.createProject(plain, "git");
	await silky.createProject(withData, "git-data");
	assert.ok(existsSync(join(dir, plain, ".git")) && !existsSync(join(dir, plain, "data")));
	assert.equal(execFileSync("git", ["-C", join(dir, withData), "check-ignore", "data/"], { encoding: "utf8" }).trim(), "data/");

	const big = 21 * 1024 * 1024;
	assert.equal(await silky.attachmentPath(plain, "a b.png", big), join(dir, plain, "raw/assets/a_b.png"), "no data/: assets");
	assert.equal(await silky.attachmentPath(withData, "x.png", 10), join(dir, withData, "raw/assets/x.png"));
	assert.equal(await silky.attachmentPath(withData, "../x.mp4", big), join(dir, withData, "data/x.mp4"));
	writeFileSync(join(dir, withData, "data/x.mp4"), "");
	assert.equal(await silky.attachmentPath(withData, "x.mp4", big), join(dir, withData, "data/x-1.mp4"), "never overwrites");
	silky.stopAll();
});
