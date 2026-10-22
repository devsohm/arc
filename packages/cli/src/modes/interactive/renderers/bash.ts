import { Text } from "@arc/tui";
import type { ToolRenderers } from "../../../core/ui/tool-renderers.ts";
import { highlightCode } from "../markdown.ts";
import { plainText } from "../../../core/ui/text.ts";
import { title, output, preview } from "./shared.ts";

export const bashRenderer: ToolRenderers = {
	renderShell: "self",
	renderCall(args, context) {
		if (context.partial && context.executionStarted && typeof context.state.startedAt !== "number")
			context.state.startedAt = Date.now();
		const command = plainText(typeof args.command === "string" ? args.command : "…");
		const suffix = typeof args.timeout === "number" ? ` (timeout ${args.timeout}s)` : "";
		return context.theme && !context.isError
			? new Text(`$ ${highlightCode(command, "bash", context.theme).join("\n")}${suffix}`, 1, 0)
			: title(`$ ${command}${suffix}`, context);
	},
	renderResult(result, context) {
		if (result?.content.some((part) => part.type === "image")) return undefined;
		const text = preview(output(result, context).trim(), context.expanded, 5, "end");
		const startedAt = typeof context.state.startedAt === "number" ? context.state.startedAt : undefined;
		const timer = context.partial && context.executionStarted ? setInterval(context.requestRender, 1000) : undefined;
		return {
			render(width) {
				const duration = result?.durationMs ?? (startedAt === undefined ? undefined : Date.now() - startedAt);
				return [
					...text.render(width),
					...(duration === undefined
						? []
						: new Text(`${result ? "Took" : "Elapsed"} ${(duration / 1000).toFixed(1)}s`, 1, 0).render(width)),
				];
			},
			invalidate() {
				text.invalidate();
			},
			dispose() {
				clearInterval(timer);
			},
		};
	},
};
