import { Marked, stripTerminalSequences } from "@arc/tui";
import { render, type Span } from "grok-mermaid";
import hljs from "highlight.js";
import type { Theme, ThemeToken } from "../../core/ui/theme.ts";

export type MermaidMode = "off" | "final" | "streaming";
const parser = new Marked();
const diagramRoles: Record<Span["cls"], ThemeToken | undefined> = {
	border: "borderMuted",
	text: "text",
	edge: "accent",
	edgeLabel: "muted",
	title: "accent",
	none: undefined,
};
function literalLine(text: string): string {
	let delimiter = "`";
	for (const match of text.matchAll(/`+/g))
		if (match[0].length >= delimiter.length) delimiter = "`".repeat(match[0].length + 1);
	const padding = text.startsWith("`") || text.endsWith("`") ? " " : "";
	return `${delimiter}${padding}${text || "\u00a0"}${padding}${delimiter}`;
}
export function mermaidTransform(options: {
	mode?: MermaidMode;
	streaming?: boolean;
	theme?: Theme;
}): (markdown: string, width: number) => string {
	return (markdown, width) => {
		const mode = options.mode ?? "streaming";
		if (mode === "off" || (mode === "final" && options.streaming)) return markdown;
		return parser
			.lexer(markdown)
			.map((token) => {
				if (
					token.type !== "code" ||
					typeof token.lang !== "string" ||
					token.lang.trim().split(/\s/)[0]?.toLowerCase() !== "mermaid" ||
					typeof token.text !== "string"
				)
					return token.raw;
				const art = render(token.text);
				if (!art || art.width > width) return token.raw;
				if (!options.streaming && art.warnings.length)
					return token.raw + "\n" + literalLine(`Diagram left as source: ${art.warnings.join("; ")}`) + "\n";
				const theme = options.theme;
				const lines = theme
					? art.styled.map((row) =>
							row
								.map((span) => {
									const role = diagramRoles[span.cls];
									return role ? theme.fg(role, span.cls === "title" ? theme.bold(span.text) : span.text) : span.text;
								})
								.join(""),
						)
					: art.plain;
				return lines.map(literalLine).join("  \n") + "\n";
			})
			.join("");
	};
}

const syntaxRoles: Readonly<Record<string, ThemeToken>> = {
	comment: "syntaxComment",
	quote: "syntaxComment",
	keyword: "syntaxKeyword",
	selector: "syntaxKeyword",
	tag: "syntaxKeyword",
	title: "syntaxFunction",
	function: "syntaxFunction",
	variable: "syntaxVariable",
	attr: "syntaxVariable",
	attribute: "syntaxVariable",
	string: "syntaxString",
	regexp: "syntaxString",
	number: "syntaxNumber",
	literal: "syntaxNumber",
	type: "syntaxType",
	built_in: "syntaxType",
	operator: "syntaxOperator",
	punctuation: "syntaxPunctuation",
};
function decode(text: string): string {
	const entities: Readonly<Record<string, string>> = { amp: "&", lt: "<", gt: ">", quot: '"', "#x27": "'", "#39": "'" };
	return text.replace(/&([^;]+);/g, (original: string, name: string) =>
		Object.hasOwn(entities, name) ? (entities[name] ?? original) : original,
	);
}
export function highlightCode(source: string, language: string | undefined, theme: Theme): string[] {
	const code = (/[\x1b\x80-\x9f]/.test(source) ? stripTerminalSequences(source) : source).replace(
		/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g,
		"",
	);
	const name = language?.trim().split(/\s/)[0]?.toLowerCase();
	if (!name || !hljs.getLanguage(name)) return code.split("\n").map((line) => theme.fg("mdCodeBlock", line));
	const html = hljs.highlight(code, { language: name, ignoreIllegals: true }).value;
	const scopes: (ThemeToken | undefined)[] = [];
	const result = html
		.split(/(<span class="[^"]*">|<\/span>)/g)
		.map((part) => {
			if (part === "</span>") {
				scopes.pop();
				return "";
			}
			const opening = /^<span class="([^"]*)">$/.exec(part);
			if (opening) {
				scopes.push(
					opening[1]
						?.split(/\s+/)
						.map((name) => name.replace(/^hljs-/, ""))
						.flatMap((name) => (Object.hasOwn(syntaxRoles, name) ? [syntaxRoles[name]] : []))
						.find(Boolean),
				);
				return "";
			}
			const role = scopes.findLast((value) => value !== undefined) ?? "mdCodeBlock";
			return decode(part)
				.split("\n")
				.map((line) => (line ? theme.fg(role, line) : ""))
				.join("\n");
		})
		.join("");
	return result.split("\n");
}
