import { randomBytes } from "node:crypto";
import { createWriteStream, existsSync } from "node:fs";
import { copyFile, rm } from "node:fs/promises";
import { isAbsolute, relative } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { Bot, GrammyError, InlineKeyboard, InputFile, type Context } from "grammy";
import { BIG_FILE, type Silky, type SilkyEvent, type Template } from "./core.ts";
import { clip, escapeHtml, LONG_OUTPUT, markdownToHtml, oneLine, toolSummary } from "./format.ts";
import { type Controller, Manager } from "./manager.ts";
import { type Active, timestamp } from "./store.ts";

const GATEWAY = "telegram";
const STATUS_EDIT_MS = 1500;
const MANAGER_KEY = "manager";
const DEFAULT_API_ROOT = "https://api.telegram.org";

const TEMPLATE_LABELS: [Template, string][] = [
	["empty", "Empty folder"],
	["git", "Git"],
	["git-data", "Git + data dir"],
];

interface Incoming {
	fileId: string;
	name: string;
	size: number;
	caption?: string;
}

const COMMANDS = [
	["create_project", "Create a project and its first agent"],
	["proj", "Switch project"],
	["create_agent", "Add an agent to the current project"],
	["agent", "Switch agent in the current project"],
	["delete", "Archive the current agent"],
	["clear", "Start a fresh session"],
	["stop", "Stop the current run"],
	["status", "Projects, agents and unread runs"],
	["manage", "Switch to manager mode"],
] as const;

interface StatusLine {
	messageId?: number;
	tools: number;
	last: string;
	timer?: NodeJS.Timeout;
	edited: number;
}

interface Answer {
	text: string;
	ok: boolean;
	error?: string;
	earlier?: number;
}

export class TelegramGateway implements Controller {
	readonly bot: Bot;
	readonly manager: Manager;
	private silky: Silky;
	private statusLines = new Map<string, StatusLine>();
	/** Inline-button payloads, so callback data stays under Telegram's 64 bytes. */
	private callbacks = new Map<string, () => Promise<void>>();
	private token: string;
	/** A local Bot API server (TELEGRAM_API_ROOT) lifts Telegram's 20 MB download limit. */
	private apiRoot: string;

	constructor(silky: Silky, token: string, apiRoot = DEFAULT_API_ROOT) {
		this.silky = silky;
		this.token = token;
		this.apiRoot = apiRoot.replace(/\/+$/, "");
		this.bot = new Bot(token, { client: { apiRoot: this.apiRoot } });
		this.manager = new Manager(silky, this);
		this.manager.onTool = (name, args) => this.statusTool(MANAGER_KEY, name, args);
		silky.on((e) => void this.onEvent(e).catch((err) => console.error("event handling failed", err)));
		this.setupBot();
	}

	async start(): Promise<void> {
		await this.bot.api.setMyCommands(COMMANDS.map(([command, description]) => ({ command, description })));
		const g = await this.silky.store.gateway(GATEWAY);
		if (g.chatId) await this.sendHtml("silky is up.").catch(() => {});
		this.bot.catch((err) => console.error("telegram error", err.error));
		void this.bot.start({ onStart: (me) => console.log(`telegram: @${me.username}`) });
	}

	async stop(): Promise<void> {
		await this.bot.stop();
		this.manager.dispose();
	}

	// ── Bot wiring ───────────────────────────────────────────────────────────

