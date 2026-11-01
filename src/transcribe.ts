import type { Fetch } from "./net.ts";

const ENDPOINT = "https://openrouter.ai/api/v1/audio/transcriptions";
/** The cheapest OpenRouter speech-to-text model that takes Telegram's OGG/Opus voice notes as is. */
export const DEFAULT_TRANSCRIBE_MODEL = "microsoft/mai-transcribe-2";

export interface Transcriber {
	key: string;
	model: string;
	fetch: Fetch;
}

/** Sends audio to OpenRouter's speech-to-text API and returns the transcript. */
export async function transcribe(t: Transcriber, audio: Buffer, format: string): Promise<string> {
	const res = await t.fetch(ENDPOINT, {
		method: "POST",
		headers: { Authorization: `Bearer ${t.key}`, "Content-Type": "application/json" },
		body: JSON.stringify({ model: t.model, input_audio: { data: audio.toString("base64"), format } }),
	});
	const body = (await res.json().catch(() => ({}))) as { text?: string; error?: { message?: string } };
	if (!res.ok) throw new Error(`transcription failed: ${body.error?.message ?? `HTTP ${res.status}`}`);
	return body.text?.trim() ?? "";
}
