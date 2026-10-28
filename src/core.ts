import { existsSync, readFileSync } from "node:fs";
import { mkdir, open, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Config } from "./config.ts";
import { type AgentMeta, type Held, type ProjectMeta, Store, listDirs, timestamp, tmuxName } from "./store.ts";
import * as tmux from "./tmux.ts";

export type SilkyEvent =
	| { type: "started"; project: string; agent: string }
	| { type: "tool"; project: string; agent: string; toolName: string; args: any }
	| { type: "finished"; project: string; agent: string; ok: boolean; text: string; error?: string }
	| { type: "interrupted"; project: string; agent: string }
	| { type: "project_archived"; project: string };

export interface AgentStatus {
	name: string;
	status: "idle" | "running";
	unread: number;
	queued: number;
}

export interface ProjectStatus {
	name: string;
	agents: AgentStatus[];
}

export type SendResult = { started: true } | { queued: number };

const PROJECT_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/;
/** A run whose script hasn't written its pid file by then never started. */
const START_GRACE_MS = 20_000;

interface Tail {
	project: string;
	agent: string;
	run: string;
	offset: number;
	rest: string;
	startedAt: number;
	captureSession: boolean;
	lastText: string;
	error?: string;
	timer?: NodeJS.Timeout;
	busy: boolean;
}

export class Silky {
	readonly config: Config;
	readonly store: Store;
	private tails = new Map<string, Tail>();
	private listeners = new Set<(e: SilkyEvent) => void>();
	private mutex: Promise<unknown> = Promise.resolve();

	constructor(config: Config) {
		this.config = config;
		this.store = new Store(config.silkyDir);
	}