	private setupBot(): void {
		const bot = this.bot;
		bot.use(async (ctx, next) => {
			const g = await this.silky.store.gateway(GATEWAY);
			if (g.ownerId === undefined) return ctx.message?.text?.startsWith("/start") ? next() : undefined;
			if (ctx.from?.id === g.ownerId) return next();
		});

		bot.command("start", (ctx) => this.cmdStart(ctx));
		const guarded = (name: string, fn: (ctx: Context) => Promise<unknown>) =>
			bot.command(name, (ctx) => {
				// Handlers run detached so a long command never blocks /stop.
				void (async () => {
					try {
						await this.silky.reconcile();
						await fn(ctx);
					} catch (err) {
						await this.sendHtml(`✗ ${escapeHtml(err instanceof Error ? err.message : String(err))}`);
					}
				})();
			});
		guarded("create_project", (ctx) => this.cmdCreateProject(String(ctx.match ?? "").trim()));
		guarded("proj", (ctx) => this.cmdProj(String(ctx.match ?? "").trim()));
		guarded("create_agent", () => this.cmdCreateAgent());
		guarded("agent", (ctx) => this.cmdAgent(String(ctx.match ?? "").trim()));
		guarded("delete", () => this.cmdDelete());
		guarded("clear", () => this.cmdClear());
		guarded("stop", () => this.cmdStop());
		guarded("status", () => this.cmdStatus());
		guarded("manage", async () => this.sendHtml(escapeHtml(await this.setActive())));

		bot.on("callback_query:data", async (ctx) => {
			const fn = this.callbacks.get(ctx.callbackQuery.data);
			await ctx.answerCallbackQuery(fn ? undefined : { text: "This button has expired." });
			if (!fn) return;
			this.callbacks.delete(ctx.callbackQuery.data);
			await ctx.editMessageReplyMarkup().catch(() => {});
			try {
				await this.silky.reconcile();
				await fn();
			} catch (err) {
				await this.sendHtml(`✗ ${escapeHtml(err instanceof Error ? err.message : String(err))}`);
			}
		});

		bot.on(["message:document", "message:photo", "message:video", "message:audio", "message:voice"], (ctx) => {
			const incoming = describeFile(ctx);
			if (!incoming) return;
			void this.onFile(incoming).catch((err) => this.sendHtml(`✗ ${escapeHtml(String(err?.message ?? err))}`));
		});

		bot.on("message:text", (ctx) => {
			const text = ctx.message.text;
			if (text.startsWith("/")) return this.sendHtml(`Unknown command. Try ${COMMANDS.map(([c]) => `/${c}`).join(" ")}`);
			void this.onText(text).catch((err) => this.sendHtml(`✗ ${escapeHtml(String(err?.message ?? err))}`));
		});
	}

	private button(label: string, fn: () => Promise<void>): [string, string] {
		const id = randomBytes(6).toString("base64url");
		this.callbacks.set(id, fn);
		return [label, id];
	}

	private keyboard(buttons: [string, string][], perRow = 2): InlineKeyboard {
		const kb = new InlineKeyboard();
		buttons.forEach(([label, data], i) => {
			kb.text(label, data);
			if ((i + 1) % perRow === 0) kb.row();
		});
		return kb;
	}

	// ── Sending ──────────────────────────────────────────────────────────────

	private async active(): Promise<Active> {
		return (await this.silky.store.gateway(GATEWAY)).active;
	}

	private async footer(): Promise<string> {
		const a = await this.active();
		const label = a.mode === "manager" ? "manager" : `${a.project} / ${a.agent}`;
		return `\n\n<i>· ${escapeHtml(label)} ·</i>`;
	}

	private async chatId(): Promise<number | undefined> {
		return (await this.silky.store.gateway(GATEWAY)).chatId;
	}

	/** Sends HTML we built ourselves, with the footer. */
	private async sendHtml(html: string, keyboard?: InlineKeyboard, footer = true): Promise<number | undefined> {
		const chat = await this.chatId();
		if (!chat) return;
		const body = html + (footer ? await this.footer() : "");
		const msg = await this.bot.api.sendMessage(chat, body, { parse_mode: "HTML", reply_markup: keyboard, link_preview_options: { is_disabled: true } });
		return msg.message_id;
	}

	/** Sends an agent's Markdown answer. Long answers become a preview plus a `.md` file. */
	private async sendAnswer(name: string, a: Answer): Promise<void> {
		const chat = await this.chatId();
		if (!chat) return;
		const head = [
			a.error ? `✗ <b>${escapeHtml(name)}</b>: ${escapeHtml(oneLine(a.error, 300))}` : "",
			a.earlier ? `<i>(+${a.earlier} earlier run${a.earlier > 1 ? "s" : ""})</i>` : "",
		]
			.filter(Boolean)
			.join("\n");
		const text = a.text || (a.ok ? "(no text in the answer)" : "");
		const prefix = head ? `${head}\n\n` : "";
		if (text.length > LONG_OUTPUT) {
			await this.sendHtml(`${prefix}${escapeHtml(clip(text, 800))}\n\n<i>Full answer attached (${text.length} chars).</i>`);
			await this.bot.api.sendDocument(chat, new InputFile(Buffer.from(text), `${name}-${timestamp()}.md`));
			return;
		}
		try {
			await this.sendHtml(prefix + markdownToHtml(text));
		} catch (err) {
			if (!(err instanceof GrammyError && err.error_code === 400)) throw err;
			await this.sendHtml(prefix + escapeHtml(text));
		}
	}

	// ── Status line while a run is in progress ───────────────────────────────

