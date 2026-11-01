import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { loadConfig, ROOT } from "../src/config.ts";
import { Silky } from "../src/core.ts";
import { TelegramGateway } from "../src/telegram.ts";
import { SOCKET } from "../src/tmux.ts";

const OWNER = 42;
const p = `tg${process.pid}`;
const dir = mkdtempSync(join(tmpdir(), "silky-tg-"));

after(() => {
	try {
		execFileSync("tmux", ["-L", SOCKET, "kill-session", "-t", `=${p}`]);
	} catch {}
	rmSync(dir, { recursive: true, force: true });
});

function setup() {
	const silky = new Silky(loadConfig({ projectsDir: dir, piBin: join(ROOT, "test/fixtures/fake-pi"), pollMs: 50 }));
	const transcribed: any[] = [];
	const fakeOpenRouter = async (url: any, init: any) => {
		transcribed.push({ url, body: JSON.parse(init.body), auth: init.headers.Authorization });
		return { ok: true, status: 200, json: async () => ({ text: `heard ${transcribed.length}` }) } as any;
	};
	const gw = new TelegramGateway(silky, "123:fake", undefined, { key: "or-key", model: "test/model", fetch: fakeOpenRouter });
	gw.bot.botInfo = { id: 1, is_bot: true, first_name: "silky", username: "silky_bot" } as any;
	const calls: { method: string; payload: any }[] = [];
	let nextId = 100;
	gw.bot.api.config.use(async (_prev, method, payload: any) => {
		calls.push({ method, payload });
		// getFile answers like a local Bot API server: an absolute path on disk.
		const result =
			method === "sendMessage" || method === "sendDocument"
				? { message_id: nextId++, chat: { id: payload.chat_id }, date: 0 }
				: method === "getFile"
					? { file_id: payload.file_id, file_unique_id: "u", file_path: join(dir, `${payload.file_id}.upload`) }
					: true;
		return { ok: true, result } as any;
	});
	let update = 1;
	const message = (fields: object, from = OWNER) =>
		gw.bot.handleUpdate({
			update_id: update++,
			message: { message_id: update, date: 0, chat: { id: from, type: "private" }, from: { id: from, is_bot: false, first_name: "u" }, ...fields },
		} as any);
	const send = (text: string, from = OWNER) =>
		message({ text, entities: text.startsWith("/") ? [{ type: "bot_command", offset: 0, length: text.split(" ")[0].length }] : undefined }, from);
	const click = (data: string) =>
		gw.bot.handleUpdate({
			update_id: update++,
			callback_query: { id: "cb", chat_instance: "c", from: { id: OWNER, is_bot: false, first_name: "u" }, data, message: { message_id: 1, date: 0, chat: { id: OWNER, type: "private" } } },
		} as any);
	const texts = () => calls.filter((c) => c.method === "sendMessage").map((c) => c.payload.text as string);
	const until = async (fn: () => boolean, what: string) => {
		for (let i = 0; i < 200 && !fn(); i++) await new Promise((r) => setTimeout(r, 25));
		assert.ok(fn(), `timed out waiting for ${what}\n${texts().join("\n---\n")}`);
	};
	const lastKeyboard = () => calls.findLast((c) => c.payload.reply_markup?.inline_keyboard)!.payload.reply_markup.inline_keyboard;
	return { silky, gw, calls, message, send, click, texts, until, lastKeyboard, transcribed };
}

