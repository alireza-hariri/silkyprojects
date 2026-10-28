import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export type Active = { mode: "manager" } | { mode: "agent"; project: string; agent: string };

export interface GatewayState {
	ownerId?: number;
	chatId?: number;
	active: Active;
}

export interface State {
	gateways: Record<string, GatewayState>;
}

export interface ProjectMeta {
	tmuxSession: string;
	nextAgentNum: number;
}

export interface Held {
	text: string;
	ok: boolean;
	earlier: number;
}

export interface AgentMeta {
	window: string;
	sessionId: string | null;
	status: "idle" | "running";
	lastRun: string | null;
	unread: number;
	held: Held | null;
	queue: string[];
}

/** Characters tmux can't take in a target name become `_`. */
export function tmuxName(name: string): string {
	return name.replace(/[^A-Za-z0-9_-]/g, "_");
}

export function timestamp(d = new Date()): string {
	return d.toISOString().replace(/[-:]/g, "").replace("T", "-").replace(/\..*/, "") + "-" + String(d.getMilliseconds()).padStart(3, "0");
}

/** JSON files under PROJECTS_DIR/.silky. Writes go through one in-process queue. */
export class Store {
	readonly dir: string;
	private queue: Promise<unknown> = Promise.resolve();

	constructor(silkyDir: string) {
		this.dir = silkyDir;
	}

	projectDir(project: string): string {
		return join(this.dir, "projects", project);
	}

	agentDir(project: string, agent: string): string {
		return join(this.projectDir(project), "agents", agent);
	}

	runsDir(project: string, agent: string): string {
		return join(this.agentDir(project, agent), "runs");
	}

	get managerDir(): string {
		return join(this.dir, "manager");
	}

	private async readJson<T>(path: string): Promise<T | null> {
		try {
			return JSON.parse(await readFile(path, "utf8")) as T;
		} catch (e: any) {
			if (e.code === "ENOENT") return null;
			throw e;
		}
	}

	private writeJson(path: string, value: unknown): Promise<void> {
		const job = this.queue.then(async () => {
			await mkdir(dirname(path), { recursive: true });
			const tmp = `${path}.tmp`;
			await writeFile(tmp, JSON.stringify(value, null, 2) + "\n");
			await rename(tmp, path);
		});
		this.queue = job.catch(() => {});
		return job;
	}

	async state(): Promise<State> {
		return (await this.readJson<State>(join(this.dir, "state.json"))) ?? { gateways: {} };
	}

	saveState(state: State): Promise<void> {
		return this.writeJson(join(this.dir, "state.json"), state);
	}

	async gateway(name: string): Promise<GatewayState> {
		return (await this.state()).gateways[name] ?? { active: { mode: "manager" } };
	}

	async updateGateway(name: string, fn: (g: GatewayState) => void): Promise<GatewayState> {
		const state = await this.state();
		const g = state.gateways[name] ?? { active: { mode: "manager" } };
		fn(g);
		state.gateways[name] = g;
		await this.saveState(state);
		return g;
	}

	project(project: string): Promise<ProjectMeta | null> {
		return this.readJson<ProjectMeta>(join(this.projectDir(project), "project.json"));
	}

	saveProject(project: string, meta: ProjectMeta): Promise<void> {
		return this.writeJson(join(this.projectDir(project), "project.json"), meta);
	}

	async projectsWithMeta(): Promise<string[]> {
		return listDirs(join(this.dir, "projects"));
	}

	async agents(project: string): Promise<string[]> {
		const names = await listDirs(join(this.projectDir(project), "agents"));
		return names.sort((a, b) => agentNum(a) - agentNum(b));
	}

	agent(project: string, agent: string): Promise<AgentMeta | null> {
		return this.readJson<AgentMeta>(join(this.agentDir(project, agent), "agent.json"));
	}

	saveAgent(project: string, agent: string, meta: AgentMeta): Promise<void> {
		return this.writeJson(join(this.agentDir(project, agent), "agent.json"), meta);
	}

	async updateAgent(project: string, agent: string, fn: (a: AgentMeta) => void): Promise<AgentMeta> {
		const meta = await this.agent(project, agent);
		if (!meta) throw new Error(`unknown agent ${agent}`);
		fn(meta);
		await this.saveAgent(project, agent, meta);
		return meta;
	}

	/** Move a project's or an agent's metadata into archive/<ts>-<project>/, keeping its layout. */
	async archive(project: string, agent?: string): Promise<string> {
		await this.queue;
		const dest = join(this.dir, "archive", `${timestamp()}-${project}`);
		const src = agent ? this.agentDir(project, agent) : this.projectDir(project);
		const target = agent ? join(dest, "agents", agent) : dest;
		await mkdir(dirname(target), { recursive: true });
		if (existsSync(src)) await rename(src, target);
		return target;
	}

	async removeProjectMeta(project: string): Promise<void> {
		await rm(this.projectDir(project), { recursive: true, force: true });
	}
}

export function agentNum(name: string): number {
	const m = /-agent-(\d+)$/.exec(name);
	return m ? Number(m[1]) : 0;
}

export async function listDirs(dir: string): Promise<string[]> {
	try {
		const entries = await readdir(dir, { withFileTypes: true });
		return entries.filter((e) => e.isDirectory() && !e.name.startsWith(".")).map((e) => e.name).sort();
	} catch (e: any) {
		if (e.code === "ENOENT") return [];
		throw e;
	}
}