	private async statusStart(key: string): Promise<void> {
		const line: StatusLine = { tools: 0, last: "", edited: 0 };
		this.statusLines.set(key, line);
		line.messageId = await this.sendHtml("⏳ working…", undefined, false).catch(() => undefined);
	}

	private statusTool(key: string, toolName: string, args: any): void {
		const line = this.statusLines.get(key);
		if (!line) return;
		line.tools++;
		line.last = toolSummary(toolName, args);
		if (line.timer) return;
		const wait = Math.max(0, line.edited + STATUS_EDIT_MS - Date.now());
		line.timer = setTimeout(() => {
			line.timer = undefined;
			line.edited = Date.now();
			void this.statusEdit(line);
		}, wait);
	}

	private async statusEdit(line: StatusLine): Promise<void> {
		const chat = await this.chatId();
		if (!chat || !line.messageId) return;
		const html = `⏳ working… · ${line.tools} tool${line.tools > 1 ? "s" : ""}\n⚙ <code>${escapeHtml(line.last)}</code>`;
		await this.bot.api.editMessageText(chat, line.messageId, html, { parse_mode: "HTML" }).catch(() => {});
	}

	private async statusEnd(key: string): Promise<void> {
		const line = this.statusLines.get(key);
		if (!line) return;
		this.statusLines.delete(key);
		clearTimeout(line.timer);
		const chat = await this.chatId();
		if (chat && line.messageId) await this.bot.api.deleteMessage(chat, line.messageId).catch(() => {});
	}

	// ── Core events ──────────────────────────────────────────────────────────

	private async isActive(project: string, agent: string): Promise<boolean> {
		const a = await this.active();
		return a.mode === "agent" && a.project === project && a.agent === agent;
	}

	private async onEvent(e: SilkyEvent): Promise<void> {
		if (e.type === "project_archived") {
			await this.sendHtml(`🗄 The folder of <b>${escapeHtml(e.project)}</b> is gone, so its agents were archived.`);
			return;
		}
		const key = `${e.project}/${e.agent}`;
		const active = await this.isActive(e.project, e.agent);
		switch (e.type) {
			case "started":
				if (active) await this.statusStart(key);
				break;
			case "tool":
				if (active) this.statusTool(key, e.toolName, e.args);
				else console.log(`[${e.agent}] ⚙ ${toolSummary(e.toolName, e.args)}`);
				break;
			case "finished":
				await this.statusEnd(key);
				if (active) {
					await this.sendAnswer(e.agent, e);
				} else {
					await this.silky.hold(e.project, e.agent, e.error ? `✗ ${e.error}\n\n${e.text}`.trim() : e.text, e.ok);
					await this.sendHtml(`${e.ok ? "✓" : "✗"} <b>${escapeHtml(e.agent)}</b> ${e.ok ? "finished" : "failed"}`);
				}
				break;
			case "interrupted":
				await this.statusEnd(key);
				await this.sendHtml(`⚠ <b>${escapeHtml(e.agent)}</b>: the run was interrupted (its process is gone).`);
				break;
		}
	}

	// ── Messages ─────────────────────────────────────────────────────────────

	private async onText(text: string): Promise<void> {
		await this.silky.reconcile();
		const a = await this.active();
		if (a.mode === "agent") {
			const res = await this.silky.send(a.project, a.agent, text);
			if ("queued" in res) await this.sendHtml(`queued (${res.queued}) — runs when the current run ends. /stop cuts it short.`);
			return;
		}
		if (this.manager.busy) await this.sendHtml("queued — the manager is busy.");
		const chat = await this.chatId();
		if (chat) await this.bot.api.sendChatAction(chat, "typing").catch(() => {});
		await this.statusStart(MANAGER_KEY);
		try {
			const reply = await this.manager.prompt(text);
			await this.statusEnd(MANAGER_KEY);
			await this.sendAnswer("manager", { text: reply.text, ok: !reply.error, error: reply.error });
		} catch (err) {
			await this.statusEnd(MANAGER_KEY);
			throw err;
		}
	}

