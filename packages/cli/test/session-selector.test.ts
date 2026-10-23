import { getKeybindings, setKeybindings, KeybindingsManager, TUI_KEYBINDINGS, stripTerminalSequences } from "@arc/tui";
import { expect, test, vi } from "vitest";
import { SessionSelector, filterSessions } from "../src/modes/interactive/session-selector.ts";
import { APP_KEYBINDINGS } from "../src/core/configuration/keybindings.ts";

const items = [
	{ path: "/sessions/one.sqlite", name: "First task", modified: 1 },
	{ path: "/sessions/two.sqlite", name: "Second task", modified: 2 },
];
const identity = (s: string) => s;
const theme = {
	selectedText: identity,
	selectedPrefix: identity,
	description: identity,
	scrollInfo: identity,
	noMatch: identity,
};
test("session searching supports words, exact phrases, regex and malformed patterns", () => {
	expect(filterSessions(items, '"First task"').map((x) => x.path)).toEqual([items[0]!.path]);
	expect(filterSessions(items, "task re:Second").map((x) => x.path)).toEqual([items[1]!.path]);
	expect(() => filterSessions(items, "re:[")).toThrow();
});
test("session picker confirms deletion, renames, switches scope and keeps current sessions", async () => {
	const previous = getKeybindings();
	setKeybindings(new KeybindingsManager({ ...TUI_KEYBINDINGS, ...APP_KEYBINDINGS }));
	try {
		const remove = vi.fn(async () => {}),
			rename = vi.fn(async () => {}),
			load = vi.fn(async () => items),
			done = vi.fn();
		const picker = new SessionSelector({ current: items[0]!.path, load, remove, rename }, done, () => {}, theme);
		picker.focused = true;
		await vi.waitFor(() => expect(load).toHaveBeenCalledWith("current"));
		await new Promise((resolve) => setImmediate(resolve));
		picker.handleInput("\x04");
		expect(remove).not.toHaveBeenCalled();
		expect(picker.render(100).join("\n")).toContain("Permanently delete");
		picker.handleInput("\x1b");
		expect(remove).not.toHaveBeenCalled();
		picker.handleInput("\x12");
		picker.handleInput("\x01");
		picker.handleInput("\x0b");
		picker.handleInput("Updated");
		picker.handleInput("\r");
		await vi.waitFor(() => expect(rename).toHaveBeenCalledWith(items[1]!.path, "Updated"));
		await new Promise((resolve) => setImmediate(resolve));
		picker.handleInput("\x04");
		picker.handleInput("\r");
		await vi.waitFor(() => expect(remove).toHaveBeenCalledWith(items[1]!.path));
		await new Promise((resolve) => setImmediate(resolve));
		picker.handleInput("\x1b[B");
		picker.handleInput("\x04");
		expect(stripTerminalSequences(picker.render(100).join("\n"))).toContain("Cannot delete the current");
		picker.handleInput("\t");
		await vi.waitFor(() => expect(load).toHaveBeenCalledWith("all"));
		await new Promise((resolve) => setImmediate(resolve));
		picker.handleInput("\r");
		expect(done).toHaveBeenCalledWith(items[0]!.path);
	} finally {
		setKeybindings(previous);
	}
});
