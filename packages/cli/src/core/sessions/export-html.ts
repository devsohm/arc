import type { EntryRecord } from "@arc/durable";
import { exportTranscript } from "./transcript.ts";
import { colorToHex } from "@arc/tui";
import type { Theme, ThemeToken } from "../ui/theme.ts";

const escape = (text: string) =>
	text.replace(
		/[&<>"']/g,
		(char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char] ?? char,
	);

export function exportHtml(entries: readonly EntryRecord[], theme?: Theme): string {
	const dark = theme?.appearance === "dark";
	const color = (token: ThemeToken, fallback: string): string => {
		const value = theme?.colors[token];
		return value ? colorToHex(value) : fallback;
	};
	const page = theme?.exportColors.pageBg ?? (dark ? "#18181e" : "#fafafa");
	const card = theme?.exportColors.cardBg ?? color("userMessageBg", dark ? "#24242a" : "#ffffff");
	const info = theme?.exportColors.infoBg ?? color("customMessageBg", dark ? "#303038" : "#eeeeee");
	const foreground = color("text", dark ? "#eeeeee" : "#222222");
	const border = color("border", dark ? "#555555" : "#cccccc");
	const messages = entries.flatMap((entry) => entry.model ?? []);
	const cards = messages
		.map((message) => {
			const blocks =
				typeof message.content === "string"
					? `<pre>${escape(message.content)}</pre>`
					: message.content
							.map((block) => {
								if (block.type === "text") return `<pre>${escape(block.text)}</pre>`;
								if (block.type === "thinking")
									return `<details><summary>Thinking</summary><pre>${escape(block.thinking)}</pre></details>`;
								if (block.type === "toolCall")
									return `<details open><summary>Tool: ${escape(block.name)}</summary><pre>${escape(JSON.stringify(block.arguments, null, 2))}</pre></details>`;
								if (
									["image/png", "image/jpeg", "image/gif", "image/webp"].includes(block.mimeType) &&
									/^[A-Za-z0-9+/]*={0,2}$/.test(block.data)
								)
									return `<img alt="Attached image" src="data:${block.mimeType};base64,${block.data}">`;
								return `<p>Image: ${escape(block.mimeType)}</p>`;
							})
							.join("\n");
			const title =
				message.role === "toolResult"
					? `Tool result: ${message.toolName}${message.isError ? " (failed)" : ""}`
					: message.role;
			return `<article data-role="${escape(message.role)}"><h2>${escape(title)}</h2>${blocks}</article>`;
		})
		.join("\n");
	const data = exportTranscript(entries).replace(/</g, "\\u003c");
	return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:">
<title>Arc conversation</title><style>:root{color-scheme:${dark ? "dark" : "light"};--page-bg:${page};--card-bg:${card};--info-bg:${info};--text:${foreground};--border:${border}}body{font:16px system-ui;max-width:900px;margin:2rem auto;padding:0 1rem;color:var(--text);background:var(--page-bg)}article{border:1px solid var(--border);background:var(--card-bg);border-radius:6px;padding:1rem;margin:1rem 0}article[data-role="system"]{background:var(--info-bg)}h2{font-size:1rem}pre{white-space:pre-wrap;overflow-wrap:anywhere;font:inherit}summary{cursor:pointer}img{max-width:100%;height:auto}</style></head>
<body><h1>Arc conversation</h1>${cards}<script id="arc-transcript" type="application/json">${data}</script></body></html>\n`;
}