test("telegram gateway end to end", async () => {
	const { silky, gw, calls, message, send, click, texts, until, lastKeyboard, transcribed } = setup();
	await silky.start();

	await send("/status", 7);
	assert.equal(calls.length, 0, "ignores everyone before /start");
	await send("/start");
	assert.equal((await silky.store.gateway("telegram")).ownerId, OWNER);
	await send("/status", 7);
	assert.equal(texts().length, 1, "ignores strangers after binding");

	await send(`/create_project ${p}`);
	await until(() => texts().some((t) => t.includes("How should")), "template buttons");
	const templates = lastKeyboard().filter((r: any[]) => r.length);
	assert.deepEqual(templates.map((r: any) => r[0].text), ["Empty folder", "Git", "Git + data dir"]);
	await click(templates[2][0].callback_data);
	await until(() => texts().some((t) => t.includes(`Created project ${p}`)), "create");
	assert.ok(existsSync(join(dir, p, ".git")) && existsSync(join(dir, p, "raw/assets/.gitkeep")) && existsSync(join(dir, p, "data")));
	assert.ok(texts().at(-1)!.endsWith(`<i>· ${p} / ${p}-agent-1 ·</i>`), "footer");

	await send("hello **world**");
	await until(() => texts().some((t) => t.includes("<b>world</b>")), "answer");
	assert.ok(calls.some((c) => c.method === "deleteMessage"), "status line removed");

	// A photo is saved under raw/assets/ and its caption goes to the agent.
	writeFileSync(join(dir, "ph.upload"), "jpeg bytes");
	await message({ photo: [{ file_id: "ph", file_unique_id: "ph", width: 1, height: 1, file_size: 10 }], caption: "what is this" });
	await until(() => texts().some((t) => t.includes("Attached file: raw/assets/photo-")), "caption answer");
	const saved = texts().find((t) => t.includes("📎 Saved to"))!;
	const rel = /<code>(.+?)<\/code>/.exec(saved)![1];
	assert.equal(readFileSync(join(dir, p, rel), "utf8"), "jpeg bytes");
	// Over 20 MB can't be downloaded through the public Bot API.
	await message({ document: { file_id: "big", file_unique_id: "big", file_name: "movie.mp4", file_size: 30 * 1024 * 1024 } });
	await until(() => texts().some((t) => t.includes("movie.mp4 is over 20 MB")), "big file refused");

	// Forwarded messages are saved as usual, then the bot asks what to do with them.
	const origin = { forward_origin: { type: "user", date: 0, sender_user: { id: 9, is_bot: false, first_name: "Sam" } } };
	writeFileSync(join(dir, "fw.upload"), "pdf bytes");
	await message({ ...origin, text: "meeting notes here" });
	await message({ ...origin, text: "/not_a_command" });
	await message({ ...origin, document: { file_id: "fw", file_unique_id: "fw", file_name: "report.pdf", file_size: 9 } });
	await until(() => texts().some((t) => t.startsWith("I received 1 file and 2 messages. What should I do with them?")), "forward question");
	assert.ok(texts().at(-1)!.includes("raw/assets/report.pdf (from Sam)"), "lists the saved path");
	assert.equal(readFileSync(join(dir, p, "raw/assets/report.pdf"), "utf8"), "pdf bytes");
	await send("summarize them");
	await until(() => texts().some((t) => t.includes("summarize them") && t.includes("meeting notes here") && t.includes("Forwarded files (saved in the project)")), "forward context");
	assert.ok(texts().some((t) => t.includes("From Sam:") && t.includes("/not_a_command")), "forwarded command kept as text");
	await send("plain follow-up");
	await until(() => texts().some((t) => t.includes("plain follow-up")), "follow-up");
	assert.ok(!texts().at(-1)!.includes("meeting notes here"), "context is used once");

	// Voice notes are transcribed through OpenRouter and sent on as text.
	writeFileSync(join(dir, "vc.upload"), "ogg bytes");
	await message({ voice: { file_id: "vc", file_unique_id: "vc", duration: 2, mime_type: "audio/ogg", file_size: 9 } });
	await until(() => texts().some((t) => t.startsWith("🎙 <i>heard 1</i>")), "transcript shown");
	await until(() => texts().some((t) => t.includes("echo(") && t.includes("heard 1")), "transcript sent to agent");
	assert.equal(transcribed[0].url, "https://openrouter.ai/api/v1/audio/transcriptions");
	assert.equal(transcribed[0].auth, "Bearer or-key");
	assert.deepEqual(transcribed[0].body, { model: "test/model", input_audio: { data: Buffer.from("ogg bytes").toString("base64"), format: "ogg" } });
	// A forwarded voice note counts as a message, in order with the forwarded texts.
	await message({ ...origin, text: "before" });
	await message({ ...origin, voice: { file_id: "vc", file_unique_id: "vc", duration: 2, file_size: 9 } });
	await until(() => texts().some((t) => t.startsWith("I received 2 messages. What should I do with them?")), "forwarded voice question");
	await send("reply please");
	await until(() => texts().some((t) => t.includes("reply please") && /before[\s\S]*voice note, transcribed[\s\S]*heard 2/.test(t)), "forwarded voice context");

	// A second agent becomes active; the first one's run finishes in the background.
	await silky.send(p, `${p}-agent-1`, "SLEEP1 background");
	await send("/create_agent");
	await until(() => texts().some((t) => t.includes(`Created ${p}-agent-2`)), "create agent");
	await until(() => texts().some((t) => t.includes(`<b>${p}-agent-1</b> finished`)), "ping");
	assert.ok(!texts().some((t) => t.includes("background")), "answer held");
	assert.equal((await silky.agent(p, `${p}-agent-1`))!.unread, 1);

	await send(`/agent ${p}-agent-1`);
	await until(() => texts().some((t) => t.includes("background")), "held answer delivered");
	assert.equal((await silky.agent(p, `${p}-agent-1`))!.unread, 0);

	await send("/delete");
	await until(() => texts().some((t) => t.startsWith("Archive <b>")), "confirm");
	await click(lastKeyboard()[0][0].callback_data);
	await until(() => texts().some((t) => t.includes(`Archived ${p}-agent-1. Now talking to ${p} / ${p}-agent-2`)), "archive");

	await send("/manage");
	await until(() => texts().at(-1)!.endsWith("<i>· manager ·</i>"), "manager footer");
	silky.stopAll();
	gw.manager.dispose();
});
