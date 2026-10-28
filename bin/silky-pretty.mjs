#!/usr/bin/env node
// Turns a `pi --mode json` stream on stdin into a readable log for the tmux window.
import { createInterface } from "node:readline";

const c = (code) => (s) => (process.stdout.isTTY ? `\x1b[${code}m${s}\x1b[0m` : s);
const dim = c(2), bold = c(1), cyan = c(36), green = c(32), red = c(31), yellow = c(33);
const out = (s) => process.stdout.write(s);
const clip = (s, n = 300) => (s.length > n ? s.slice(0, n) + "…" : s);
const oneLine = (s) => clip(String(s).replace(/\s+/g, " ").trim(), 160);

function toolSummary(name, args = {}) {
	const main = args.command ?? args.path ?? args.file_path ?? args.pattern ?? JSON.stringify(args);
	return `${name} ${oneLine(main)}`;
}

function resultText(result) {
	const parts = result?.content ?? [];
	return parts.filter((p) => p.type === "text").map((p) => p.text).join("\n");
}

let inText = false;
const endText = () => {
	if (inText) out("\n");
	inText = false;
};

const rl = createInterface({ input: process.stdin });
rl.on("line", (line) => {
	let ev;
	try {
		ev = JSON.parse(line);
	} catch {
		return;
	}
	switch (ev.type) {
		case "session":
			out(dim(`── ${new Date().toLocaleString()} · session ${ev.id} ──\n`));
			break;
		case "message_start":
			if (ev.message?.role === "user") {
				const text = (ev.message.content ?? []).filter((p) => p.type === "text").map((p) => p.text).join("\n");
				out(bold(cyan("› ")) + bold(clip(text, 2000)) + "\n");
			}
			break;
		case "message_update": {
			const e = ev.assistantMessageEvent;
			if (e?.type === "text_delta") {
				inText = true;
				out(e.delta);
			}
			break;
		}
		case "message_end":
			endText();
			if (ev.message?.role === "assistant" && ev.message.stopReason === "error") {
				out(red(`✗ ${ev.message.errorMessage ?? "error"}\n`));
			}
			break;
		case "tool_execution_start":
			endText();
			out(yellow(`⚙ ${toolSummary(ev.toolName, ev.args)}\n`));
			break;
		case "tool_execution_end": {
			const text = resultText(ev.result);
			if (text) out(dim(clip(text).replace(/^/gm, "  │ ")) + "\n");
			if (ev.isError) out(red("  ✗ tool error\n"));
			break;
		}
		case "agent_end":
			endText();
			out(green("✓ done\n\n"));
			break;
	}
});
