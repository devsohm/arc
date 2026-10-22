import { plainText } from "../../../core/ui/text.ts";
import { Container, Text } from "@arc/tui";
import type { ToolRenderers } from "../../../core/ui/tool-renderers.ts";
import { highlightCode } from "../markdown.ts";
import { imageComponent } from "../components.ts";
import { title, output, preview } from "./shared.ts";

function recordedCalls(details: unknown, expanded: boolean): string[] {
	if (!details || typeof details !== "object" || !("calls" in details) || !Array.isArray(details.calls)) return [];
	return details.calls.flatMap((call: unknown) => {
		if (!call || typeof call !== "object" || !("name" in call) || typeof call.name !== "string" || !("status" in call))
			return [];
		const icon = call.status === "ok" ? "✓" : call.status === "error" ? "✗" : call.status === "cancelled" ? "⊘" : "…";
		const args = "args" in call && typeof call.args === "string" ? plainText(call.args) : "";
		const duration =
			"durationMs" in call && typeof call.durationMs === "number" ? ` · ${(call.durationMs / 1000).toFixed(1)}s` : "";
		const error = expanded && "error" in call && typeof call.error === "string" ? `\n  ${plainText(call.error)}` : "";
		return [
			`${icon} ${plainText(call.name)}${args ? ` ${expanded ? args : args.slice(0, 80)}` : ""}${duration}${error}`,
		];
	});
}

export const codemodeRenderer: ToolRenderers = {
	renderShell: "self",
	renderCall(args, context) {
		const view = new Container();
		view.addChild(title("codemode", context));
		if (typeof args.code !== "string") {
			view.addChild(new Text("[invalid code: expected JavaScript source]", 1, 0));
			return view;
		}
		const code = plainText(args.code).replace(/\t/g, "    ");
		const theme = context.theme;
		view.addChild(
			preview(
				code,
				context.expanded,
				10,
				"start",
				theme ? (source) => highlightCode(source, "javascript", theme).join("\n") : undefined,
			),
		);
		return view;
	},
	renderResult(result, context) {
		const view = new Container();
		const rows = recordedCalls(result?.details ?? context.slot?.details, context.expanded);
		if (!rows.length) {
			for (const call of context.nested ?? []) {
				const icon = call.status !== "done" ? "…" : call.summary?.isError ? "✗" : "✓";
				rows.push(`${icon} ${plainText(call.name)} ${plainText(JSON.stringify(call.arguments))}`);
			}
		}
		if (rows.length) view.addChild(preview(rows.join("\n"), context.expanded, 8, "end"));
		const text = output(result, context).replace(
			/^Script (?:completed|failed)\nWall time [\d.]+ seconds\nOutput:\n\n?/,
			"",
		);
		if (text) view.addChild(preview(text, context.expanded, 5));
		for (const part of result?.content ?? []) if (part.type === "image") view.addChild(imageComponent(part));
		if (result?.durationMs !== undefined)
			view.addChild(new Text(`Took ${(result.durationMs / 1000).toFixed(1)}s`, 1, 0));
		return view;
	},
};
