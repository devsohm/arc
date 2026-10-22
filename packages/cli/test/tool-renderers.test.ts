import { afterEach, expect, test, vi } from "vitest";
import {
	stripTerminalSequences,
	Text,
	isFocusable,
	type TuiMouseEvent,
	setCapabilities,
	resetCapabilitiesCache,
} from "@arc/tui";
import { fauxToolCall, type ToolResultMessage } from "@arc/ai";
import { ThemeCatalog } from "../src/core/ui/theme.ts";
import { toolComponent, type ToolCard } from "../src/modes/interactive/components.ts";
import { builtinRenderer } from "../src/modes/interactive/renderers/index.ts";
import { createEditRenderer } from "../src/modes/interactive/renderers/edit.ts";

const display = { toolsExpanded: false, thinkingVisible: false, theme: new ThemeCatalog().resolve("dark") };

test("tool cards apply pending, success and error surfaces while retaining plain output", () => {
	for (const [value, token] of [
		[undefined, "toolPendingBg"],
		[result("bash", "plain output"), "toolSuccessBg"],
		[result("bash", "plain output", { isError: true }), "toolErrorBg"],
	] as const) {
		const view = toolComponent(card("bash", { command: "echo test" }, value), display, builtinRenderer("bash"));
		const lines = view.render(80);
		expect(lines.join("\n")).toContain(display.theme.getBgAnsi(token));
		expect(lines.map(stripTerminalSequences).join("\n")).toContain("$ echo test");
		if (value) expect(lines.map(stripTerminalSequences).join("\n")).toContain("plain output");
		view.disposeExcept();
	}
});
const result = (name: string, text: string, extra: Partial<ToolResultMessage> = {}): ToolResultMessage => ({
	role: "toolResult",
	toolName: name,
	toolCallId: "call",
	timestamp: 0,
	isError: false,
	content: [{ type: "text", text }],
	...extra,
});
const card = (name: string, args: Record<string, string | number>, value?: ToolResultMessage): ToolCard => ({
	kind: "tool",
	name,
	call: fauxToolCall(name, args, { id: "call" }),
	result: value,
});
function render(tool: ToolCard, expanded = false, width = 80): string {
	return toolComponent(tool, { ...display, toolsExpanded: expanded }, builtinRenderer(tool.name))
		.render(width)
		.map(stripTerminalSequences)
		.join("\n");
}
afterEach(() => vi.useRealTimers());
const click: TuiMouseEvent = {
	type: "click",
	button: "left",
	x: 1,
	y: 1,
	screenX: 1,
	screenY: 1,
	width: 80,
	height: 10,
	shift: false,
	alt: false,
	ctrl: false,
};
test("custom tool components retain input, focus and mouse handlers through the renderer wrapper", () => {
	const input = vi.fn(),
		dispose = vi.fn();
	const custom = Object.assign(new Text("Interactive tool", 1, 0), {
		focused: false,
		handleInput: input,
		dispose,
		handleMouse: () => ({ handled: true, focus: true }),
	});
	const view = toolComponent(card("custom", {}), display, { renderCall: () => custom });
	view.render(80);
	const event = view.handleMouse({ ...click, y: click.y + 1 });
	expect(event?.handled).toBe(true);
	const target = event?.target.component;
	if (!target || !isFocusable(target)) throw new Error("Interactive target lost focus support");
	target.focused = true;
	target.handleInput?.("pressed");
	expect(custom.focused).toBe(true);
	expect(input).toHaveBeenCalledWith("pressed");
	view.disposeExcept();
	expect(dispose).toHaveBeenCalledTimes(1);
});
test("read hides successful content until expanded and preserves errors and line ranges", () => {
	const tool = card("read", { path: "file.ts", offset: 5, limit: 3 }, result("read", "private file contents"));
	expect(render(tool)).toContain("read file.ts:5-7");
	expect(render(tool)).not.toContain("private file contents");
	expect(render(tool, true)).toContain("private file contents");
	expect(render(card("read", { path: "missing" }, result("read", "No such file", { isError: true })))).toContain(
		"No such file",
	);
});
test("write previews text rather than serialized arguments and expansion keeps the output plain", () => {
	const content = Array.from({ length: 12 }, (_, i) => `content ${i + 1}`).join("\n");
	const tool = card("write", { path: "file.txt", content }, result("write", "Successful write"));
	expect(render(tool)).toContain("write file.txt");
	expect(render(tool)).toContain("content 10");
	expect(render(tool)).not.toContain("content 12");
	expect(render(tool)).not.toContain("Successful write");
	const lines = toolComponent(tool, { ...display, toolsExpanded: true }, builtinRenderer("write")).render(80);
	const last = lines.find((line) => stripTerminalSequences(line).includes("content 12"));
	expect(last).toBeDefined();
	expect(last?.replace(/\x1b\[(?:48;[0-9;]+|49)m/g, "")).not.toContain("\x1b[");
	expect(
		render(
			card("write", { path: "denied", content: "value" }, result("write", "Permission denied", { isError: true })),
		),
	).toContain("Permission denied");
});
test("bash previews the latest visual lines, includes final timing and releases live redraw timers", async () => {
	const output = Array.from({ length: 8 }, (_, i) => `output ${i + 1}`).join("\n");
	const tool = card("bash", { command: "printf output" }, result("bash", output, { durationMs: 1250 }));
	expect(render(tool)).toContain("$ printf output");
	expect(render(tool)).not.toContain("output 1\n");
	expect(render(tool)).toContain("output 8");
	expect(render(tool)).toContain("3 earlier lines");
	expect(render(tool)).toContain("Took 1.3s");
	expect(render({ ...tool, result: result("bash", output) })).not.toContain("Took");
	expect(render(tool, true)).toContain("output 1");
	vi.useFakeTimers();
	const request = vi.fn();
	const live = toolComponent(
		{ ...tool, result: undefined, slot: { callId: "call", name: "bash", status: "running", output: "live output" } },
		display,
		builtinRenderer("bash"),
		{},
		request,
	);
	await vi.advanceTimersByTimeAsync(1000);
	expect(request).toHaveBeenCalledTimes(1);
	live.disposeExcept();
	await vi.advanceTimersByTimeAsync(1000);
	expect(request).toHaveBeenCalledTimes(1);
});
test("edit replaces its argument preview with the recorded diff and never hides failure output", () => {
	const pending = card("edit", { path: "file.ts", oldText: "old line", newText: "new line" });
	expect(render(pending)).toContain("- old line");
	expect(render(pending)).toContain("+ new line");
	const completed = { ...pending, result: result("edit", "Edited", { details: { diff: "-1 old line\n+1 new line" } }) };
	expect(render(completed)).toContain("-1 old line");
	expect(render(completed)).not.toContain("- old line");
	expect(render({ ...pending, result: result("edit", "Text was not found", { isError: true }) })).toContain(
		"Text was not found",
	);
	expect(builtinRenderer("constructor")).toBeUndefined();
});

test("edit preflight waits for complete arguments, ignores stale reads, and yields to the recorded result", async () => {
	const first = Promise.withResolvers<{ diff: string; firstChangedLine: number | undefined }>();
	const second = Promise.withResolvers<{ diff: string; firstChangedLine: number | undefined }>();
	const compute = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
	const renderer = createEditRenderer(compute);
	const state = {},
		request = vi.fn();
	const tool = card("edit", { path: "first.txt", oldText: "before", newText: "after" });
	toolComponent(tool, display, renderer, state, request).render(80);
	await Promise.resolve();
	expect(compute).not.toHaveBeenCalled();
	const running: ToolCard = { ...tool, slot: { callId: "call", name: "edit", status: "running" } };
	const one = toolComponent(running, display, renderer, state, request);
	await vi.waitFor(() => expect(compute).toHaveBeenCalledTimes(1));
	const other = {
		...running,
		call: fauxToolCall("edit", { path: "second.txt", edits: [{ oldText: "x", newText: "y" }] }),
	};
	const two = toolComponent(other, display, renderer, state, request);
	one.disposeExcept(two.owned);
	await vi.waitFor(() => expect(compute).toHaveBeenCalledTimes(2));
	first.resolve({ diff: "STALE", firstChangedLine: 1 });
	second.resolve({ diff: "-1 x\n+1 y", firstChangedLine: 1 });
	await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(1));
	const text = () => two.render(80).map(stripTerminalSequences).join("\n");
	expect(text()).toContain("-1 x");
	expect(text()).not.toContain("STALE");
	const completed = toolComponent(
		{ ...other, result: result("edit", "Edited", { details: { diff: "ACTUAL DIFF" } }) },
		display,
		renderer,
		state,
		request,
	);
	expect(completed.render(80).map(stripTerminalSequences).join("\n")).toContain("ACTUAL DIFF");
	expect(completed.render(80).map(stripTerminalSequences).join("\n")).not.toContain("-1 x");
	completed.disposeExcept();
});

