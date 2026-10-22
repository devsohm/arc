import { Container, Text } from "@arc/tui";
import type { ToolRenderers } from "../../../core/ui/tool-renderers.ts";
import { pathLabel, title, output, filePreview } from "./shared.ts";

export const writeRenderer: ToolRenderers = {
	renderShell: "self",
	renderCall(args, context) {
		const view = new Container();
		view.addChild(title(`write ${pathLabel(args)}`, context));
		if (typeof args.content === "string") view.addChild(filePreview(args.content, pathLabel(args), context, 10));
		else if (args.content != null) view.addChild(new Text("[invalid content: expected text]", 1, 0));
		return view;
	},
	renderResult(result, context) {
		return result?.isError ? new Text(output(result, context), 1, 0) : new Text("", 0, 0);
	},
};
