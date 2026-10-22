import { Text } from "@arc/tui";
import type { ToolRenderers } from "../../../core/ui/tool-renderers.ts";
import { pathLabel, title, output, preview, filePreview } from "./shared.ts";

export const readRenderer: ToolRenderers = {
	renderShell: "self",
	renderCall(args, context) {
		const offset = typeof args.offset === "number" ? args.offset : 1;
		const range =
			args.offset == null && args.limit == null
				? ""
				: `:${offset}${typeof args.limit === "number" ? `-${offset + args.limit - 1}` : ""}`;
		return title(`read ${pathLabel(args)}${range}`, context);
	},
	renderResult(result, context) {
		if (result?.content.some((part) => part.type === "image")) return undefined;
		if (result?.isError) return preview(output(result, context), context.expanded, 10);
		return context.expanded
			? filePreview(output(result, context), pathLabel(context.call?.arguments ?? {}), context, 10)
			: new Text("", 0, 0);
	},
};