test("edit preflight shows read failures and disposal prevents late redraws", async () => {
	const deferred = Promise.withResolvers<{ diff: string; firstChangedLine: number | undefined }>();
	const request = vi.fn();
	const tool: ToolCard = {
		...card("edit", { path: "file", oldText: "x", newText: "y" }),
		slot: { callId: "call", name: "edit", status: "running" },
	};
	const failed = toolComponent(
		tool,
		display,
		createEditRenderer(async () => {
			throw new Error("File unreadable");
		}),
		{},
		request,
	);
	await vi.waitFor(() => expect(failed.render(80).map(stripTerminalSequences).join("\n")).toContain("File unreadable"));
	failed.disposeExcept();
	request.mockClear();
	const pending = toolComponent(
		tool,
		display,
		createEditRenderer(() => deferred.promise),
		{},
		request,
	);
	await Promise.resolve();
	pending.disposeExcept();
	deferred.resolve({ diff: "late", firstChangedLine: 1 });
	await deferred.promise;
	await Promise.resolve();
	expect(request).not.toHaveBeenCalled();
});

test("Code Mode shows highlighted source and recorded nested results instead of JSON arguments", () => {
	const tool = card(
		"codemode",
		{ code: 'const value = await tools.read({path:"app.ts"}); text(value);' },
		result("codemode", "Script completed\nWall time 0.2 seconds\nOutput:\n\nfile contents", {
			details: { calls: [{ id: 1, name: "read", args: '{"path":"app.ts"}', status: "ok", durationMs: 12 }] },
		}),
	);
	const view = toolComponent(tool, display, builtinRenderer("codemode"));
	const lines = view.render(100);
	const text = lines.map(stripTerminalSequences).join("\n");
	expect(text).toContain('const value = await tools.read({path:"app.ts"}); text(value);');
	expect(text).not.toContain('"code":');
	expect(text).toContain('✓ read {"path":"app.ts"}');
	expect(text).toContain("file contents");
	expect(text).not.toContain("Script completed");
	expect(lines.join("\n")).toContain(display.theme.getFgAnsi("syntaxKeyword"));
	view.disposeExcept();
});

