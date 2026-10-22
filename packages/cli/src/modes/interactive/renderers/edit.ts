import { Container, Text } from "@arc/tui";
import type { EditToolInput, previewEdit } from "@arc/durable/tools";
import type { ToolRenderers, ToolRenderContext } from "../../../core/ui/tool-renderers.ts";
import type { ToolCall } from "@arc/ai";
import { pathLabel, title, output, preview, diffPreview } from "./shared.ts";

export type EditPreview = (input: EditToolInput) => ReturnType<typeof previewEdit>;

function previewInput(args: Record<string, unknown>): EditToolInput | undefined {
	if (typeof args.path !== "string" || !args.path) return undefined;
	const edits: EditToolInput["edits"] = [];
	if (args.edits !== undefined) {
		if (!Array.isArray(args.edits)) return undefined;
		for (const edit of args.edits) {
			if (
				!edit ||
				typeof edit !== "object" ||
				!("oldText" in edit) ||
				!("newText" in edit) ||
				typeof edit.oldText !== "string" ||
				typeof edit.newText !== "string"
			)
				return undefined;
			edits.push({ oldText: edit.oldText, newText: edit.newText });
		}
	}
	if (typeof args.oldText === "string" && typeof args.newText === "string")
		edits.push({ oldText: args.oldText, newText: args.newText });
	return edits.length ? { path: args.path, edits } : undefined;
}

class EditCall extends Container {
	#key: string | undefined;
	#version = 0;
	#context: ToolRenderContext | undefined;
	#args: ToolCall["arguments"] = {};
	#fallback: string | undefined;
	#preview: { diff: string } | { error: string } | undefined;
	update(args: ToolCall["arguments"], context: ToolRenderContext, compute?: EditPreview): void {
		this.#args = args;
		this.#context = context;
		const input = context.partial ? previewInput(args) : undefined;
		this.#fallback =
			input && !compute
				? input.edits
						.flatMap((edit) => [
							...edit.oldText.split("\n").map((line) => `- ${line}`),
							...edit.newText.split("\n").map((line) => `+ ${line}`),
						])
						.join("\n")
				: undefined;
		const key = input && context.argsComplete && compute ? JSON.stringify(input) : undefined;
		if (key !== this.#key) {
			this.#key = key;
			const version = ++this.#version;
			this.#preview = undefined;
			if (input && compute && key)
				void Promise.resolve()
					.then(() => compute(input))
					.then(
						(value) => this.#settle(version, { diff: value.diff }),
						(error: unknown) =>
							this.#settle(version, { error: error instanceof Error ? error.message : String(error) }),
					);
		}
		this.#draw();
	}
	#settle(version: number, value: { diff: string } | { error: string }): void {
		if (version !== this.#version || !this.#context) return;
		this.#preview = value;
		this.#draw();
		this.#context.requestRender();
	}
	#draw(): void {
		const context = this.#context;
		if (!context) return;
		this.clear();
		this.addChild(title(`edit ${pathLabel(this.#args)}`, context));
		const text = this.#preview ? ("diff" in this.#preview ? this.#preview.diff : this.#preview.error) : this.#fallback;
		if (text !== undefined)
			this.addChild(
				this.#preview && "error" in this.#preview
					? preview(text, context.expanded, 10)
					: diffPreview(text, context, 10),
			);
	}
	dispose(): void {
		this.#version++;
		this.#context = undefined;
		this.#key = undefined;
		this.clear();
	}
}

export function createEditRenderer(compute?: EditPreview): ToolRenderers {
	return {
		renderShell: "self",
		renderCall(args, context) {
			const view = context.state.editPreview instanceof EditCall ? context.state.editPreview : new EditCall();
			context.state.editPreview = view;
			view.update(args, context, compute);
			return view;
		},
		renderResult(result, context) {
			const details = result?.details;
			const diff =
				details && typeof details === "object" && "diff" in details && typeof details.diff === "string"
					? details.diff
					: undefined;
			return diff && !result?.isError ? diffPreview(diff, context, 10) : new Text(output(result, context), 1, 0);
		},
	};
}

export const editRenderer = createEditRenderer();
