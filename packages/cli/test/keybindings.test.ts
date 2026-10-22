import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, test } from "vitest";
import { loadKeybindings, blocksExtensionShortcut } from "../src/core/configuration/keybindings.ts";

const folders: string[] = [];
afterEach(async () => {
	for (const folder of folders.splice(0)) await rm(folder, { recursive: true, force: true });
});
async function home() {
	const folder = await mkdtemp(join(tmpdir(), "arc-keys-"));
	folders.push(folder);
	return folder;
}

test("loads defaults, remaps application and editor actions, and disables bindings", async () => {
	const folder = await home();
	expect((await loadKeybindings(folder)).matches("\x0f", "app.tools.expand")).toBe(true);
	await writeFile(
		join(folder, "keybindings.json"),
		"\ufeff" +
			JSON.stringify({
				"app.tools.expand": ["ctrl+y", "alt+o"],
				"app.thinking.toggle": [],
				"tui.input.submit": "ctrl+s",
				"tui.editor.cursorLeft": "ctrl++",
			}),
	);
	const bindings = await loadKeybindings(folder);
	expect(bindings.matches("\x19", "app.tools.expand")).toBe(true);
	expect(bindings.matches("\x0f", "app.tools.expand")).toBe(false);
	expect(bindings.matches("\x14", "app.thinking.toggle")).toBe(false);
	expect(bindings.matches("\x13", "tui.input.submit")).toBe(true);
	expect(bindings.getKeys("tui.editor.cursorLeft")).toEqual(["ctrl++"]);
});

test.each([
	null,
	[],
	{ "app.tools.expand": "" },
	{ "app.tools.expand": "ctrl+" },
	{ "app.tools.expand": "ctrl+ctrl+o" },
	{ "app.tools.expand": "banana" },
	{ unknown: "enter" },
])("rejects malformed or unknown bindings: %j", async (value) => {
	const folder = await home();
	await writeFile(join(folder, "keybindings.json"), JSON.stringify(value));
	await expect(loadKeybindings(folder)).rejects.toThrow();
});

test("extension shortcut reservations follow configured global actions", async () => {
	const folder = await home();
	await writeFile(join(folder, "keybindings.json"), JSON.stringify({ "app.tools.expand": "ctrl+y" }));
	const bindings = await loadKeybindings(folder);
	expect(blocksExtensionShortcut("\x19", bindings)).toBe(true);
	expect(blocksExtensionShortcut("\x0f", bindings)).toBe(false);
	expect(blocksExtensionShortcut("\x0c", bindings)).toBe(true);
	expect(blocksExtensionShortcut("\r", bindings)).toBe(true);
	expect(blocksExtensionShortcut("\x07", bindings)).toBe(false);
});