	on(listener: (e: SilkyEvent) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	private emit(e: SilkyEvent): void {
		for (const l of this.listeners) {
			try {
				l(e);
			} catch (err) {
				console.error("listener failed", err);
			}
		}
	}

	/** Serializes every read-modify-write of `.silky` and tmux. */
	private lock<T>(fn: () => Promise<T>): Promise<T> {
		const job = this.mutex.then(fn);
		this.mutex = job.catch(() => {});
		return job;
	}

	private get env(): Record<string, string> {
		return { PATH: process.env.PATH ?? "", SILKY_PI: this.config.piBin, SILKY_NODE: this.config.nodeBin };
	}

	folder(project: string): string {
		return join(this.config.projectsDir, project);
	}

	async start(): Promise<void> {
		await mkdir(this.config.silkyDir, { recursive: true });
		await this.reconcile();
	}

	stopAll(): void {
		for (const t of this.tails.values()) clearTimeout(t.timer);
		this.tails.clear();
	}

	// ── Reconcile ────────────────────────────────────────────────────────────

	reconcile(): Promise<void> {
		return this.lock(() => this.doReconcile());
	}

	private async doReconcile(): Promise<void> {
		const folders = new Set(await this.listProjects());
		for (const p of await this.store.projectsWithMeta()) {
			if (!folders.has(p)) {
				await this.archiveProject(p);
				continue;
			}
			const meta = await this.ensureProjectMeta(p);
			for (const a of await this.store.agents(p)) {
				const am = await this.store.agent(p, a);
				if (!am) continue;
				await tmux.ensureWindow(meta.tmuxSession, am.window, this.folder(p), this.env);
				if (this.tails.has(key(p, a))) continue;
				if (am.status === "running" && am.lastRun) {
					const runs = this.store.runsDir(p, a);
					if (existsSync(join(runs, `${am.lastRun}.exit`)) || pidAlive(join(runs, `${am.lastRun}.pid`))) {
						this.startTail(p, a, am.lastRun, await readOffset(runs, am.lastRun), am.sessionId === null);
					} else {
						await this.store.updateAgent(p, a, (m) => void (m.status = "idle"));
						this.emit({ type: "interrupted", project: p, agent: a });
						await this.startNext(p, a);
					}
				} else if (am.queue.length > 0) {
					await this.startNext(p, a);
				}
			}
		}
		const state = await this.store.state();
		let changed = false;
		for (const g of Object.values(state.gateways)) {
			if (g.active.mode === "agent" && !(await this.store.agent(g.active.project, g.active.agent))) {
				g.active = { mode: "manager" };
				changed = true;
			}
		}
		if (changed) await this.store.saveState(state);
	}

	private async archiveProject(p: string): Promise<void> {
		const meta = await this.store.project(p);
		for (const a of await this.store.agents(p)) this.untail(p, a);
		if (meta) await tmux.killSession(meta.tmuxSession);
		await this.store.archive(p);
		this.emit({ type: "project_archived", project: p });
	}

	private async ensureProjectMeta(p: string): Promise<ProjectMeta> {
		const existing = await this.store.project(p);
		if (existing) return existing;
		const taken = new Set<string>();
		for (const other of await this.store.projectsWithMeta()) {
			const m = other === p ? null : await this.store.project(other);
			if (m) taken.add(m.tmuxSession);
		}
		let session = tmuxName(p);
		for (let i = 2; taken.has(session); i++) session = `${tmuxName(p)}_${i}`;
		const meta = { tmuxSession: session, nextAgentNum: 1 };
		await this.store.saveProject(p, meta);
		return meta;
	}

	// ── Queries ──────────────────────────────────────────────────────────────

	/** Every non-dot subfolder of PROJECTS_DIR is a project. */
	listProjects(): Promise<string[]> {
		return listDirs(this.config.projectsDir);
	}

	agents(project: string): Promise<string[]> {
		return this.store.agents(project);
	}

	agent(project: string, agent: string): Promise<AgentMeta | null> {
		return this.store.agent(project, agent);
	}

	async status(): Promise<ProjectStatus[]> {
		const out: ProjectStatus[] = [];
		for (const p of await this.listProjects()) {
			const agents: AgentStatus[] = [];
			for (const a of await this.store.agents(p)) {
				const m = await this.store.agent(p, a);
				if (m) agents.push({ name: a, status: m.status, unread: m.unread, queued: m.queue.length });
			}
			out.push({ name: p, agents });
		}
		return out;
	}

	// ── Projects and agents ──────────────────────────────────────────────────

	/** Creates the folder if needed and makes sure the project has at least one agent. */
	createProject(name: string): Promise<{ agent: string; existed: boolean }> {
		return this.lock(async () => {
			if (!PROJECT_NAME.test(name)) {
				throw new Error("Project names use letters, digits, '.', '_' or '-', start with a letter or digit, and are at most 40 characters.");
			}
			const existed = existsSync(this.folder(name));
			await mkdir(this.folder(name), { recursive: true });
			const agents = await this.store.agents(name);
			return { agent: agents[0] ?? (await this.doCreateAgent(name)), existed };
		});
	}

	/** Returns the project's first agent, creating one if it has none. */
	ensureAgent(project: string): Promise<string> {
		return this.lock(async () => {
			if (!existsSync(this.folder(project))) throw new Error(`No project named ${project}.`);
			return (await this.store.agents(project))[0] ?? (await this.doCreateAgent(project));
		});
	}

	createAgent(project: string): Promise<string> {
		return this.lock(async () => {
			if (!existsSync(this.folder(project))) throw new Error(`No project named ${project}.`);
			return this.doCreateAgent(project);
		});
	}

	private async doCreateAgent(p: string): Promise<string> {
		const meta = await this.ensureProjectMeta(p);
		const name = `${p}-agent-${meta.nextAgentNum}`;
		meta.nextAgentNum++;
		await this.store.saveProject(p, meta);
		const am: AgentMeta = { window: tmuxName(name), sessionId: null, status: "idle", lastRun: null, unread: 0, held: null, queue: [] };
		await this.store.saveAgent(p, name, am);
		await tmux.ensureWindow(meta.tmuxSession, am.window, this.folder(p), this.env);
		return name;
	}

	/** Kills the agent's window and moves its metadata to the archive. Returns the agents left. */
	archiveAgent(project: string, agent: string): Promise<string[]> {
		return this.lock(async () => {
			const meta = await this.store.project(project);
			const am = await this.store.agent(project, agent);
			if (!meta || !am) throw new Error(`No agent named ${agent}.`);
			this.untail(project, agent);
			await tmux.killWindow(meta.tmuxSession, am.window);
			await this.store.archive(project, agent);
			return this.store.agents(project);
		});
	}

	// ── Runs ─────────────────────────────────────────────────────────────────

	/** Starts a run, or queues the text if the agent is busy. */
	send(project: string, agent: string, text: string): Promise<SendResult> {
		return this.lock(async () => {
			const am = await this.store.agent(project, agent);
			if (!am) throw new Error(`No agent named ${agent}.`);
			if (am.status === "running" || am.queue.length > 0) {
				const m = await this.store.updateAgent(project, agent, (m) => void m.queue.push(text));
				return { queued: m.queue.length };
			}
			await this.startRun(project, agent, text);
			return { started: true };
		});
	}

	/** Ctrl-C in the agent's window. Queued messages still run afterwards. */
	stop(project: string, agent: string): Promise<boolean> {
		return this.lock(async () => {
			const meta = await this.store.project(project);
			const am = await this.store.agent(project, agent);
			if (!meta || !am || am.status !== "running") return false;
			await tmux.interrupt(meta.tmuxSession, am.window);
			return true;
		});
	}

	/** The next run starts a fresh pi session. The old one stays on disk. */
	clear(project: string, agent: string): Promise<void> {
		return this.lock(async () => {
			await this.store.updateAgent(project, agent, (m) => void (m.sessionId = null));
			const t = this.tails.get(key(project, agent));
			if (t) t.captureSession = false;
		});
	}

	/** Stores a finished run's answer for an agent that isn't being looked at. */
	hold(project: string, agent: string, text: string, ok: boolean): Promise<void> {
		return this.lock(async () => {
			if (!(await this.store.agent(project, agent))) return;
			await this.store.updateAgent(project, agent, (m) => {
				m.unread++;
				m.held = { text, ok, earlier: m.held ? m.held.earlier + 1 : 0 };
			});
		});
	}

	takeHeld(project: string, agent: string): Promise<Held | null> {
		return this.lock(async () => {
			const am = await this.store.agent(project, agent);
			if (!am?.held) return null;
			const held = am.held;
			await this.store.updateAgent(project, agent, (m) => {
				m.held = null;
				m.unread = 0;
			});
			return held;
		});
	}

	private async startRun(p: string, a: string, text: string): Promise<void> {
		const meta = await this.ensureProjectMeta(p);
		const am = await this.store.agent(p, a);
		if (!am) return;
		await tmux.ensureWindow(meta.tmuxSession, am.window, this.folder(p), this.env);
		const dir = this.store.agentDir(p, a);
		const run = timestamp();
		await mkdir(join(dir, "runs"), { recursive: true });
		await writeFile(join(dir, "prompt.md"), text);
		await this.store.updateAgent(p, a, (m) => {
			m.status = "running";
			m.lastRun = run;
		});
		const cmd = [this.config.runScript, dir, run, ...(am.sessionId ? [am.sessionId] : [])].map(tmux.shellQuote).join(" ");
		await tmux.sendLine(meta.tmuxSession, am.window, cmd);
		this.emit({ type: "started", project: p, agent: a });
		this.startTail(p, a, run, 0, am.sessionId === null);
	}

	/** Runs everything queued while the agent was busy as one prompt. */
	private async startNext(p: string, a: string): Promise<void> {
		const am = await this.store.agent(p, a);
		if (!am || am.status !== "idle" || am.queue.length === 0) return;
		const text = am.queue.join("\n\n");
		await this.store.updateAgent(p, a, (m) => void (m.queue = []));
		await this.startRun(p, a, text);
	}

	// ── Tailing ──────────────────────────────────────────────────────────────

	private startTail(project: string, agent: string, run: string, offset: number, captureSession: boolean): void {
		const t: Tail = { project, agent, run, offset, rest: "", startedAt: Date.now(), captureSession, lastText: "", busy: false };
		this.tails.set(key(project, agent), t);
		if (offset > 0) t.lastText = recoverLastText(join(this.store.runsDir(project, agent), `${run}.jsonl`), offset);
		this.schedule(t, 0);
	}

	private untail(project: string, agent: string): void {
		const t = this.tails.get(key(project, agent));
		if (t) clearTimeout(t.timer);
		this.tails.delete(key(project, agent));
	}

	private schedule(t: Tail, ms = this.config.pollMs): void {
		t.timer = setTimeout(() => {
			this.poll(t).catch((err) => {
				console.error(`tail ${t.agent} failed`, err);
				if (this.tails.get(key(t.project, t.agent)) === t) this.schedule(t);
			});
		}, ms);
	}

	private async poll(t: Tail): Promise<void> {
		if (this.tails.get(key(t.project, t.agent)) !== t) return;
		const runs = this.store.runsDir(t.project, t.agent);
		const base = join(runs, t.run);
		const got = await this.readNew(t, `${base}.jsonl`);
		if (got) await writeFile(`${base}.offset`, String(t.offset));

		const exitCode = await readExit(`${base}.exit`);
		if (exitCode !== null && !got) return this.finish(t, exitCode, base);
		if (exitCode === null && !got) {
			const hasPid = existsSync(`${base}.pid`);
			const dead = hasPid ? !pidAlive(`${base}.pid`) : Date.now() - t.startedAt > START_GRACE_MS;
			// Re-check .exit: the script writes it just before exiting.
			if (dead && (await readExit(`${base}.exit`)) === null) return this.interrupted(t);
		}
		this.schedule(t);
	}

	private async readNew(t: Tail, file: string): Promise<boolean> {
		let size: number;
		try {
			size = (await stat(file)).size;
		} catch {
			return false;
		}
		if (size <= t.offset) return false;
		const fh = await open(file, "r");
		try {
			const buf = Buffer.alloc(size - t.offset);
			await fh.read(buf, 0, buf.length, t.offset);
			const chunk = buf.toString("utf8");
			const lastNl = chunk.lastIndexOf("\n");
			if (lastNl < 0) return false;
			t.offset += Buffer.byteLength(chunk.slice(0, lastNl + 1));
			for (const line of chunk.slice(0, lastNl).split("\n")) await this.handleLine(t, line);
			return true;
		} finally {
			await fh.close();
		}
	}

	private async handleLine(t: Tail, line: string): Promise<void> {
		let ev: any;
		try {
			ev = JSON.parse(line);
		} catch {
			return;
		}
		if (ev.type === "session" && t.captureSession && ev.id) {
			t.captureSession = false;
			await this.lock(() => this.store.updateAgent(t.project, t.agent, (m) => void (m.sessionId = ev.id)).catch(() => {}));
		} else if (ev.type === "tool_execution_start") {
			this.emit({ type: "tool", project: t.project, agent: t.agent, toolName: ev.toolName, args: ev.args });
		} else if (ev.type === "message_end" && ev.message?.role === "assistant") {
			const text = messageText(ev.message);
			if (text) t.lastText = text;
			if (ev.message.stopReason === "error") t.error = ev.message.errorMessage ?? "error";
			else if (ev.message.stopReason === "aborted") t.error = "aborted";
			else t.error = undefined;
		}
	}

	private async finish(t: Tail, exitCode: number, base: string): Promise<void> {
		this.untail(t.project, t.agent);
		let error = t.error;
		if (exitCode === 130) error = "stopped";
		else if (exitCode !== 0) error = (await tailOf(`${base}.err`)) || `pi exited with code ${exitCode}`;
		await this.lock(async () => {
			if (!(await this.store.agent(t.project, t.agent))) return;
			await this.store.updateAgent(t.project, t.agent, (m) => void (m.status = "idle"));
			this.emit({ type: "finished", project: t.project, agent: t.agent, ok: !error, text: t.lastText, error });
			await this.startNext(t.project, t.agent);
		});
	}

	private async interrupted(t: Tail): Promise<void> {
		this.untail(t.project, t.agent);
		await this.lock(async () => {
			if (!(await this.store.agent(t.project, t.agent))) return;
			await this.store.updateAgent(t.project, t.agent, (m) => void (m.status = "idle"));
			this.emit({ type: "interrupted", project: t.project, agent: t.agent });
			await this.startNext(t.project, t.agent);
		});
	}
}

const key = (p: string, a: string) => `${p}\0${a}`;

export function messageText(message: any): string {
	return (message?.content ?? [])
		.filter((c: any) => c.type === "text")
		.map((c: any) => c.text)
		.join("\n")
		.trim();
}

function pidAlive(pidFile: string): boolean {
	try {
		const pid = Number(readFileSync(pidFile, "utf8").trim());
		if (!pid) return false;
		process.kill(pid, 0);
		return readFileSync(`/proc/${pid}/cmdline`, "utf8").includes("silky-run");
	} catch {
		return false;
	}
}

async function readExit(file: string): Promise<number | null> {
	try {
		const n = parseInt(await readFile(file, "utf8"), 10);
		return Number.isNaN(n) ? 1 : n;
	} catch {
		return null;
	}
}

async function readOffset(runs: string, run: string): Promise<number> {
	try {
		return Number(await readFile(join(runs, `${run}.offset`), "utf8")) || 0;
	} catch {
		return 0;
	}
}

async function tailOf(file: string, n = 500): Promise<string> {
	try {
		return (await readFile(file, "utf8")).trim().slice(-n);
	} catch {
		return "";
	}
}

/** After a restart, the final answer may be in the part of the log already read. */
function recoverLastText(file: string, upTo: number): string {
	try {
		const lines = readFileSync(file).subarray(0, upTo).toString("utf8").split("\n");
		for (let i = lines.length - 1; i >= 0; i--) {
			if (!lines[i].includes('"message_end"')) continue;
			const ev = JSON.parse(lines[i]);
			if (ev.message?.role === "assistant") {
				const text = messageText(ev.message);
				if (text) return text;
			}
		}
	} catch {}
	return "";
}