	/** Saves a received file into the active project; a caption is sent on to the agent along with the path. */
	private async onFile(f: Incoming): Promise<void> {
		await this.silky.reconcile();
		const a = await this.active();
		if (a.mode !== "agent") return void (await this.sendHtml("Files go to a project: pick one first with /proj."));
		const local = this.apiRoot !== DEFAULT_API_ROOT;
		if (f.size > BIG_FILE && !local) {
			return void (await this.sendHtml(
				`✗ ${escapeHtml(f.name)} is over 20 MB, which Telegram's Bot API can't download. Run a local Bot API server and set TELEGRAM_API_ROOT.`,
			));
		}
		const dest = await this.silky.attachmentPath(a.project, f.name, f.size);
		const file = await this.bot.api.getFile(f.fileId);
		if (!file.file_path) throw new Error("Telegram returned no file path.");
		try {
			// A local Bot API server in --local mode hands out a path on its own disk.
			if (isAbsolute(file.file_path) && existsSync(file.file_path)) await copyFile(file.file_path, dest);
			else {
				const res = await fetch(`${this.apiRoot}/file/bot${this.token}/${file.file_path}`);
				if (!res.ok || !res.body) throw new Error(`download failed: HTTP ${res.status}`);
				await pipeline(Readable.fromWeb(res.body as any), createWriteStream(dest));
			}
		} catch (err) {
			await rm(dest, { force: true });
			throw err;
		}
		const rel = relative(this.silky.folder(a.project), dest);
		await this.sendHtml(`📎 Saved to <code>${escapeHtml(rel)}</code>`);
		if (f.caption) await this.onText(`${f.caption}\n\n(Attached file: ${rel})`);
	}

	// ── Commands ─────────────────────────────────────────────────────────────

	private async cmdStart(ctx: Context): Promise<void> {
		const g = await this.silky.store.gateway(GATEWAY);
		const uid = ctx.from?.id;
		if (!uid || !ctx.chat) return;
		const pinned = process.env.SILKY_OWNER_ID;
		if (g.ownerId === undefined && pinned && Number(pinned) !== uid) return;
		if (g.ownerId === undefined) {
			await this.silky.store.updateGateway(GATEWAY, (s) => {
				s.ownerId = uid;
				s.chatId = ctx.chat!.id;
			});
		}
		await this.sendHtml(
			"<b>silky</b> is bound to you.\n\nPlain messages go to the active agent (or the manager). Commands:\n" +
				COMMANDS.map(([c, d]) => `/${c} — ${escapeHtml(d)}`).join("\n"),
		);
	}

	private async cmdCreateProject(name: string): Promise<void> {
		if (!name) return void (await this.sendHtml("Usage: /create_project &lt;name&gt;"));
		// An existing folder is adopted as is, so there is nothing to choose.
		if (this.silky.projectExists(name)) return void (await this.sendHtml(escapeHtml(await this.createProject(name))));
		const buttons = TEMPLATE_LABELS.map(([t, label]) => this.button(label, async () => void (await this.sendHtml(escapeHtml(await this.createProject(name, t))))));
		await this.sendHtml(`How should <b>${escapeHtml(name)}</b> start?`, this.keyboard(buttons, 1));
	}

	private async cmdProj(name: string): Promise<void> {
		if (name) return void (await this.sendHtml(escapeHtml(await this.setActive(name))));
		const projects = await this.silky.listProjects();
		if (projects.length === 0) return void (await this.sendHtml("No projects yet. Use /create_project &lt;name&gt;."));
		const buttons = projects.map((p) => this.button(p, async () => void (await this.sendHtml(escapeHtml(await this.setActive(p))))));
		await this.sendHtml("Pick a project:", this.keyboard(buttons));
	}

	private async cmdCreateAgent(): Promise<void> {
		const a = await this.active();
		if (a.mode !== "agent") return void (await this.sendHtml("Pick a project first with /proj."));
		await this.sendHtml(escapeHtml(await this.createAgent(a.project)));
	}

	private async cmdAgent(name: string): Promise<void> {
		const a = await this.active();
		if (a.mode !== "agent") return void (await this.sendHtml("Pick a project first with /proj."));
		if (name) return void (await this.sendHtml(escapeHtml(await this.setActive(a.project, name))));
		const agents = await this.silky.agents(a.project);
		const buttons: [string, string][] = [];
		for (const name of agents) {
			const m = await this.silky.agent(a.project, name);
			const badge = (m?.status === "running" ? " ⏳" : "") + (m?.unread ? ` (${m.unread})` : "") + (name === a.agent ? " ✓" : "");
			buttons.push(this.button(name + badge, async () => void (await this.sendHtml(escapeHtml(await this.setActive(a.project, name))))));
		}
		await this.sendHtml("Pick an agent:", this.keyboard(buttons, 1));
	}

	private async cmdDelete(): Promise<void> {
		const a = await this.active();
		if (a.mode !== "agent") return void (await this.sendHtml("Nothing to delete in manager mode."));
		const yes = this.button("Archive it", async () => void (await this.sendHtml(escapeHtml(await this.archiveAgent(a.project, a.agent)))));
		const no = this.button("Cancel", async () => void (await this.sendHtml("Kept.")));
		await this.sendHtml(`Archive <b>${escapeHtml(a.agent)}</b>? Its window is killed; its metadata moves to .silky/archive.`, this.keyboard([yes, no]));
	}

