import { MemoryStorage, type EntryId, type ConversationId, type EntryRecord } from "@arc/durable";
import { fauxAssistantMessage, fauxToolCall } from "@arc/ai";
import {
	KeybindingsManager,
	TUI_KEYBINDINGS,
	getKeybindings,
	setKeybindings,
	stripTerminalSequences,
	visibleWidth,
} from "@arc/tui";
import { afterEach, expect, test, vi } from "vitest";
import { sessionTree, filterTree } from "../src/core/sessions/navigation.ts";
import { labelTimestamp, TreeSelector } from "../src/modes/interactive/tree-selector.ts";
import { APP_KEYBINDINGS } from "../src/core/configuration/keybindings.ts";

const original = getKeybindings();
afterEach(() => setKeybindings(original));
const plain = (text: string) => text;
const theme = { selectedPrefix: plain, selectedText: plain, description: plain, scrollInfo: plain, noMatch: plain };
async function tree(question = "initial question") {
	const storage = new MemoryStorage();
	const root = await storage.mintId<ConversationId>(),
		branch = await storage.mintId<ConversationId>();
	const ids = await Promise.all(Array.from({ length: 5 }, () => storage.mintId<EntryId>()));
	const entries: EntryRecord[] = [
		{
			id: ids[0],
			conversationId: root,
			kind: "arc.user",
			model: [{ role: "user", content: question, timestamp: 0 }],
		},
		{
			id: ids[1],
			conversationId: root,
			kind: "arc.assistant",
			model: [fauxAssistantMessage(fauxToolCall("read", { path: "file" }), { stopReason: "toolUse" })],
		},
		{
			id: ids[2],
			conversationId: root,
			kind: "arc.tool-result",
			model: [
				{
					role: "toolResult",
					toolCallId: "call",
					toolName: "read",
					content: [{ type: "text", text: "tool text" }],
					timestamp: 0,
					isError: false,
				},
			],
		},
		{ id: ids[3], conversationId: root, kind: "arc.assistant", model: [fauxAssistantMessage("source answer")] },
		{
			id: ids[4],
			conversationId: branch,
			kind: "arc.user",
			model: [{ role: "user", content: "branch question", timestamp: 0 }],
		},
	];
	return sessionTree([{ id: root }, { id: branch, parent: { conversationId: root, at: ids[0] } }], entries, branch, {
		[ids[4]]: { text: "checkpoint", updated: 0 },
	});
}

test("tree filters exclude tool-only assistant entries, preserve labeled nodes and search all words", async () => {
	const items = await tree();
	expect(filterTree(items, "default").map((item) => item.text)).toEqual([
		"initial question",
		"branch question",
		"tool text",
		"source answer",
	]);
	expect(filterTree(items, "no-tools").map((item) => item.text)).toEqual([
		"initial question",
		"branch question",
		"source answer",
	]);
	expect(filterTree(items, "user-only").map((item) => item.text)).toEqual(["initial question", "branch question"]);
	expect(filterTree(items, "labeled-only").map((item) => item.text)).toEqual(["branch question"]);
	expect(filterTree(items, "all", "checkpoint branch").map((item) => item.text)).toEqual(["branch question"]);
});

test("tree selection, label input and folding use named keybindings", async () => {
	setKeybindings(new KeybindingsManager({ ...TUI_KEYBINDINGS, ...APP_KEYBINDINGS }));
	const items = await tree(),
		done = vi.fn(),
		copy = vi.fn(async () => {});
	const picker = new TreeSelector(
		items,
		{ initialValue: items.find((item) => item.current)?.value, filter: "default", limit: 8 },
		done,
		copy,
		theme,
	);
	picker.focused = true;
	picker.handleInput("\x18");
	expect(copy).toHaveBeenCalledWith("branch question");
	picker.handleInput("L");
	picker.handleInput("\x05");
	picker.handleInput(" edited");
	picker.handleInput("\r");
	expect(done).toHaveBeenCalledWith({
		action: "label",
		value: items.find((item) => item.current)?.value,
		filter: "default",
		label: "checkpoint edited",
	});
	const select = new TreeSelector(
		items,
		{ initialValue: items[0].value, filter: "default", limit: 8 },
		done,
		copy,
		theme,
	);
	select.handleInput("\x1b[1;5D");
	expect(select.render(80).map(stripTerminalSequences).join("\n")).toContain("⊞");
	select.handleInput("\x1b[1;5C");
	expect(select.render(80).map(stripTerminalSequences).join("\n")).not.toContain("⊞");
});

test("deep selected entries remain readable and all tree rows fit narrow terminal widths", async () => {
	const items = (await tree()).map((item) => ({ ...item, prefix: undefined, depth: item.current ? 40 : 0 }));
	const picker = new TreeSelector(
		items,
		{ initialValue: items.find((item) => item.current)?.value, filter: "all", limit: 8 },
		() => {},
		async () => {},
		theme,
	);
	for (const width of [1, 12, 32, 80]) {
		const lines = picker.render(width);
		expect(lines.every((line) => visibleWidth(line) <= width)).toBe(true);
		if (width === 32) expect(lines.map(stripTerminalSequences).join("\n")).toContain("[checkpoint]");
	}
});

test("tree search and clipboard retain text beyond the displayed preview", async () => {
	const question = "Beginning\n" + "x".repeat(260) + " unique ending";
	const items = await tree(question);
	expect(items[0].text).toBe(question);
	expect(filterTree(items, "user-only", "unique ending").map((item) => item.value)).toEqual([items[0].value]);
	setKeybindings(new KeybindingsManager({ ...TUI_KEYBINDINGS, ...APP_KEYBINDINGS }));
	const copy = vi.fn(async () => {});
	const picker = new TreeSelector(
		items,
		{ initialValue: items[0].value, filter: "default", limit: 8 },
		() => {},
		copy,
		theme,
	);
	picker.handleInput("\x18");
	expect(copy).toHaveBeenCalledWith(question);
});

test("tree movement wraps and folded navigation skips linear ancestors", async () => {
	setKeybindings(new KeybindingsManager({ ...TUI_KEYBINDINGS, ...APP_KEYBINDINGS }));
	const items = await tree(),
		done = vi.fn();
	const picker = new TreeSelector(
		items,
		{ initialValue: items[0].value, filter: "default", limit: 8 },
		done,
		async () => {},
		theme,
	);
	picker.handleInput("\x1b[A");
	picker.handleInput("\r");
	expect(done).toHaveBeenLastCalledWith({
		action: "select",
		value: filterTree(items, "default").at(-1)?.value,
		filter: "default",
	});
	picker.handleInput("\x1b[B");
	picker.handleInput("\r");
	expect(done).toHaveBeenLastCalledWith({ action: "select", value: items[0].value, filter: "default" });
});

test("label timestamps use local time, month/day and a two-digit prior year", () => {
	const now = new Date(2026, 9, 21, 18, 0);
	expect(labelTimestamp(new Date(2026, 9, 21, 8, 5).getTime(), now)).toBe("08:05");
	expect(labelTimestamp(new Date(2026, 9, 20, 8, 5).getTime(), now)).toBe("10/20 08:05");
	expect(labelTimestamp(new Date(2025, 9, 20, 8, 5).getTime(), now)).toBe("25/10/20 08:05");
});
