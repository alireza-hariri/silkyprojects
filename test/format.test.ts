import assert from "node:assert/strict";
import { test } from "node:test";
import { markdownToHtml, toolSummary } from "../src/format.ts";

test("markdown to Telegram HTML", () => {
	assert.equal(markdownToHtml("a < b & **bold** `x<y>`"), "a &lt; b &amp; <b>bold</b> <code>x&lt;y&gt;</code>");
	assert.equal(markdownToHtml("```ts\nconst a = 1 < 2;\n```"), '<pre><code class="language-ts">const a = 1 &lt; 2;</code></pre>');
	assert.equal(markdownToHtml("## Title\n- item"), "<b>Title</b>\n• item");
	assert.equal(markdownToHtml("snake_case_name stays"), "snake_case_name stays");
	assert.equal(markdownToHtml("see [docs](https://x.io/a)"), 'see <a href="https://x.io/a">docs</a>');
});

test("tool summary", () => {
	assert.equal(toolSummary("bash", { command: "ls   -la\n" }), "bash ls -la");
	assert.equal(toolSummary("status", {}), "status");
});
