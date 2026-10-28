/** Answers past this length go out as a preview plus a `.md` file. */
export const LONG_OUTPUT = 3500;

export function escapeHtml(s: string): string {
	return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Converts the Markdown agents usually write into Telegram's HTML subset. */
export function markdownToHtml(md: string): string {
	const out: string[] = [];
	const fence = /```([\w+-]*)[^\n]*\n([\s\S]*?)```/g;
	let last = 0;
	for (let m: RegExpExecArray | null; (m = fence.exec(md)); ) {
		out.push(inline(md.slice(last, m.index)));
		const lang = m[1] ? ` class="language-${m[1]}"` : "";
		out.push(`<pre><code${lang}>${escapeHtml(m[2].replace(/\n$/, ""))}</code></pre>`);
		last = m.index + m[0].length;
	}
	out.push(inline(md.slice(last)));
	return out.join("").trim();
}

function inline(text: string): string {
	const codes: string[] = [];
	let s = text.replace(/`([^`\n]+)`/g, (_, c) => `\u0000${codes.push(c) - 1}\u0000`);
	s = escapeHtml(s)
		.replace(/^#{1,6}\s+(.+)$/gm, "<b>$1</b>")
		.replace(/\*\*([^*\n]+)\*\*/g, "<b>$1</b>")
		.replace(/(^|[\s(])\*([^*\s][^*\n]*?)\*(?=[\s).,!?:;]|$)/gm, "$1<i>$2</i>")
		.replace(/~~([^~\n]+)~~/g, "<s>$1</s>")
		.replace(/\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g, (_, t, u) => `<a href="${u.replace(/"/g, "&quot;")}">${t}</a>`)
		.replace(/^(\s*)[-*]\s+/gm, "$1• ");
	return s.replace(/\u0000(\d+)\u0000/g, (_, i) => `<code>${escapeHtml(codes[Number(i)])}</code>`);
}

export function clip(s: string, n: number): string {
	return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

export function oneLine(s: string, n = 80): string {
	return clip(String(s).replace(/\s+/g, " ").trim(), n);
}

export function toolSummary(name: string, args: any): string {
	const main = args?.command ?? args?.path ?? args?.file_path ?? args?.pattern ?? args?.name ?? "";
	return main ? `${name} ${oneLine(main, 60)}` : name;
}