test("read and write highlight source files without changing the source or coloring shell output", () => {
	const source = 'const greeting = "hello";';
	for (const name of ["read", "write"]) {
		const tool = card(name, { path: "example.ts", content: source }, result(name, source));
		const view = toolComponent(tool, { ...display, toolsExpanded: true }, builtinRenderer(name));
		const lines = view.render(100);
		expect(lines.map(stripTerminalSequences).join("\n")).toContain(source);
		expect(lines.join("\n")).toContain(display.theme.getFgAnsi("syntaxKeyword"));
		view.disposeExcept();
	}
	const shell = toolComponent(
		card("bash", { command: "cat example.ts" }, result("bash", source)),
		display,
		builtinRenderer("bash"),
	);
	const output = shell.render(100).find((line) => stripTerminalSequences(line).includes(source));
	expect(output?.replace(/\x1b\[(?:48;[0-9;]+|49)m/g, "")).not.toContain("\x1b[");
	shell.disposeExcept();
});

test("Code Mode keeps nested results when its output also contains an image", () => {
	setCapabilities({ images: null, trueColor: false, hyperlinks: false });
	try {
		const value = result("codemode", "Image generated", {
			details: { calls: [{ id: 1, name: "generateImages", status: "ok" }] },
			content: [
				{ type: "text", text: "Image generated" },
				{ type: "image", data: "aW1hZ2U=", mimeType: "image/png" },
			],
		});
		const text = render(card("codemode", { code: "image(result);" }, value));
		expect(text).toContain("✓ generateImages");
		expect(text).toContain("Image generated");
		expect(text).toContain("image/png");
	} finally {
		resetCapabilitiesCache();
	}
});

test("edit results color additions and deletions without changing the diff text", () => {
	const diff = "-1 const before = 1;\n+1 const after = 2;";
	const tool = card("edit", { path: "file.ts" }, result("edit", "updated", { details: { diff } }));
	const lines = toolComponent(tool, display, builtinRenderer("edit")).render(80).join("\n");
	expect(lines).toContain(display.theme.getFgAnsi("toolDiffRemoved"));
	expect(lines).toContain(display.theme.getFgAnsi("toolDiffAdded"));
	expect(lines).toContain("\x1b[7m");
	expect(stripTerminalSequences(lines)).toContain("-1 const before = 1;");
	expect(stripTerminalSequences(lines)).toContain("+1 const after = 2;");
});

test("module file previews apply JavaScript syntax colors", () => {
	const view = toolComponent(
		card("write", { path: "start.mjs", content: 'const greeting = "hello";' }),
		display,
		builtinRenderer("write"),
	);
	const lines = view.render(80).join("\n");
	expect(lines).toContain(display.theme.getFgAnsi("syntaxKeyword"));
	expect(lines).toContain(display.theme.getFgAnsi("syntaxString"));
	expect(stripTerminalSequences(lines)).toContain('const greeting = "hello";');
});

test("collapsed previews format only visible source lines and reuse rendered output", async () => {
	const { preview } = await import("../src/modes/interactive/renderers/shared.ts");
	const format = vi.fn((text: string) => text);
	const source = Array.from({ length: 10000 }, (_, i) => `line ${i}`).join("\n");
	const view = preview(source, false, 5, "end", format);
	expect(format).not.toHaveBeenCalled();
	const lines = view.render(80);
	expect(format).toHaveBeenCalledExactlyOnceWith("line 9995\nline 9996\nline 9997\nline 9998\nline 9999");
	expect(lines.map(stripTerminalSequences).join("\n")).toContain("9995 earlier lines");
	expect(view.render(80)).toBe(lines);
	expect(format).toHaveBeenCalledTimes(1);
});

test.each([
	["header.h", "c"],
	["script.zsh", "bash"],
	["build/Makefile", "makefile"],
	["CMakeLists.txt", "cmake"],
	["module.exs", "elixir"],
	["plain.txt", "txt"],
])("file language selection for %s", async (path, language) => {
	const { fileLanguage } = await import("../src/modes/interactive/renderers/shared.ts");
	expect(fileLanguage(path)).toBe(language);
});

test("tail previews retain empty visual rows after nonempty output", async () => {
	const { preview } = await import("../src/modes/interactive/renderers/shared.ts");
	const lines = preview("header\n\n\n\n", false, 2, "end").render(80).map(stripTerminalSequences);
	expect(lines[0]).toContain("3 earlier lines");
	expect(lines.slice(-2).map((line) => line.trim())).toEqual(["", ""]);
});
