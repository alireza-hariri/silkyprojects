import {
	type AgentSession,
	createAgentSession,
	DefaultResourceLoader,
	defineTool,
	getAgentDir,
	SessionManager,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { Silky } from "./core.ts";
import { messageText } from "./core.ts";

/** What the manager can do to the gateway that talks to it. Commands use the same functions. */
export interface Controller {
	status(): Promise<string>;
	createProject(name: string): Promise<string>;
	createAgent(project: string): Promise<string>;
	archiveAgent(project: string, agent: string): Promise<string>;
	setActive(project?: string, agent?: string): Promise<string>;
	sendToAgent(project: string, agent: string, text: string): Promise<string>;
}

const SYSTEM = `You are the silky manager. Your working directory is PROJECTS_DIR: every non-hidden subfolder is a project.
Each project has zero or more coding agents (named <project>-agent-<n>) that run pi in a tmux window inside that folder.
The user talks to you from Telegram. Use the silky tools to list, create, archive and switch between projects and agents;
never edit files under .silky yourself. Use set_active to put the user in front of an agent when they ask to work on something.
You may use bash/read/write for general housekeeping across projects. Keep answers short: they are read on a phone.`;

const text = (t: string) => ({ content: [{ type: "text" as const, text: t }], details: {} });

function tools(c: Controller) {
	return [
		defineTool({
			name: "list_projects",
			label: "List projects",
			description: "List all projects with their agents and whether each is idle or running.",
			parameters: Type.Object({}),
			execute: async () => text(await c.status()),
		}),
		defineTool({
			name: "status",
			label: "Status",
			description: "Same as list_projects, including unread finished runs and queued messages.",
			parameters: Type.Object({}),
			execute: async () => text(await c.status()),
		}),
		defineTool({
			name: "create_project",
			label: "Create project",
			description: "Create a project folder (or adopt an existing one), give it a first agent and make it active.",
			parameters: Type.Object({ name: Type.String({ description: "Folder name: letters, digits, '.', '_', '-'" }) }),
			execute: async (_id, p) => text(await c.createProject(p.name)),
		}),
		defineTool({
			name: "create_agent",
			label: "Create agent",
			description: "Add a new agent to a project and make it active.",
			parameters: Type.Object({ project: Type.String() }),
			execute: async (_id, p) => text(await c.createAgent(p.project)),
		}),
		defineTool({
			name: "archive_agent",
			label: "Archive agent",
			description: "Kill an agent's tmux window and archive its metadata. Only do this when the user asked for it.",
			parameters: Type.Object({ project: Type.String(), agent: Type.String() }),
			execute: async (_id, p) => text(await c.archiveAgent(p.project, p.agent)),
		}),
		defineTool({
			name: "set_active",
			label: "Set active",
			description:
				"Switch what the user's messages go to. No arguments: manager mode. Project only: that project's first agent. Project and agent: that agent.",
			parameters: Type.Object({ project: Type.Optional(Type.String()), agent: Type.Optional(Type.String()) }),
			execute: async (_id, p) => text(await c.setActive(p.project, p.agent)),
		}),
		defineTool({
			name: "send_to_agent",
			label: "Send to agent",
			description: "Send a prompt to a project agent. It runs in the background; the user is pinged when it finishes.",
			parameters: Type.Object({ project: Type.String(), agent: Type.String(), text: Type.String() }),
			execute: async (_id, p) => text(await c.sendToAgent(p.project, p.agent, p.text)),
		}),
	];
}

export interface ManagerReply {
	text: string;
	error?: string;
}

/** The in-process pi session for manager mode. Prompts run one at a time. */
export class Manager {
	private silky: Silky;
	private controller: Controller;
	private session?: AgentSession;
	private chain: Promise<unknown> = Promise.resolve();
	private pending = 0;
	onTool?: (toolName: string, args: any) => void;

	constructor(silky: Silky, controller: Controller) {
		this.silky = silky;
		this.controller = controller;
	}

	get busy(): boolean {
		return this.pending > 0;
	}

	private async open(fresh: boolean): Promise<AgentSession> {
		const cwd = this.silky.config.projectsDir;
		const dir = this.silky.store.managerDir;
		const loader = new DefaultResourceLoader({ cwd, agentDir: getAgentDir(), appendSystemPrompt: [SYSTEM] });
		await loader.reload();
		const { session } = await createAgentSession({
			cwd,
			resourceLoader: loader,
			customTools: tools(this.controller),
			sessionManager: fresh ? SessionManager.create(cwd, dir) : SessionManager.continueRecent(cwd, dir),
		});
		session.subscribe((e) => {
			if (e.type === "tool_execution_start") this.onTool?.(e.toolName, e.args);
		});
		return session;
	}

	prompt(input: string): Promise<ManagerReply> {
		this.pending++;
		const job = this.chain.then(async () => {
			try {
				this.session ??= await this.open(false);
				const before = this.session.messages.length;
				await this.session.prompt(input);
				const last = this.session.messages.slice(before).filter((m: any) => m.role === "assistant").at(-1) as any;
				const error = last?.stopReason === "error" ? (last.errorMessage ?? "error") : last?.stopReason === "aborted" ? "stopped" : undefined;
				return { text: messageText(last), error };
			} finally {
				this.pending--;
			}
		});
		this.chain = job.catch(() => {});
		return job;
	}

	async abort(): Promise<boolean> {
		if (!this.session?.isStreaming) return false;
		await this.session.abort();
		return true;
	}

	/** /clear in manager mode. The old session file stays under .silky/manager. */
	async newSession(): Promise<void> {
		await this.abort();
		await this.chain;
		this.session?.dispose();
		this.session = await this.open(true);
	}

	dispose(): void {
		this.session?.dispose();
	}
}
