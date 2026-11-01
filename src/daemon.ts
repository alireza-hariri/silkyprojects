import type { Silky } from "./core.ts";
import { TelegramGateway } from "./telegram.ts";
import { DEFAULT_TRANSCRIBE_MODEL } from "./transcribe.ts";

export async function runDaemon(silky: Silky): Promise<void> {
	const token = process.env.TELEGRAM_BOT_TOKEN;
	if (!token) throw new Error("TELEGRAM_BOT_TOKEN is not set");

	// The gateway subscribes before reconcile, so runs that finished while we were down get delivered.
	const key = process.env.OPENROUTER_TRANSCRIPT_KEY;
	const voice = key ? { key, model: process.env.OPENROUTER_TRANSCRIPT_MODEL || DEFAULT_TRANSCRIBE_MODEL } : undefined;
	const gateway = new TelegramGateway(silky, token, process.env.TELEGRAM_API_ROOT || undefined, voice);
	await silky.start();
	await gateway.start();
	console.log(`silky: managing ${silky.config.projectsDir}`);

	const shutdown = async () => {
		silky.stopAll();
		await gateway.stop().catch(() => {});
		process.exit(0);
	};
	process.once("SIGINT", shutdown);
	process.once("SIGTERM", shutdown);
}