	private async cmdClear(): Promise<void> {
		const a = await this.active();
		if (a.mode === "manager") {
			await this.manager.newSession();
			return void (await this.sendHtml("Started a new manager session."));
		}
		await this.silky.clear(a.project, a.agent);
		await this.sendHtml("The next message starts a fresh session.");
	}

	private async cmdStop(): Promise<void> {
		const a = await this.active();
		const stopped = a.mode === "manager" ? await this.manager.abort() : await this.silky.stop(a.project, a.agent);
		await this.sendHtml(stopped ? "Stopping…" : "Nothing is running.");
	}

	private async cmdStatus(): Promise<void> {
		await this.sendHtml(`<pre>${escapeHtml(await this.status())}</pre>`);
	}

	// ── Controller: shared by commands and manager tools ─────────────────────

	async status(): Promise<string> {
		const active = await this.active();
		const lines: string[] = [];
		for (const p of await this.silky.status()) {
			lines.push(p.name + (p.agents.length ? "" : "  (no agents)"));
			for (const a of p.agents) {
				const mark = active.mode === "agent" && active.project === p.name && active.agent === a.name ? "▸" : " ";
				const extra = [a.unread ? `${a.unread} unread` : "", a.queued ? `${a.queued} queued` : ""].filter(Boolean).join(", ");
				lines.push(` ${mark} ${a.name}  ${a.status}${extra ? `  (${extra})` : ""}`);
			}
		}
		return lines.join("\n") || "No projects yet.";
	}

	async createProject(name: string, template?: Template): Promise<string> {
		const { agent, existed } = await this.silky.createProject(name, template);
		const done = await this.setActive(name, agent);
		return `${existed ? `Project ${name} already existed.` : `Created project ${name}.`} ${done}`;
	}

	async createAgent(project: string): Promise<string> {
		const agent = await this.silky.createAgent(project);
		return `Created ${agent}. ${await this.setActive(project, agent)}`;
	}

	async archiveAgent(project: string, agent: string): Promise<string> {
		const left = await this.silky.archiveAgent(project, agent);
		const active = await this.active();
		const wasActive = active.mode === "agent" && active.project === project && active.agent === agent;
		let msg = `Archived ${agent}.`;
		if (wasActive) msg += " " + (left.length ? await this.setActive(project, left[0]) : await this.setActive());
		return msg;
	}

	async setActive(project?: string, agent?: string): Promise<string> {
		if (!project) {
			await this.silky.store.updateGateway(GATEWAY, (g) => void (g.active = { mode: "manager" }));
			return "Manager mode.";
		}
		agent ??= await this.silky.ensureAgent(project);
		if (!(await this.silky.agent(project, agent))) throw new Error(`No agent named ${agent} in ${project}.`);
		await this.silky.store.updateGateway(GATEWAY, (g) => void (g.active = { mode: "agent", project, agent }));
		const held = await this.silky.takeHeld(project, agent);
		if (held) setTimeout(() => void this.sendAnswer(agent, { ...held, error: held.ok ? undefined : "failed" }).catch(() => {}), 300);
		const m = await this.silky.agent(project, agent);
		return `Now talking to ${project} / ${agent}${m?.status === "running" ? " (running)" : ""}.`;
	}

	async sendToAgent(project: string, agent: string, text: string): Promise<string> {
		const res = await this.silky.send(project, agent, text);
		return "queued" in res ? `Queued (${res.queued}) behind the current run of ${agent}.` : `Started a run on ${agent}.`;
	}
}

function describeFile(ctx: Context): Incoming | undefined {
	const m = ctx.message;
	if (!m) return;
	const caption = m.caption?.trim() || undefined;
	const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..*/, "");
	if (m.photo?.length) {
		const p = m.photo.at(-1)!;
		return { fileId: p.file_id, name: `photo-${stamp}.jpg`, size: p.file_size ?? 0, caption };
	}
	const f = m.document ?? m.video ?? m.audio ?? m.voice;
	if (!f) return;
	const ext = f.mime_type?.split("/")[1]?.replace(/[^a-z0-9]/g, "") || "bin";
	const name = ("file_name" in f && f.file_name) || `${m.voice ? "voice" : "file"}-${stamp}.${m.voice ? "ogg" : ext}`;
	return { fileId: f.file_id, name, size: f.file_size ?? 0, caption };
}
