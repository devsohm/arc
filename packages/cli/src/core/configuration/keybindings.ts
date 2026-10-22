import { join } from "node:path";
import { Key, KeybindingsManager, TUI_KEYBINDINGS, type KeyId, type KeybindingsConfig } from "@arc/tui";
import { readJsonFile } from "./file-storage.ts";

const windows = process.platform === "win32" || Boolean(process.env.WSL_DISTRO_NAME || process.env.WSL_INTEROP);
export const APP_KEYBINDINGS = {
	"app.clear": { defaultKeys: "ctrl+c", description: "Abort, clear input or exit" },
	"app.interrupt": { defaultKeys: "escape", description: "Cancel or abort" },
	"app.exit": { defaultKeys: "ctrl+d", description: "Exit when input is empty" },
	"app.model.cycleForward": { defaultKeys: "ctrl+p", description: "Next model" },
	"app.model.cycleBackward": { defaultKeys: windows ? "alt+p" : "ctrl+shift+p", description: "Previous model" },
	"app.model.select": { defaultKeys: "ctrl+l", description: "Select model" },
	"app.thinking.cycle": { defaultKeys: "shift+tab", description: "Cycle thinking level" },
	"app.tools.expand": { defaultKeys: "ctrl+o", description: "Expand tool output" },
	"app.thinking.toggle": { defaultKeys: "ctrl+t", description: "Show thinking" },
	"app.message.followUp": { defaultKeys: windows ? "ctrl+q" : "alt+enter", description: "Queue follow-up" },
	"app.clipboard.pasteImage": {
		defaultKeys: windows ? "alt+v" : "ctrl+v",
		description: "Paste clipboard image or text",
	},
	"app.message.copy": { defaultKeys: "ctrl+x", description: "Copy last assistant answer" },
	"app.models.save": { defaultKeys: "ctrl+s", description: "Save model scope" },
	"app.models.apply": { defaultKeys: "enter", description: "Close model scope" },
	"app.models.toggle": { defaultKeys: "space", description: "Toggle selected model" },
	"app.models.enableAll": { defaultKeys: "ctrl+a", description: "Enable all models" },
	"app.models.clearAll": { defaultKeys: "ctrl+x", description: "Clear enabled models" },
	"app.models.toggleProvider": { defaultKeys: "ctrl+p", description: "Toggle provider models" },
	"app.models.reorderUp": { defaultKeys: "alt+up", description: "Move model earlier" },
	"app.models.reorderDown": { defaultKeys: "alt+down", description: "Move model later" },
	"app.session.new": { defaultKeys: [], description: "New session" },
	"app.session.tree": { defaultKeys: [], description: "Select conversation" },
	"app.session.fork": { defaultKeys: [], description: "Fork conversation" },
	"app.session.resume": { defaultKeys: [], description: "Reopen session" },
	"app.tree.foldOrUp": { defaultKeys: ["ctrl+left", "alt+left"], description: "Fold branch or move to its parent" },
	"app.tree.unfoldOrDown": {
		defaultKeys: ["ctrl+right", "alt+right"],
		description: "Unfold branch or move to its child",
	},
	"app.tree.editLabel": { defaultKeys: "shift+l", description: "Edit entry label" },
	"app.tree.toggleLabelTimestamp": { defaultKeys: "shift+t", description: "Show label timestamps" },
	"app.tree.filter.default": { defaultKeys: "ctrl+d", description: "Default tree filter" },
	"app.tree.filter.noTools": { defaultKeys: "ctrl+t", description: "Hide tool results" },
	"app.tree.filter.userOnly": { defaultKeys: "ctrl+u", description: "Show user entries" },
	"app.tree.filter.labeledOnly": { defaultKeys: "ctrl+l", description: "Show labeled entries" },
	"app.tree.filter.all": { defaultKeys: "ctrl+a", description: "Show all entries" },
	"app.tree.filter.cycleForward": { defaultKeys: "ctrl+o", description: "Next tree filter" },
	"app.tree.filter.cycleBackward": { defaultKeys: "ctrl+shift+o", description: "Previous tree filter" },
} satisfies Record<string, { defaultKeys: KeyId | KeyId[]; description: string }>;

declare module "@arc/tui" {
	interface Keybindings extends Record<keyof typeof APP_KEYBINDINGS, true> {}
}

const definitions = { ...TUI_KEYBINDINGS, ...APP_KEYBINDINGS };
const baseKeys = new Set<string>(Object.values(Key).flatMap((value) => (typeof value === "string" ? [value] : [])));
function isKey(value: unknown): value is KeyId {
	if (typeof value !== "string" || !value) return false;
	const parts = value.split("+");
	let key = parts.pop();
	if (key === "") {
		if (parts.pop() !== "") return false;
		key = "+";
	}
	return (
		key !== undefined &&
		(/^[a-z0-9]$/.test(key) || baseKeys.has(key)) &&
		new Set(parts).size === parts.length &&
		parts.every((part) => ["ctrl", "alt", "shift", "super"].includes(part))
	);
}

export async function loadKeybindings(home: string): Promise<KeybindingsManager> {
	const path = join(home, "keybindings.json");
	const data = await readJsonFile(path);
	const config: KeybindingsConfig = {};
	if (data !== undefined) {
		if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error(`Invalid keybindings in ${path}`);
		for (const [name, value] of Object.entries(data)) {
			if (!Object.hasOwn(definitions, name)) throw new Error(`Unknown keybinding: ${name}`);
			if (isKey(value)) config[name] = value;
			else if (Array.isArray(value) && value.every(isKey)) config[name] = value;
			else throw new Error(`Invalid keys for ${name}`);
		}
	}
	return new KeybindingsManager(definitions, config);
}

export function blocksExtensionShortcut(data: string, bindings: KeybindingsManager): boolean {
	const protectedActions = [
		"app.clear",
		"app.interrupt",
		"app.exit",
		"app.thinking.cycle",
		"app.model.cycleForward",
		"app.model.cycleBackward",
		"app.model.select",
		"app.tools.expand",
		"app.thinking.toggle",
		"app.message.copy",
		"app.message.followUp",
		"tui.input.submit",
		"tui.select.confirm",
		"tui.select.cancel",
		"tui.input.copy",
		"tui.editor.deleteToLineEnd",
	] as const;
	return protectedActions.some((action) => bindings.matches(data, action));
}
