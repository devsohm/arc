import { Editor, ScrollView, Text, VStack } from "@arc/tui";
import { expect, test, vi } from "vitest";
import { InteractiveRenderer } from "../src/modes/interactive/tui-renderer.ts";
import { TestTerminal } from "../../tui/test/support/terminal.ts";

test("screen changes preserve the editor, captured render callbacks and removable input/color subscriptions", async () => {
	const terminal = new TestTerminal(70, 18);
	const presentation = new InteractiveRenderer(terminal, false);
	const ui = presentation.ui;
	const plain = (text: string) => text;
	const editor = new Editor(ui, {
		borderColor: plain,
		selectList: {
			selectedPrefix: plain,
			selectedText: plain,
			description: plain,
			scrollInfo: plain,
			noMatch: plain,
		},
	});
	const transcript = new Text("Conversation stays attached", 1, 0);
	ui.addChild(transcript);
	ui.addChild(editor);
	presentation.setLayoutRoot(
		new VStack([
			{ component: new ScrollView(transcript), grow: 1, basis: 0 },
			{ component: editor, shrink: 0 },
		]),
	);
	ui.setFocus(editor);
	const input = vi.fn();
	const schemes: string[] = [];
	const removeInput = ui.addInputListener(input);
	const removeColors = ui.onTerminalColorSchemeChange((scheme) => schemes.push(scheme));
	const requestRender = ui.requestRender;
	ui.setTerminalColorSchemeNotifications(true);
	ui.start();
	try {
		terminal.input("draft");
		for (const fullscreen of [true, false, true, false]) {
			presentation.switchMode(fullscreen);
			expect(ui.mode).toBe(fullscreen ? "fullscreen" : "regular");
			requestRender();
			await vi.waitFor(async () =>
				expect((await terminal.screen()).join("\n")).toContain("Conversation stays attached"),
			);
			terminal.input("x");
			terminal.input("\x1b[?997;2n");
		}
		expect(editor.getText()).toBe("draftxxxx");
		expect(input.mock.calls.flat().filter((value) => value === "x")).toHaveLength(4);
		expect(schemes).toEqual(["light", "light", "light", "light"]);
		removeInput();
		removeColors();
		const count = input.mock.calls.length;
		presentation.switchMode(true);
		terminal.input("z");
		terminal.input("\x1b[?997;1n");
		expect(input).toHaveBeenCalledTimes(count);
		expect(schemes).toHaveLength(4);
		expect(editor.getText()).toBe("draftxxxxz");
	} finally {
		ui.stop({ preserveScreen: true });
		terminal.dispose();
	}
});

test("an open or hidden extension overlay prevents a screen change until its handle is removed", () => {
	const terminal = new TestTerminal();
	const presentation = new InteractiveRenderer(terminal, false);
	const overlay = presentation.ui.showOverlay(new Text("Extension dialog"));
	try {
		expect(() => presentation.switchMode(true)).toThrow("Close terminal overlays");
		overlay.setHidden(true);
		expect(() => presentation.switchMode(true)).toThrow("Close terminal overlays");
		expect(presentation.ui.mode).toBe("regular");
		presentation.ui.hideOverlay();
		presentation.switchMode(true);
		expect(presentation.ui.mode).toBe("fullscreen");
	} finally {
		presentation.ui.stop();
		terminal.dispose();
	}
});
