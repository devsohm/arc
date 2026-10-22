import { diffWords } from "diff";
import { plainText } from "../../../core/ui/text.ts";
import { basename, extname } from "node:path";
import hljs from "highlight.js";
import { highlightCode } from "../markdown.ts";
import { Text, type Component } from "@arc/tui";
import type { ToolCall, ToolResultMessage } from "@arc/ai";
import type { ToolRenderContext } from "../../../core/ui/tool-renderers.ts";
import { shortcut } from "../components.ts";

export function pathLabel(args: ToolCall["arguments"]): string {
	const path = args.file_path ?? args.path;
	return typeof path === "string" ? plainText(path) : "[invalid path]";
}
export function title(label: string, context: ToolRenderContext): Text {
	const value = plainText(label);
	return new Text(
		context.theme ? context.theme.bold(context.theme.fg(context.isError ? "error" : "toolTitle", value)) : value,
		1,
		0,
	);
}
export function output(result: ToolResultMessage | undefined, context: ToolRenderContext): string {
	return plainText(
		result
			? result.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n")
			: (context.slot?.output ?? ""),
	);
}
export function preview(
	source: string,
	expanded: boolean,
	limit: number,
	keep: "start" | "end" = "start",
	format?: (source: string) => string,
): Component {
	const clean = plainText(source);
	const raw = new Text(clean, 1, 0);
	const sourceLines = clean.split("\n");
	let text: Text | undefined;
	let cached: { width: number; lines: string[] } | undefined;
	return {
		render(width) {
			if (cached?.width === width) return cached.lines;
			const contentWidth = Math.max(1, width - 2 * Math.min(1, Math.max(0, Math.floor((width - 1) / 2))));
			const simple =
				!expanded && sourceLines.every((line) => line.length <= contentWidth && /^[\x20-\x7e]*$/.test(line));
			const lineCount = expanded ? 0 : simple && clean.trim() ? sourceLines.length : raw.render(width).length;
			let lines: string[];
			if (!expanded && lineCount > limit) {
				const selected = (keep === "end" ? sourceLines.slice(-limit) : sourceLines.slice(0, limit)).join("\n");
				lines =
					!selected.trim() && clean.trim()
						? raw.render(width)
						: new Text(format ? format(selected) : selected, 1, 0).render(width);
			} else {
				text ??= format ? new Text(format(clean), 1, 0) : raw;
				lines = text.render(width);
			}
			if (expanded || lineCount <= limit) {
				cached = { width, lines };
				return lines;
			}
			const hint = new Text(
				`${lineCount - limit} ${keep === "end" ? "earlier" : "more"} lines · ${shortcut("app.tools.expand", "Ctrl+O")} to expand`,
				1,
				0,
			).render(width);
			const shown = keep === "end" ? [...hint, ...lines.slice(-limit)] : [...lines.slice(0, limit), ...hint];
			cached = { width, lines: shown };
			return shown;
		},
		invalidate() {
			raw.invalidate();
			text?.invalidate();
			cached = undefined;
		},
	};
}

export function filePreview(source: string, path: string, context: ToolRenderContext, limit: number): Component {
	const theme = context.theme;
	const language = fileLanguage(path);
	const syntax = hljs.getLanguage(language);
	return preview(
		source,
		context.expanded,
		limit,
		"start",
		theme && syntax && syntax.name !== "Plain text"
			? (code) => highlightCode(code, language, theme).join("\n")
			: undefined,
	);
}

const fileNames = new Map([
	["dockerfile", "dockerfile"],
	["makefile", "makefile"],
	["cmakelists.txt", "cmake"],
]);
const fileAliases = new Map([
	["h", "c"],
	["zsh", "bash"],
	["ex", "elixir"],
	["exs", "elixir"],
	["erl", "erlang"],
	["ml", "ocaml"],
	["clj", "clojure"],
	["hs", "haskell"],
	["proto", "protobuf"],
	["tf", "hcl"],
]);
export function fileLanguage(path: string): string {
	const named = fileNames.get(basename(path).toLowerCase());
	if (named) return named;
	const extension = extname(path).slice(1).toLowerCase();
	switch (extension) {
		case "tsx":
		case "mts":
		case "cts":
			return "typescript";
		case "jsx":
		case "mjs":
		case "cjs":
			return "javascript";
		default:
			return fileAliases.get(extension) ?? extension;
	}
}

export function diffPreview(source: string, context: ToolRenderContext, limit: number): Component {
	const theme = context.theme;
	return preview(
		source,
		context.expanded,
		limit,
		"start",
		theme
			? (text) => {
					const lines = text.split("\n");
					const painted: string[] = [];
					for (let i = 0; i < lines.length; i++) {
						const line = lines[i] ?? "";
						const old = /^-(\s*\d* )(.*)$/.exec(line);
						const next = lines[i + 1];
						const added = next === undefined ? null : /^\+(\s*\d* )(.*)$/.exec(next);
						if (old && added && !lines[i - 1]?.startsWith("-") && !lines[i + 2]?.startsWith("+")) {
							let before = "",
								after = "";
							for (const part of diffWords(old[2] ?? "", added[2] ?? "")) {
								const value =
									part.added || part.removed
										? part.value.replace(
												/^(\s*)(\S[\s\S]*)$/,
												(_, space: string, code: string) => space + theme.inverse(code),
											)
										: part.value;
								if (!part.added) before += value;
								if (!part.removed) after += value;
							}
							painted.push(
								theme.fg("toolDiffRemoved", `-${old[1]}${before}`),
								theme.fg("toolDiffAdded", `+${added[1]}${after}`),
							);
							i++;
						} else
							painted.push(
								theme.fg(
									line.startsWith("+") ? "toolDiffAdded" : line.startsWith("-") ? "toolDiffRemoved" : "toolDiffContext",
									line,
								),
							);
					}
					return painted.join("\n");
				}
			: undefined,
	);
}
