import type { ToolRenderers } from "../../../core/ui/tool-renderers.ts";
import { readRenderer } from "./read.ts";
import { writeRenderer } from "./write.ts";
import { editRenderer, createEditRenderer, type EditPreview } from "./edit.ts";
import { bashRenderer } from "./bash.ts";
import { codemodeRenderer } from "./codemode.ts";

const renderers = new Map<string, ToolRenderers>([
	["read", readRenderer],
	["write", writeRenderer],
	["edit", editRenderer],
	["bash", bashRenderer],
	["codemode", codemodeRenderer],
]);
export function builtinRenderer(name: string, editPreview?: EditPreview): ToolRenderers | undefined {
	if (name === "edit" && editPreview) return createEditRenderer(editPreview);
	return renderers.get(name);
}
