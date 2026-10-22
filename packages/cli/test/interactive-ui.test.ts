import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels, fauxProvider, fauxAssistantMessage, fauxToolCall, fauxThinking } from "@arc/ai";
import { defineTool } from "@arc/durable";
import { Type } from "typebox";
import { Editor, Input, Text, getKeybindings, type OverlayHandle } from "@arc/tui";
import { afterEach, expect, test, vi } from "vitest";
import { createApplication } from "../src/core/application.ts";
import type { ApplicationExtension, ExtensionContext } from "../src/core/types.ts";
import { createUnavailableUI, type AutocompleteProviderFactory } from "../src/core/ui/ui.ts";
import { runInteractive } from "../src/modes/interactive/interactive-mode.ts";
import { TestTerminal } from "../../tui/test/support/terminal.ts";
import { loginWithUI } from "../src/core/authentication/ui-auth.ts";
import { startOAuthCallbackServer, waitForCallbackOrManualInput } from "../../ai/src/auth/oauth/callback-server.ts";
import * as browser from "../src/core/authentication/browser.ts";
import { userBashEntry } from "../src/core/tools/user-bash.ts";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
	vi.restoreAllMocks();
});

async function start(extensions: readonly ApplicationExtension[] = [], fullscreen = true) {
	const directory = await mkdtemp(join(tmpdir(), "arc-ui-"));
	const models = createModels();
	const provider = fauxProvider({ models: [{ id: "alpha" }] });
	models.setProvider(provider.provider);
	const app = await createApplication({
		cwd: directory,
		home: join(directory, "home"),
		models,
		backend: "memory",
		model: { provider: "faux", modelId: "alpha" },
		resources: { contextFiles: [], skills: [], prompts: [], extensionFiles: [] },
		extensions,
	});
	const terminal = new TestTerminal(110, 32);
	const writes = vi.spyOn(terminal, "write");
	const controller = new AbortController();
	const result = runInteractive(app, { terminal, fullscreen, signal: controller.signal });
	cleanups.push(async () => {
		controller.abort();
		await result;
		await app.close();
		terminal.dispose();
		await rm(directory, { recursive: true, force: true });
	});
	await vi.waitFor(async () => expect((await terminal.screen()).join("\n")).toContain("Enter send"));
	return { app, terminal, controller, result, writes, provider };
}

test("settings toggles Code Mode immediately without enabling MCP", async () => {
	const { app, terminal } = await start();
	terminal.input("/settings");
	terminal.input("\r");
	await vi.waitFor(async () => expect((await terminal.screen()).join("\n")).toContain("Code Mode"));
	terminal.input("Code Mode");
	terminal.input("\r");
	await vi.waitFor(async () => expect((await app.snapshot()).settings?.codemode).toBe(false));
	expect((await app.snapshot()).agent.tools.map((tool) => tool.name)).not.toContain("codemode");
	terminal.input("\r");
	await vi.waitFor(async () => expect((await app.snapshot()).settings?.codemode).toBe(true));
	expect((await app.snapshot()).agent.tools.map((tool) => tool.name)).toContain("codemode");
	expect((await app.command("/mcp")).message).toContain("No MCP servers connected.");
	terminal.input("\x1b");
	await vi.waitFor(async () => expect((await terminal.screen()).join("\n")).toContain("Enter send"));
});

test("assistant Mermaid and LaTeX reach the actual terminal renderer", async () => {
	const { app, terminal, provider } = await start();
	provider.setResponses([
		fauxAssistantMessage("Equation: $x^2 + \\alpha$\n\n```mermaid\nflowchart LR\n Start --> Finish\n```"),
	]);
	await app.run("Show a formula and diagram");
	await vi.waitFor(async () => {
		const text = (await terminal.screen()).join("\n");
		expect(text).toContain("x² + α");
		expect(text).toContain("Start");
		expect(text).toContain("Finish");
		expect(text).not.toContain("flowchart LR");
	});
});

test("automatic compaction can be disabled and enabled from settings and is saved", async () => {
	const { app, terminal } = await start();
	terminal.input("/settings");
	terminal.input("\r");
	await vi.waitFor(async () => expect((await terminal.screen()).join("\n")).toContain("Settings"));
	terminal.input("Automatic compaction");
	terminal.input("\r");
	await vi.waitFor(async () => expect((await app.snapshot()).settings?.compaction?.enabled).toBe(false));
	expect(JSON.parse(await readFile(join(app.home, "settings.json"), "utf8")).compaction.enabled).toBe(false);
	terminal.input("\r");
	await vi.waitFor(async () => expect((await app.snapshot()).settings?.compaction?.enabled).toBe(true));
	expect(JSON.parse(await readFile(join(app.home, "settings.json"), "utf8")).compaction.enabled).toBe(true);
	terminal.input("\x1b");
	await vi.waitFor(async () => expect((await terminal.screen()).join("\n")).toContain("Enter send"));
});

test("retained extension contexts follow current state and terminal attachment", async () => {
	const contexts: ExtensionContext[] = [];
	const { app, provider, controller, result } = await start([
		{
			name: "retained-context",
			activate(context) {
				contexts.push(context);
			},
		},
	]);
	const saved = contexts[0];
	if (!saved) throw new Error("Extension context missing");
	expect(saved.mode).toBe("interactive");
	expect(app.mode).toBe("interactive");
	const before = saved.state.view.entries.length;
	provider.setResponses([fauxAssistantMessage("Updated context answer")]);
	await app.run("Update retained context");
	expect(saved.state.view.entries.length).toBeGreaterThan(before);
	expect(saved.state.view.conversation.id).toBe(app.conversation.id);
	controller.abort();
	await result;
	expect(saved.mode).toBe("sdk");
	expect(saved.ui.supported).toBe(false);
});

test("unavailable UI advertises no capabilities and rejects interaction clearly", async () => {
	const ui = createUnavailableUI();
	expect(ui.supported).toBe(false);
	expect(Object.values(ui.capabilities).every((value) => value === false)).toBe(true);
	await expect(ui.select("Choose", [])).rejects.toThrow("requires interactive mode");
	await expect(ui.confirm("Confirm", "Proceed?")).rejects.toThrow("requires interactive mode");
	await expect(ui.input("Text")).rejects.toThrow("requires interactive mode");
	await expect(ui.custom(() => new Text("Custom"))).rejects.toThrow("requires interactive mode");
	expect(() => ui.getEditorText()).toThrow("requires interactive mode");
	expect(() => ui.setEditorText("draft")).toThrow("requires interactive mode");
	expect(() => ui.notify("message")).toThrow("requires interactive mode");
	expect(() => ui.setStatus("key", "text")).toThrow("requires interactive mode");
	expect(() => ui.setWidget("key", new Text("widget"))).toThrow("requires interactive mode");
	expect(() => ui.setTitle("title")).toThrow("requires interactive mode");
	expect(() => ui.getToolsExpanded()).toThrow("requires interactive mode");
	expect(() => ui.setToolsExpanded(true)).toThrow("requires interactive mode");
	expect(() => ui.setWorkingMessage("busy")).toThrow("requires interactive mode");
	expect(() => ui.setWorkingVisible(false)).toThrow("requires interactive mode");
	expect(() => ui.setWorkingIndicator()).toThrow("requires interactive mode");
	expect(() => ui.setHiddenThinkingLabel()).toThrow("requires interactive mode");
	expect(() => ui.addAutocompleteProvider((current) => current)).toThrow("requires interactive mode");
});

test("terminal bang commands execute and render without a model request", async () => {
	const { app, terminal, provider } = await start();
	for (const [command, output] of [
		["!printf terminal-shell", "terminal-shell"],
		["!!printf private-shell", "private-shell"],
	]) {
		terminal.input(command);
		terminal.input("\r");
		await vi.waitFor(async () =>
			expect((await app.snapshot()).view.entries.some((entry) => userBashEntry(entry)?.result.output === output)).toBe(
				true,
			),
		);
		await vi.waitFor(async () => expect((await terminal.screen()).join("\n")).toContain(output));
	}
	expect(provider.state.callCount).toBe(0);
	const messages = JSON.stringify((await app.conversation.context(app.context)).messages);
	expect(messages).toContain("terminal-shell");
	expect(messages).not.toContain("private-shell");
	terminal.input("!printf shell-running; sleep 30");
	terminal.input("\r");
	await vi.waitFor(async () => expect((await terminal.screen()).join("\n")).toContain("[running]"));
	terminal.input("\x03");
	await vi.waitFor(async () => expect((await terminal.screen()).join("\n")).toContain("[cancelled]"));
	expect(provider.state.callCount).toBe(0);
});

test("extension dialogs dismiss on cancellation, preserve drafts and remove their abort listeners", async () => {
	const { app, terminal } = await start();
	app.ui.setEditorText("preserved draft");
	for (const kind of ["select", "confirm", "input"] as const) {
		const controller = new AbortController();
		const remove = vi.spyOn(controller.signal, "removeEventListener");
		const options = { signal: controller.signal };
		const result =
			kind === "select"
				? app.ui.select("Cancellable choice", [{ value: "yes", label: "Yes" }], options)
				: kind === "confirm"
					? app.ui.confirm("Cancellable choice", "Continue?", options)
					: app.ui.input("Cancellable choice", "", options);
		await vi.waitFor(async () => expect((await terminal.screen()).join("\n")).toContain("Cancellable choice"));
		controller.abort();
		await expect(result).resolves.toBe(kind === "confirm" ? false : undefined);
		expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
		await vi.waitFor(async () => expect((await terminal.screen()).join("\n")).not.toContain("Cancellable choice"));
		expect(app.ui.getEditorText()).toBe("preserved draft");
	}
	const controller = new AbortController();
	controller.abort();
	await expect(app.ui.input("Already cancelled", "", { signal: controller.signal })).resolves.toBeUndefined();
	expect((await terminal.screen()).join("\n")).not.toContain("Already cancelled");
});

test("extension dialogs count down, expire and cancel only their own stacked dialog", async () => {
	const { app, terminal } = await start();
	const lower = new AbortController();
	const pending = app.ui.input("Lower prompt", "", { signal: lower.signal });
	const result = app.ui.select("Timed choice", [{ value: "yes", label: "Yes" }], { timeout: 1 });
	await vi.waitFor(async () => expect((await terminal.screen()).join("\n")).toContain("Timed choice (1s)"));
	await expect(result).resolves.toBeUndefined();
	await vi.waitFor(async () => expect((await terminal.screen()).join("\n")).toContain("Lower prompt"));
	lower.abort();
	await pending;
	const controller = new AbortController();
	const remove = vi.spyOn(controller.signal, "removeEventListener");
	const selected = app.ui.confirm("Choose normally", "Continue?", { signal: controller.signal, timeout: 3000 });
	await vi.waitFor(async () => expect((await terminal.screen()).join("\n")).toContain("Choose normally"));
	terminal.input("\r");
	await expect(selected).resolves.toBe(true);
	expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
	controller.abort();
	expect(app.ui.getEditorText()).toBe("");
});

test("custom UI and editor factories receive the live terminal, theme and keybindings", async () => {
	const { app, terminal } = await start();
	const bindings = getKeybindings();
	app.ui.setEditorComponent((tui, theme, keybindings) => {
		expect(tui.terminal).toBe(terminal);
		expect(keybindings).toBe(bindings);
		return new Editor(tui, theme);
	});
	const result = app.ui.custom<string>((tui, theme, keybindings, done) => {
		expect(tui.terminal).toBe(terminal);
		expect(theme).toBe(app.ui.theme);
		expect(keybindings).toBe(bindings);
		const input = new Input({ prompt: "CUSTOM CALLBACK " });
		input.onSubmit = done;
		return input;
	});
	await vi.waitFor(async () => expect((await terminal.screen()).join("\n")).toContain("CUSTOM CALLBACK"));
	terminal.input("accepted");
	terminal.input("\r");
	await expect(result).resolves.toBe("accepted");
});

test("aborting login dismisses its credential prompt without closing the terminal", async () => {
	const { app, terminal } = await start();
	const base = app.models.getProvider("faux");
	if (!base || !("setProvider" in app.models) || typeof app.models.setProvider !== "function")
		throw new Error("Missing mutable provider registry");
	app.models.setProvider({
		...base,
		auth: {
			apiKey: {
				name: "Fixture login",
				async login(interaction: import("@arc/ai").ProviderAuthInteraction) {
					await interaction.prompt({ type: "secret", message: "Cancellable credential" });
					interaction.signal.throwIfAborted();
					return { type: "api_key", key: "unused" };
				},
			},
		},
	});
	const controller = new AbortController();
	const result = loginWithUI(app.models, app.ui, "faux", controller.signal);
	const rejected = expect(result).rejects.toBeDefined();
	await vi.waitFor(async () => expect((await terminal.screen()).join("\n")).toContain("Cancellable credential"));
	controller.abort();
	await rejected;
	await vi.waitFor(async () => expect((await terminal.screen()).join("\n")).not.toContain("Cancellable credential"));
	expect(app.ui.supported).toBe(true);
	app.ui.setEditorText("still usable");
	expect(app.ui.getEditorText()).toBe("still usable");
});

test("autocomplete layers retain triggers, survive editor and base changes, and can be removed independently", async () => {
	const { app, terminal, controller, result } = await start();
	const factory =
		(trigger: string, label: string): AutocompleteProviderFactory =>
		(current) => ({
			triggerCharacters: [trigger],
			async getSuggestions(lines, line, column, options) {
				const prefix = lines[line]?.slice(0, column) ?? "";
				return prefix.startsWith(trigger)
					? { items: [{ value: `${label}-value`, label }], prefix }
					: current.getSuggestions(lines, line, column, options);
			},
			applyCompletion: (...args) => current.applyCompletion(...args),
		});
	const removeFirst = app.ui.addAutocompleteProvider(factory("%", "Resource Alpha"));
	const removeSecond = app.ui.addAutocompleteProvider(factory("&", "Resource Beta"));
	expect(() =>
		app.ui.addAutocompleteProvider(() => {
			throw new Error("Invalid wrapper");
		}),
	).toThrow("Invalid wrapper");
	app.ui.setEditorComponent((tui, theme) => new Editor(tui, theme));
	terminal.input("%a");
	await vi.waitFor(async () => expect((await terminal.screen()).join("\n")).toContain("Resource Alpha"));
	terminal.input("\t");
	await vi.waitFor(() => expect(app.ui.getEditorText()).toContain("Resource Alpha-value"));
	app.ui.setEditorText("");
	terminal.input("/name autocomplete-check");
	terminal.input("\r");
	await vi.waitFor(async () =>
		expect((await terminal.screen()).join("\n")).toContain("Session name: autocomplete-check"),
	);
	terminal.input("&a");
	await vi.waitFor(async () => expect((await terminal.screen()).join("\n")).toContain("Resource Beta"));
	terminal.input("\x1b");
	removeFirst();
	removeFirst();
	app.ui.setEditorText("");
	terminal.input("%a");
	await terminal.screen();
	expect((await terminal.screen()).join("\n")).not.toContain("Resource Alpha");
	app.ui.setEditorText("");
	terminal.input("&a");
	await vi.waitFor(async () => expect((await terminal.screen()).join("\n")).toContain("Resource Beta"));
	terminal.input("\x1b");
	removeSecond();
	app.ui.setEditorText("");
	terminal.input("/hel");
	await vi.waitFor(async () => expect((await terminal.screen()).join("\n")).toContain("/help"));
	controller.abort();
	await result;
	expect(removeSecond).not.toThrow();
});

test("positioned extension overlays retain drafts, expose handles and release the correct stacked component", async () => {
	const { app, terminal } = await start();
	app.ui.setEditorText("overlay draft");
	const firstDone = Promise.withResolvers<(value: string) => void>();
	const firstHandle = Promise.withResolvers<OverlayHandle>();
	const secondHandle = Promise.withResolvers<OverlayHandle>();
	const disposed: string[] = [];
	const first = app.ui.custom<string>(
		(_tui, _theme, _keybindings, done) => {
			firstDone.resolve(done);
			return new (class extends Input {
				dispose() {
					disposed.push("first");
				}
			})({ prompt: "FIRST OVERLAY " });
		},
		{ overlay: true, overlayOptions: () => ({ width: 40, row: 5, col: 3 }), onHandle: firstHandle.resolve },
	);
	const firstControl = await firstHandle.promise;
	await vi.waitFor(async () => expect((await terminal.screen()).join("\n")).toContain("FIRST OVERLAY"));
	expect(firstControl.getBounds()).toMatchObject({ width: 40, row: 5, col: 3 });
	firstControl.setHidden(true);
	await vi.waitFor(async () => expect((await terminal.screen()).join("\n")).not.toContain("FIRST OVERLAY"));
	expect(firstControl.isHidden()).toBe(true);
	firstControl.setHidden(false);
	const second = app.ui.custom<string>(
		() =>
			new (class extends Input {
				dispose() {
					disposed.push("second");
				}
			})({ prompt: "SECOND OVERLAY " }),
		{ overlay: true, overlayOptions: { width: 45, row: 9 }, onHandle: secondHandle.resolve },
	);
	const rejected = expect(second).rejects.toMatchObject({ name: "AbortError" });
	const secondControl = await secondHandle.promise;
	await vi.waitFor(async () => expect((await terminal.screen()).join("\n")).toContain("SECOND OVERLAY"));
	(await firstDone.promise)("first completed");
	await expect(first).resolves.toBe("first completed");
	expect(secondControl.isFocused()).toBe(true);
	expect(disposed).toEqual(["first"]);
	expect((await terminal.screen()).join("\n")).toContain("SECOND OVERLAY");
	terminal.input("\x1b");
	await rejected;
	expect(disposed).toEqual(["first", "second"]);
	expect(app.ui.getEditorText()).toBe("overlay draft");
	await expect(
		app.ui.custom(
			() =>
				new (class extends Text {
					dispose() {
						disposed.push("failed");
					}
				})("FAILED OVERLAY"),
			{
				overlay: true,
				onHandle() {
					throw new Error("Handle setup failed");
				},
			},
		),
	).rejects.toThrow("Handle setup failed");
	expect(disposed).toEqual(["first", "second", "failed"]);
	expect((await terminal.screen()).join("\n")).not.toContain("FAILED OVERLAY");
});

test("working controls update live output and hidden-thinking labels without interrupting the task", async () => {
	const gate = Promise.withResolvers<void>();
	const tool = defineTool({
		name: "hold_work",
		description: "Wait for test release",
		parameters: Type.Object({}),
		async execute() {
			await gate.promise;
			return { output: [{ type: "text", text: "Work released" }] };
		},
	});
	const { app, terminal, provider } = await start([{ name: "working-controls", tools: [tool] }]);
	provider.setResponses([
		fauxAssistantMessage([fauxThinking("Unshown reasoning"), fauxToolCall("hold_work", {})], { stopReason: "toolUse" }),
		fauxAssistantMessage("Working controls finished"),
	]);
	app.ui.setHiddenThinkingLabel("Reasoning collapsed");
	app.ui.setWorkingMessage("Indexing workspace");
	app.ui.setWorkingIndicator({ frames: ["CUSTOM-INDICATOR"] });
	terminal.input("Start controlled work");
	terminal.input("\r");
	try {
		await vi.waitFor(async () => {
			const text = (await terminal.screen()).join("\n");
			expect(text).toContain("CUSTOM-INDICATOR Indexing workspace");
			expect(text).toContain("Reasoning collapsed");
			expect(text).not.toContain("Unshown reasoning");
		});
		app.ui.setWorkingVisible(false);
		await vi.waitFor(async () => expect((await terminal.screen()).join("\n")).not.toContain("Indexing workspace"));
		expect((await app.snapshot()).busy).toBe(true);
		app.ui.setWorkingVisible(true);
		app.ui.setWorkingIndicator({ frames: [] });
		await vi.waitFor(async () => {
			const text = (await terminal.screen()).join("\n");
			expect(text).toContain("Indexing workspace");
			expect(text).not.toContain("CUSTOM-INDICATOR");
		});
		app.ui.setWorkingMessage();
		app.ui.setWorkingIndicator();
		app.ui.setHiddenThinkingLabel();
		await vi.waitFor(async () => {
			const text = (await terminal.screen()).join("\n");
			expect(text).toContain("Running tools");
			expect(text).toContain("Thinking...");
			expect(text).not.toContain("Indexing workspace");
		});
	} finally {
		gate.resolve();
	}
	await vi.waitFor(async () => expect((await terminal.screen()).join("\n")).toContain("Working controls finished"));
	expect((await terminal.screen()).join("\n")).not.toContain("Running tools");
});

test("extensions and the keyboard share tool expansion without changing the editor draft", async () => {
	const { app, terminal, provider, controller, result } = await start();
	provider.setResponses([
		fauxAssistantMessage(
			fauxToolCall("bash", {
				command: "printf '%s-row\\n' first second third fourth fifth sixth",
			}),
			{ stopReason: "toolUse" },
		),
		fauxAssistantMessage("Expansion run finished"),
	]);
	terminal.input("Run output");
	terminal.input("\r");
	await vi.waitFor(async () => expect((await terminal.screen()).join("\n")).toContain("Expansion run finished"));
	app.ui.setEditorText("retained draft");
	expect(app.ui.getToolsExpanded()).toBe(false);
	expect((await terminal.screen()).join("\n")).not.toContain("first-row");
	app.ui.setToolsExpanded(true);
	await vi.waitFor(async () => expect((await terminal.screen()).join("\n")).toContain("first-row"));
	expect(app.ui.getToolsExpanded()).toBe(true);
	terminal.input("\x0f");
	await vi.waitFor(async () => expect((await terminal.screen()).join("\n")).not.toContain("first-row"));
	expect(app.ui.getToolsExpanded()).toBe(false);
	expect(app.ui.getEditorText()).toBe("retained draft");
	const ui = app.ui;
	controller.abort();
	await result;
	expect(() => ui.getToolsExpanded()).toThrow("closed");
	expect(() => ui.setToolsExpanded(true)).toThrow("closed");
});

test.each([false, true])(
	"thinking and tool expansion stay toggled after key repeat and release (fullscreen=%s)",
	async (fullscreen) => {
		const { app, terminal, provider } = await start([], fullscreen);
		provider.setResponses([
			fauxAssistantMessage(
				[
					fauxThinking("Retained reasoning"),
					fauxToolCall("bash", { command: "printf '%s-row\\n' first second third fourth fifth sixth" }),
				],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("Toggle run finished"),
		]);
		await app.run("Show reasoning and output");
		await vi.waitFor(async () => expect((await terminal.screen()).join("\n")).toContain("Toggle run finished"));
		app.ui.setEditorText("retained draft");

		for (const [code, content] of [
			[116, "Retained reasoning"],
			[111, "first-row"],
		] as const) {
			expect((await terminal.screen()).join("\n")).not.toContain(content);
			terminal.input(`\x1b[${code};5u`);
			await vi.waitFor(async () => expect((await terminal.screen()).join("\n")).toContain(content));
			for (const event of [2, 3]) {
				terminal.input(`\x1b[${code};5:${event}u`);
				app.ui.setStatus("refresh", `event ${event}`);
				await vi.waitFor(async () => expect((await terminal.screen()).join("\n")).toContain(`event ${event}`));
				expect((await terminal.screen()).join("\n")).toContain(content);
			}
			terminal.input(`\x1b[${code};5u`);
			await vi.waitFor(async () => expect((await terminal.screen()).join("\n")).not.toContain(content));
			terminal.input(`\x1b[${code};5:3u`);
			app.ui.setStatus("refresh", "released again");
			await vi.waitFor(async () => expect((await terminal.screen()).join("\n")).toContain("released again"));
			expect((await terminal.screen()).join("\n")).not.toContain(content);
		}
		expect(app.ui.getToolsExpanded()).toBe(false);
		expect(app.ui.getEditorText()).toBe("retained draft");
	},
);

test("theme-aware header, footer and widgets replace and dispose their owned components without losing drafts", async () => {
	const { app, terminal, controller, result } = await start();
	const disposed: string[] = [];
	const component = (label: string) =>
		new (class extends Text {
			dispose() {
				disposed.push(label);
			}
		})(label, 1, 0);
	app.ui.setEditorText("kept draft");
	app.ui.setStatus("extension", "ready");
	app.ui.setHeader((_tui, theme) => component(`Header ${theme.name}`));
	app.ui.setFooter((_tui, theme, data) =>
		component(
			`Footer ${theme.name} ${data.getState().agent.model?.modelId} ${data.getExtensionStatuses().get("extension")}`,
		),
	);
	app.ui.setWidget("above", (_tui, theme) => component(`Above ${theme.name}`));
	app.ui.setWidget("below", ["Below editor"], { placement: "belowEditor" });
	expect(app.ui.getAllThemes().map((theme) => theme.name)).toEqual(["system", "light", "dark"]);
	expect(app.ui.getTheme("missing")).toBeUndefined();
	expect(app.ui.setTheme("light")).toEqual({ success: true });
	await vi.waitFor(async () => {
		const text = (await terminal.screen()).join("\n");
		expect(text).toContain("Header light");
		expect(text).toContain("Footer light alpha ready");
		expect(text.indexOf("Above light")).toBeLessThan(text.indexOf("kept draft"));
		expect(text.indexOf("Below editor")).toBeGreaterThan(text.indexOf("kept draft"));
	});
	expect(disposed).toEqual(expect.arrayContaining(["Header system", "Footer system alpha ready", "Above system"]));
	expect(app.ui.setTheme("unknown").success).toBe(false);
	expect(app.ui.theme.name).toBe("light");
	expect(() =>
		app.ui.setHeader(() => {
			throw new Error("factory failed");
		}),
	).toThrow("factory failed");
	expect((await terminal.screen()).join("\n")).toContain("Header light");
	const remove = app.ui.onTerminalInput((data) => (data === "x" ? { consume: true } : undefined));
	await app.command("/settings fullscreen false");
	await vi.waitFor(() => expect(terminal.emulator.buffer.active.type).toBe("normal"));
	terminal.input("x");
	expect(app.ui.getEditorText()).toBe("kept draft");
	remove();
	terminal.input("x");
	expect(app.ui.getEditorText()).toBe("kept draftx");
	controller.abort();
	await result;
	expect(disposed.filter((label) => label === "Header light")).toHaveLength(1);
	expect(disposed.filter((label) => label === "Footer light alpha ready")).toHaveLength(1);
	expect(disposed.filter((label) => label === "Above light")).toHaveLength(1);
});

test("active theme files reload after saves and invalid replacements keep the last valid theme and editable draft", async () => {
	const { app, terminal } = await start();
	const path = join(app.home, "themes", "custom.json");
	await mkdir(join(app.home, "themes"), { recursive: true });
	const original = app.ui.getTheme("dark");
	if (!original) throw new Error("Missing built-in theme");
	const definition = { ...structuredClone(original.definition), name: "custom" };
	await writeFile(path, JSON.stringify(definition));
	await app.reload();
	expect(app.ui.setTheme("custom")).toEqual({ success: true });
	app.ui.setEditorText("theme draft");
	const first = app.ui.theme;
	definition.colors.accent = "#f03";
	await writeFile(path, JSON.stringify(definition));
	await vi.waitFor(() => expect(app.ui.theme).not.toBe(first));
	const valid = app.ui.theme;
	await writeFile(path, "{invalid");
	await vi.waitFor(async () => expect((await terminal.screen()).join("\n")).toContain("Invalid JSON"));
	expect(app.ui.theme).toBe(valid);
	expect(app.ui.getEditorText()).toBe("theme draft");
	await writeFile(path, JSON.stringify(definition));
	await vi.waitFor(() => expect(app.ui.theme).not.toBe(valid));
	app.ui.setTheme("light/dark");
	terminal.input("\x1b[?997;2n");
	await vi.waitFor(() => expect(app.ui.theme.name).toBe("light"));
	terminal.input("\x1b[?997;1n");
	await vi.waitFor(() => expect(app.ui.theme.name).toBe("dark"));
	expect(app.ui.getEditorText()).toBe("theme draft");
});

test.each([false, true])("extension commands can await a real selector in fullscreen=%s", async (fullscreen) => {
	const choices: string[] = [];
	const extension: ApplicationExtension = {
		name: "ui-command",
		commands: [
			{
				name: "choose-task",
				description: "Choose a task",
				async execute(args, app) {
					const choice = await app.ui.select("Extension task", [
						{ value: "first", label: "First task" },
						{ value: "second", label: "Second task" },
					]);
					choices.push(`${args}:${choice}`);
					return { message: `Selected ${choice}` };
				},
			},
		],
	};
	const { app, terminal } = await start([extension], fullscreen);
	expect(app.ui.supported).toBe(true);
	expect(Object.values(app.ui.capabilities).every((value) => value === true)).toBe(true);
	terminal.input("/choose-task payload");
	terminal.input("\r");
	await vi.waitFor(async () => expect((await terminal.screen()).join("\n")).toContain("Extension task"));
	terminal.input("\x1b[B");
	terminal.input("\r");
	await vi.waitFor(() => expect(choices).toEqual(["payload:second"]));
	await vi.waitFor(async () => expect((await terminal.screen()).join("\n")).toContain("Selected second"));
});

test("concurrent input and confirmation dialogs restore earlier pending selectors and the draft", async () => {
	const { app, terminal } = await start();
	app.ui.setEditorText("preserved draft");
	const first = app.ui.select("Earlier selector", [
		{ value: "one", label: "One" },
		{ value: "two", label: "Two" },
	]);
	const second = app.ui.input("Newer text prompt", "initial");
	const third = app.ui.confirm("Newest confirmation", "Continue with this operation?");
	await vi.waitFor(async () => expect((await terminal.screen()).join("\n")).toContain("Newest confirmation"));
	terminal.input("\x1b");
	await expect(third).resolves.toBe(false);
	await vi.waitFor(async () => expect((await terminal.screen()).join("\n")).toContain("Newer text prompt"));
	terminal.input(" edited");
	terminal.input("\r");
	await expect(second).resolves.toBe("initial edited");
	await vi.waitFor(async () => expect((await terminal.screen()).join("\n")).toContain("Earlier selector"));
	terminal.input("\x1b[B");
	terminal.input("\r");
	await expect(first).resolves.toBe("two");
	expect(app.ui.getEditorText()).toBe("preserved draft");
	await vi.waitFor(async () => expect((await terminal.screen()).join("\n")).toContain("preserved draft"));
	const confirmation = app.ui.confirm("Approve", "Choose yes");
	terminal.input("\r");
	await expect(confirmation).resolves.toBe(true);
});

test("custom components can open nested dialogs during construction and return typed results", async () => {
	const { app, terminal } = await start();
	let nested = Promise.resolve<string | undefined>(undefined);
	const custom = app.ui.custom<string>((_tui, _theme, _keybindings, done) => {
		nested = app.ui.input("Nested input", "nested value");
		const input = new Input({ prompt: "custom> " });
		input.onSubmit = done;
		return input;
	});
	await vi.waitFor(async () => expect((await terminal.screen()).join("\n")).toContain("Nested input"));
	terminal.input("\r");
	await expect(nested).resolves.toBe("nested value");
	await vi.waitFor(async () => expect((await terminal.screen()).join("\n")).toContain("custom>"));
	terminal.input("custom result");
	terminal.input("\r");
	await expect(custom).resolves.toBe("custom result");
	await expect(
		app.ui.custom<number>((_tui, _theme, _keybindings, done) => {
			done(42);
			return new Text("Completed synchronously");
		}),
	).resolves.toBe(42);
	await expect(
		app.ui.custom(() => {
			throw new Error("Factory failure");
		}),
	).rejects.toThrow("Factory failure");
	app.ui.setEditorText("editor remains usable");
	await vi.waitFor(async () => expect((await terminal.screen()).join("\n")).toContain("editor remains usable"));
});

test("notifications, keyed statuses and widgets, editor text, and sanitized titles reach the terminal", async () => {
	const { app, terminal, controller, result, writes } = await start();
	const titles: string[] = [];
	terminal.emulator.onTitleChange((title) => titles.push(title));
	app.ui.setStatus("first", "Status one");
	app.ui.setStatus("second", "Status two");
	app.ui.setWidget("first", new Text("Widget one", 1, 0));
	app.ui.setWidget("second", new Text("Widget two", 1, 0));
	app.ui.setEditorText("first draft\nsecond draft");
	app.ui.notify("Extension notification", "error");
	app.ui.setTitle("\x1b]0;untrusted\x07Extension\nTitle");
	await vi.waitFor(async () => {
		const text = (await terminal.screen()).join("\n");
		for (const expected of [
			"Status one",
			"Status two",
			"Widget one",
			"Widget two",
			"first draft",
			"second draft",
			"Extension notification",
		])
			expect(text).toContain(expected);
	});
	expect(titles).toContain("Extension Title");
	expect(titles).not.toContain("untrusted");
	expect(app.ui.getEditorText()).toBe("first draft\nsecond draft");
	app.ui.setEditorText("sanitized\x1b]0;editor-title-injection\x07 draft");
	expect(app.ui.getEditorText()).toBe("sanitized draft");
	await terminal.screen();
	expect(titles).not.toContain("editor-title-injection");
	app.ui.setStatus("first", "Status replaced");
	app.ui.setStatus("second");
	app.ui.setWidget("first", new Text("Widget replaced", 1, 0));
	app.ui.setWidget("second");
	await vi.waitFor(async () => {
		const text = (await terminal.screen()).join("\n");
		expect(text).toContain("Status replaced");
		expect(text).toContain("Widget replaced");
		for (const removed of ["Status one", "Status two", "Widget one", "Widget two"]) expect(text).not.toContain(removed);
	});
	controller.abort();
	await result;
	expect(writes.mock.calls.some(([data]) => data.includes("\x1b[22;0t"))).toBe(true);
	expect(writes.mock.calls.some(([data]) => data.includes("\x1b[23;0t"))).toBe(true);
});

test("exit settles every stacked dialog and detaches the UI, while custom cancellation rejects honestly", async () => {
	const { app, terminal, controller, result } = await start();
	const ui = app.ui;
	const selection = ui.select("Pending selector", [{ value: "one", label: "One" }]);
	const input = ui.input("Pending input");
	const confirmation = ui.confirm("Pending confirmation", "Confirm?");
	const custom = ui.custom<number>(() => new Input());
	const rejected = expect(custom).rejects.toMatchObject({ name: "AbortError" });
	controller.abort();
	await result;
	await expect(selection).resolves.toBeUndefined();
	await expect(input).resolves.toBeUndefined();
	await expect(confirmation).resolves.toBe(false);
	await rejected;
	expect(app.ui.supported).toBe(false);
	expect(ui.supported).toBe(false);
	expect(() => ui.setEditorText("closed")).toThrow("closed");
	await expect(ui.input("closed")).rejects.toThrow("closed");
	terminal.input("unhandled input after shutdown");
});

test("subscription failure and partial terminal startup both detach the UI and restore terminal ownership", async () => {
	const { app, controller, result } = await start();
	controller.abort();
	await result;
	const terminal = new TestTerminal();
	const initialStart = vi.spyOn(terminal, "start");
	vi.spyOn(app, "subscribe").mockImplementationOnce(() => {
		throw new Error("Subscription failure");
	});
	await expect(runInteractive(app, { terminal })).rejects.toThrow("Subscription failure");
	expect(initialStart).not.toHaveBeenCalled();
	expect(app.ui.supported).toBe(false);
	const actualStart = terminal.start.bind(terminal);
	initialStart.mockImplementationOnce((input, resize) => {
		actualStart(input, resize);
		throw new Error("Partial startup failure");
	});
	const stop = vi.spyOn(terminal, "stop");
	await expect(runInteractive(app, { terminal })).rejects.toThrow("Partial startup failure");
	expect(stop).toHaveBeenCalledOnce();
	expect(app.ui.supported).toBe(false);
	terminal.dispose();
});

test("secret dialogs never render entered credentials", async () => {
	const { app, terminal, writes } = await start();
	const answer = app.ui.input("API credential", "", { secret: true });
	terminal.input("local-secret-123");
	await vi.waitFor(async () => expect((await terminal.screen()).join("\n")).toContain("****************"));
	expect(writes.mock.calls.flat().join("")).not.toContain("local-secret-123");
	terminal.input("\r");
	expect(await answer).toBe("local-secret-123");
});

test("login uses the model authentication API and masks its secret prompt", async () => {
	const { app, terminal, writes } = await start();
	const original = app.models.getProvider("faux");
	if (!original || !("setProvider" in app.models) || typeof app.models.setProvider !== "function")
		throw new Error("Missing fixture provider");
	app.models.setProvider({
		...original,
		auth: {
			apiKey: {
				name: "Fixture key",
				async login(interaction: import("@arc/ai").ProviderAuthInteraction) {
					return { type: "api_key", key: await interaction.prompt({ type: "secret", message: "Fixture credential" }) };
				},
				async resolve({ credential }: { credential?: import("@arc/ai").ApiKeyCredential }) {
					return credential?.key;
				},
			},
		},
	});
	terminal.input("/login faux");
	terminal.input("\r");
	await vi.waitFor(async () => expect((await terminal.screen()).join("\n")).toContain("Fixture credential"));
	terminal.input("unique-test-key");
	terminal.input("\r");
	await vi.waitFor(async () => expect((await terminal.screen()).join("\n")).toContain("Select model"));
	terminal.input("\x1b");
	await vi.waitFor(async () => expect((await terminal.screen()).join("\n")).toContain("Signed in to faux"));
	expect(writes.mock.calls.flat().join("")).not.toContain("unique-test-key");
	expect(await app.models.checkAuth("faux")).toBeDefined();
});

test("scope selector supports filtering, toggling and saving through terminal input", async () => {
	const { app, terminal } = await start();
	terminal.input("/scoped-models");
	terminal.input("\r");
	await vi.waitFor(async () => expect((await terminal.screen()).join("\n")).toContain("Models for cycling"));
	terminal.input(" ");
	terminal.input("\x13");
	await vi.waitFor(async () => expect((await app.snapshot()).enabledModels).toEqual([]));
	await vi.waitFor(async () =>
		expect((await terminal.screen()).join("\n")).toContain("Cycling uses all available models"),
	);
});

test("branch selection switches conversations and Escape leaves selection unchanged", async () => {
	const { app, terminal } = await start();
	const first = app.conversation.id;
	await app.command("/new");
	const second = app.conversation.id;
	terminal.input("/tree");
	terminal.input("\r");
	await vi.waitFor(async () => expect((await terminal.screen()).join("\n")).toContain("Session Tree"));
	terminal.input(String(first));
	terminal.input("\r");
	await vi.waitFor(async () => expect((await terminal.screen()).join("\n")).toContain("Summarize branch?"));
	terminal.input("\r");
	await vi.waitFor(() => expect(app.conversation.id).toBe(first));
	terminal.input("/tree");
	terminal.input("\r");
	await vi.waitFor(async () => expect((await terminal.screen()).join("\n")).toContain("Session Tree"));
	terminal.input("\x1b");
	await vi.waitFor(async () => expect((await terminal.screen()).join("\n")).toContain("Enter send"));
	expect(app.conversation.id).toBe(first);
	expect(first).not.toBe(second);
});

test("the session tree starts at the active leaf and selecting a historical user restores an editable draft", async () => {
	const { app, terminal, provider } = await start();
	provider.setResponses([
		fauxAssistantMessage("Navigation first answer"),
		fauxAssistantMessage("Navigation second answer"),
	]);
	await app.run("Navigation first question");
	await app.run("Navigation second question");
	const root = app.conversation.id;
	terminal.input("/tree");
	terminal.input("\r");
	await vi.waitFor(async () => expect((await terminal.screen()).join("\n")).toContain("Session Tree"));
	terminal.input("\r");
	await vi.waitFor(async () => expect((await terminal.screen()).join("\n")).toContain("Already at this point"));
	expect(app.conversation.id).toBe(root);
	terminal.input("/tree");
	terminal.input("\r");
	await vi.waitFor(async () => expect((await terminal.screen()).join("\n")).toContain("Session Tree"));
	terminal.input("Navigation first question");
	terminal.input("\r");
	await vi.waitFor(async () => expect((await terminal.screen()).join("\n")).toContain("Summarize branch?"));
	terminal.input("\r");
	await vi.waitFor(() => expect(app.ui.getEditorText()).toBe("Navigation first question"));
	expect(app.conversation.id).not.toBe(root);
	expect(
		(await app.snapshot()).view.entries
			.flatMap((entry) => entry.model ?? [])
			.filter((message) => message.role === "user"),
	).toEqual([]);
	expect(provider.state.callCount).toBe(2);
});

test("tree label editing, persistent filters and Escape search reset run through the terminal", async () => {
	const { app, terminal, provider } = await start();
	provider.setResponses([fauxAssistantMessage("Entry to bookmark")]);
	await app.run("Bookmark question");
	const entry = (await app.snapshot()).view.entries.at(-1);
	if (!entry) throw new Error("Missing entry");
	terminal.input("/tree");
	terminal.input("\r");
	await vi.waitFor(async () => expect((await terminal.screen()).join("\n")).toContain("Session Tree"));
	terminal.input("L");
	await vi.waitFor(async () => expect((await terminal.screen()).join("\n")).toContain("Label (empty to remove):"));
	terminal.input("checkpoint");
	terminal.input("\r");
	await vi.waitFor(async () => expect(await app.getLabel(entry.id)).toBe("checkpoint"));
	await vi.waitFor(async () => expect((await terminal.screen()).join("\n")).toContain("[checkpoint]"));
	terminal.input("\x0c");
	await vi.waitFor(async () => expect((await terminal.screen()).join("\n")).toContain("[labeled]"));
	terminal.input("not-found");
	await vi.waitFor(async () => expect((await terminal.screen()).join("\n")).toContain("No entries found"));
	terminal.input("\x1b");
	await vi.waitFor(async () => expect((await terminal.screen()).join("\n")).toContain("[checkpoint]"));
	terminal.input("\x1b");
	await vi.waitFor(async () => expect((await terminal.screen()).join("\n")).not.toContain("Session Tree"));
	terminal.input("/tree");
	terminal.input("\r");
	await vi.waitFor(async () => expect((await terminal.screen()).join("\n")).toContain("[labeled]"));
	terminal.input("\x1b");
});

test("cancelling a pending login aborts provider work and restores the editor", async () => {
	const open = vi.spyOn(browser, "openBrowser").mockResolvedValue(true);
	const { app, terminal } = await start();
	const original = app.models.getProvider("faux");
	if (!original || !("setProvider" in app.models) || typeof app.models.setProvider !== "function")
		throw new Error("Missing fixture provider");
	let aborted = false;
	app.models.setProvider({
		...original,
		auth: {
			apiKey: {
				name: "Fixture login",
				async login(interaction: import("@arc/ai").ProviderAuthInteraction) {
					interaction.notify({
						type: "auth_url",
						url: "https://example.invalid/login",
						instructions: "Awaiting authorization",
					});
					await new Promise<void>((_resolve, reject) => {
						interaction.signal.addEventListener(
							"abort",
							() => {
								aborted = true;
								reject(interaction.signal.reason);
							},
							{ once: true },
						);
					});
					return { type: "api_key", key: "never-reached" };
				},
			},
		},
	});
	terminal.input("/login faux");
	terminal.input("\r");
	await vi.waitFor(async () => expect((await terminal.screen()).join("\n")).toContain("Awaiting authorization"));
	expect(open).toHaveBeenCalledWith("https://example.invalid/login");
	terminal.input("\x1b");
	await vi.waitFor(() => expect(aborted).toBe(true));
	await vi.waitFor(async () => expect((await terminal.screen()).join("\n")).toContain("Enter send"));
	await app.command("/new");
	expect((await app.snapshot()).busy).toBe(false);
});

test("replacement editors preserve drafts, commands and submission, then dispose on reset", async () => {
	const { app, terminal } = await start();
	const { Editor } = await import("@arc/tui");
	let disposed = 0;
	class ProjectEditor extends Editor {
		override render(width: number): string[] {
			return ["PROJECT EDITOR", ...super.render(width)];
		}
		dispose(): void {
			disposed++;
		}
	}
	app.ui.setEditorText("/name editor-session");
	const factory: import("../src/core/ui/ui.ts").EditorFactory = (tui, theme) => new ProjectEditor(tui, theme);
	app.ui.setEditorComponent(factory);
	expect(app.ui.getEditorComponent()).toBe(factory);
	await vi.waitFor(async () => expect((await terminal.screen()).join("\n")).toContain("PROJECT EDITOR"));
	expect(app.ui.getEditorText()).toBe("/name editor-session");
	terminal.input("\r");
	await vi.waitFor(async () => expect((await terminal.screen()).join("\n")).toContain("Session name: editor-session"));
	app.ui.setEditorText("kept draft");
	app.ui.setEditorComponent(undefined);
	expect(app.ui.getEditorText()).toBe("kept draft");
	expect(disposed).toBe(1);
	expect(app.ui.getEditorComponent()).toBeUndefined();
});

test("failed editor setup keeps the active draft and releases the failed replacement", async () => {
	const { app } = await start();
	const { Editor } = await import("@arc/tui");
	let disposed = false;
	class BrokenEditor extends Editor {
		override setText(): void {
			throw new Error("Fixture setup failed");
		}
		dispose(): void {
			disposed = true;
		}
	}
	app.ui.setEditorText("original draft");
	expect(() => app.ui.setEditorComponent((tui, theme) => new BrokenEditor(tui, theme))).toThrow("Fixture setup failed");
	expect(app.ui.getEditorText()).toBe("original draft");
	expect(disposed).toBe(true);
});

test("custom dialogs dispose their resources on completion and cancellation", async () => {
	const { app, terminal } = await start();
	let disposals = 0;
	const show = () =>
		app.ui.custom<string>((_tui, _theme, _keybindings, done) => {
			const input = new Input();
			input.onSubmit = done;
			return Object.assign(input, {
				dispose() {
					disposals++;
				},
			});
		});
	const first = show();
	terminal.input("answer");
	terminal.input("\r");
	expect(await first).toBe("answer");
	const second = show();
	const cancelled = expect(second).rejects.toMatchObject({ name: "AbortError" });
	terminal.input("\x1b");
	await cancelled;
	expect(disposals).toBe(2);
});

test("UI attachment hooks can install a custom editor without a terminal dependency in Durable", async () => {
	const { Editor } = await import("@arc/tui");
	const events: string[] = [];
	const extension: ApplicationExtension = {
		name: "ui-lifecycle",
		onUIAttached(context) {
			events.push(`attached:${context.ui.supported}`);
			context.ui.setEditorComponent(
				(tui, theme) =>
					new (class extends Editor {
						override render(width: number): string[] {
							return ["LIFECYCLE EDITOR", ...super.render(width)];
						}
					})(tui, theme),
			);
		},
		onUIDetached() {
			events.push("detached");
		},
	};
	const { terminal, controller, result } = await start([extension]);
	await vi.waitFor(async () => expect((await terminal.screen()).join("\n")).toContain("LIFECYCLE EDITOR"));
	controller.abort();
	await result;
	expect(events).toEqual(["attached:true", "detached"]);
});

test("editor disposal failure does not prevent terminal restoration", async () => {
	const { app, controller, result, writes } = await start();
	const { Editor } = await import("@arc/tui");
	app.ui.setEditorComponent(
		(tui, theme) =>
			new (class extends Editor {
				dispose(): void {
					throw new Error("Fixture disposal failed");
				}
			})(tui, theme),
	);
	controller.abort();
	await result;
	expect(app.ui.supported).toBe(false);
	expect(writes.mock.calls.some(([text]) => text.includes("\x1b[?1049l"))).toBe(true);
});

test("multiline extension editing preserves the main draft and supports cancellation", async () => {
	const { app, terminal } = await start();
	app.ui.setEditorText("main draft");
	const result = app.ui.editor("Extension document", "first");
	terminal.input("\x1b[13;2u");
	terminal.input("second");
	terminal.input("\r");
	expect(await result).toBe("first\nsecond");
	expect(app.ui.getEditorText()).toBe("main draft");
	const cancelled = app.ui.editor("Discard document", "not saved");
	terminal.input("\x1b");
	expect(await cancelled).toBeUndefined();
	app.ui.pasteToEditor("\npasted line");
	expect(app.ui.getEditorText()).toBe("main draft\npasted line");
});

test("cancelled async UI factories dispose late components without mounting them", async () => {
	const { app, terminal } = await start();
	const ready = Promise.withResolvers<void>();
	let disposed = 0;
	const result = app.ui.custom(async () => {
		await ready.promise;
		return Object.assign(new Text("LATE COMPONENT"), {
			dispose() {
				disposed++;
			},
		});
	});
	const cancelled = expect(result).rejects.toMatchObject({ name: "AbortError" });
	terminal.input("\x1b");
	await cancelled;
	ready.resolve();
	await vi.waitFor(() => expect(disposed).toBe(1));
	expect((await terminal.screen()).join("\n")).not.toContain("LATE COMPONENT");
});

test("application renderer contributions replace live and historical default tool cards", async () => {
	const phases: boolean[] = [];
	const extension: ApplicationExtension = {
		name: "tool-presentation",
		toolRenderers: {
			bash: {
				renderCall(args) {
					return new Text(`CUSTOM BASH ${args.command}`);
				},
				renderResult(result, context) {
					phases.push(context.partial);
					return new Text(
						`CUSTOM OUTPUT ${result?.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join(" ") ?? context.slot?.output ?? "waiting"}`,
					);
				},
			},
		},
	};
	const { app, terminal, provider } = await start([extension]);
	provider.setResponses([
		fauxAssistantMessage(fauxToolCall("bash", { command: "sleep 0.05; printf 'fixture tool output'" }), {
			stopReason: "toolUse",
		}),
		fauxAssistantMessage("Renderer run finished"),
	]);
	terminal.input("Run the fixture command");
	terminal.input("\r");
	await vi.waitFor(async () => expect((await terminal.screen()).join("\n")).toContain("Renderer run finished"));
	const screen = (await terminal.screen()).join("\n");
	expect(screen).toContain("CUSTOM BASH");
	expect(screen).toContain("CUSTOM OUTPUT fixture tool output");
	expect(phases).toContain(false);
	expect(app.toolRenderers("bash")).toBe(extension.toolRenderers?.bash);
});

test("terminal shutdown cancels a lifecycle dialog before draining UI hooks", async () => {
	let cancelled = false;
	const extension: ApplicationExtension = {
		name: "pending-ui-hook",
		async onUIAttached(context) {
			cancelled = (await context.ui.editor("Pending lifecycle document", "draft")) === undefined;
		},
	};
	const { terminal, controller, result } = await start([extension]);
	await vi.waitFor(async () => expect((await terminal.screen()).join("\n")).toContain("Pending lifecycle document"));
	controller.abort();
	await result;
	expect(cancelled).toBe(true);
});

test("the task graph panel renders only when requested", async () => {
	const { app, terminal } = await start();
	expect((await terminal.screen()).join("\n")).not.toContain("Tasks · idle");
	await app.command("/tasks on");
	await vi.waitFor(async () => expect((await terminal.screen()).join("\n")).toContain("Tasks · idle"));
	await app.command("/tasks off");
	await vi.waitFor(async () => expect((await terminal.screen()).join("\n")).not.toContain("Tasks · idle"));
});

test("a failed UI lifecycle listener reports its error without breaking the terminal", async () => {
	const { app, terminal } = await start([
		{
			name: "listener-error",
			onUIAttached() {
				throw new Error("Fixture UI hook failed");
			},
		},
	]);
	await vi.waitFor(async () => expect((await terminal.screen()).join("\n")).toContain("Fixture UI hook failed"));
	expect(await app.command("/name still available")).toEqual({ message: "Session name: still available" });
});

test("extension Markdown transformations reach user, answer and thinking cards without changing stored messages", async () => {
	const contexts: import("../src/sdk.ts").MarkdownTransformContext[] = [];
	const { app, provider, terminal } = await start([
		{
			name: "markdown-filter",
			markdownTransformer(text, context) {
				contexts.push(context);
				return text.replaceAll("ORIGINAL", "RENDERED");
			},
		},
	]);
	provider.setResponses([
		fauxAssistantMessage([fauxThinking("ORIGINAL thoughts"), { type: "text", text: "ORIGINAL answer" }]),
	]);
	await app.run("ORIGINAL question");
	await vi.waitFor(async () => expect((await terminal.screen()).join("\n")).toContain("RENDERED answer"));
	expect((await terminal.screen()).join("\n")).toContain("RENDERED question");
	terminal.input("\x14");
	await vi.waitFor(async () => expect((await terminal.screen()).join("\n")).toContain("RENDERED thoughts"));
	expect(contexts.map((c) => c.messageType)).toEqual(
		expect.arrayContaining(["user", "assistant", "assistant-thinking"]),
	);
	expect(contexts.every((c) => c.availableWidth > 0)).toBe(true);
	const entries = (await app.snapshot()).view.entries;
	expect(JSON.stringify(entries)).toContain("ORIGINAL answer");
	expect(JSON.stringify(entries)).not.toContain("RENDERED answer");
});

test("extension shortcuts execute with terminal context and do not insert their key into the editor", async () => {
	const observed: string[] = [];
	const { app, terminal } = await start([
		{
			name: "keyboard-control",
			shortcuts: [
				{
					key: "ctrl+g",
					execute(context) {
						observed.push(context.mode);
						context.ui.setEditorText("Shortcut draft");
					},
				},
			],
		},
	]);
	terminal.input("\x07");
	await vi.waitFor(() => expect(app.ui.getEditorText()).toBe("Shortcut draft"));
	expect(observed).toEqual(["interactive"]);
});

test("custom messages and entries render through extension presenters and dispose on theme changes and shutdown", async () => {
	let context: ExtensionContext | undefined;
	const created: string[] = [],
		disposed: string[] = [];
	const component = (text: string) => {
		created.push(text);
		return new (class extends Text {
			constructor() {
				super(text);
			}
			dispose() {
				disposed.push(text);
			}
		})();
	};
	const { app, terminal, controller, result } = await start([
		{
			name: "custom-presenters",
			activate(c) {
				context = c;
			},
			messageRenderers: { notice: (message) => component(`NOTICE ${String(message.content)}`) },
			entryRenderers: { bookmark: (entry) => component(`BOOKMARK ${JSON.stringify(entry.data)}`) },
		},
	]);
	if (!context) throw new Error("Missing context");
	await context.sendMessage({ customType: "notice", content: "Visible note", display: true });
	await context.sendMessage({ customType: "notice", content: "Hidden note", display: false });
	await context.appendEntry("bookmark", { file: "a.ts" });
	await vi.waitFor(async () => expect((await terminal.screen()).join("\n")).toContain('BOOKMARK {"file":"a.ts"}'));
	const screen = (await terminal.screen()).join("\n");
	expect(screen).toContain("NOTICE Visible note");
	expect(screen).not.toContain("Hidden note");
	const before = disposed.length;
	app.ui.setTheme("light");
	await vi.waitFor(() => expect(disposed.length).toBeGreaterThan(before));
	controller.abort();
	await result;
	expect(disposed.sort()).toEqual(created.sort());
});

test("terminal model commands reach extension replacements and protected shortcuts retain their action", async () => {
	let shortcutCalls = 0,
		commandCalls = 0;
	const { app, terminal } = await start([
		{
			name: "model-control",
			commands: [
				{
					name: "model",
					description: "Custom selection",
					execute() {
						commandCalls++;
						return { message: "Extension model command" };
					},
				},
			],
			shortcuts: [
				{
					key: "ctrl+l",
					execute() {
						shortcutCalls++;
					},
				},
			],
		},
	]);
	app.ui.setEditorText("/model");
	terminal.input("\r");
	await vi.waitFor(() => expect(commandCalls).toBe(1));
	await vi.waitFor(async () => expect((await terminal.screen()).join("\n")).toContain("Extension model command"));
	terminal.input("\x0c");
	await vi.waitFor(async () => expect((await terminal.screen()).join("\n")).toContain("Select model"));
	expect(shortcutCalls).toBe(0);
	expect(app.hasCommandOverride("model")).toBe(true);
});

test("Code Mode nests live calls inside one script card and retains them after completion", async () => {
	const release = Promise.withResolvers<void>();
	const { app, terminal, provider, writes } = await start([
		{
			name: "nested-render-check",
			tools: [
				defineTool({
					name: "held",
					description: "Wait, then return text",
					parameters: Type.Object({}),
					async execute() {
						await release.promise;
						return { output: [{ type: "text", text: "Nested result" }] };
					},
				}),
			],
		},
	]);
	provider.setResponses([
		fauxAssistantMessage(fauxToolCall("codemode", { code: "text(await tools.held({}));" }, { id: "script" }), {
			stopReason: "toolUse",
		}),
		fauxAssistantMessage("Nested run finished"),
	]);
	const run = app.run("Run the script");
	try {
		await vi.waitFor(async () => expect((await app.snapshot()).live.nestedTools?.length).toBe(1));
		await vi.waitFor(async () => {
			const text = (await terminal.screen()).join("\n");
			expect(text).toContain("text(await tools.held({}));");
			expect(text).toContain("… held");
			expect(text).not.toContain("Tool · script / held");
		});
	} finally {
		release.resolve();
	}
	await run;
	await vi.waitFor(async () => {
		const text = (await terminal.screen()).join("\n");
		expect(text).toContain("Nested run finished");
		expect(text).toContain("✓ held");
		expect(text).toContain("Nested result");
	});
	expect(writes.mock.calls.map(([value]) => value).join("")).toMatch(/\x1b\[/);
});

test.each(["callback", "manual"])(
	"%s authentication dismisses the browser prompt and restores a usable editor",
	async (method) => {
		vi.spyOn(browser, "openBrowser").mockResolvedValue(true);
		const { app, terminal, provider } = await start();
		const original = app.models.getProvider("faux");
		if (!original || !("setProvider" in app.models) || typeof app.models.setProvider !== "function")
			throw new Error("Missing fixture provider");
		let callbackUrl: string | undefined;
		app.models.setProvider({
			...original,
			auth: {
				apiKey: {
					name: "Callback fixture",
					async login(interaction: import("@arc/ai").ProviderAuthInteraction) {
						const callback = await startOAuthCallbackServer({
							providerName: "Fixture",
							host: "127.0.0.1",
							port: 0,
							path: "/callback",
							state: "fixture-state",
							complete: async (code) => code,
							signal: interaction.signal,
						});
						callbackUrl = callback.redirectUri;
						interaction.notify({
							type: "auth_url",
							url: "https://example.invalid/authorize",
							instructions: "Authorize in browser",
						});
						try {
							const reply = await waitForCallbackOrManualInput(interaction, callback, {
								message: "Paste callback fixture code",
								placeholder: "code",
							});
							return { type: "api_key", key: reply.type === "callback" ? reply.value : reply.input };
						} finally {
							callback.close();
						}
					},
					resolve: async ({ credential }: { credential?: import("@arc/ai").ApiKeyCredential }) =>
						credential?.key ? { auth: { apiKey: credential.key } } : undefined,
				},
			},
		});
		terminal.input("/login faux");
		terminal.input("\r");
		await vi.waitFor(async () => expect((await terminal.screen()).join("\n")).toContain("Paste callback fixture code"));
		if (method === "callback") {
			if (!callbackUrl) throw new Error("Callback server missing");
			expect((await fetch(`${callbackUrl}?code=local-fixture&state=fixture-state`)).status).toBe(200);
		} else {
			terminal.input("local-fixture");
			terminal.input("\r");
		}
		await vi.waitFor(async () => expect((await terminal.screen()).join("\n")).toContain("Select model"));
		terminal.input("\x1b");
		await vi.waitFor(async () => expect((await terminal.screen()).join("\n")).toContain("Signed in to faux"));
		expect(await app.models.checkAuth("faux")).toBeDefined();
		expect((await terminal.screen()).join("\n")).not.toContain("Paste callback fixture code");
		provider.setResponses([fauxAssistantMessage("Editor usable after authentication")]);
		terminal.input("Check the editor");
		terminal.input("\r");
		await vi.waitFor(async () =>
			expect((await terminal.screen()).join("\n")).toContain("Editor usable after authentication"),
		);
	},
);

test("idle main-screen layout leaves one blank row between the answer and editor", async () => {
	const { app, terminal, provider } = await start([], false);
	provider.setResponses([fauxAssistantMessage("Last visible answer")]);
	await app.run("Check idle spacing");
	await vi.waitFor(async () => {
		const lines = await terminal.screen();
		const answer = lines.findIndex((line) => line.includes("Last visible answer"));
		const border = lines.findIndex((line, row) => row > answer && /^─+$/.test(line.trim()));
		expect(answer).toBeGreaterThanOrEqual(0);
		expect(border - answer).toBe(2);
	});
});

test("adjacent tool cards have an unpainted separator outside their backgrounds", async () => {
	const { app, terminal, provider } = await start(
		[
			{
				name: "spacing-check",
				tools: ["first_tool", "second_tool"].map((name) =>
					defineTool({
						name,
						description: "Return a line",
						parameters: Type.Object({}),
						execute: async () => ({ output: [{ type: "text", text: `${name} output` }] }),
					}),
				),
			},
		],
		false,
	);
	await app.command("/settings theme dark");
	provider.setResponses([
		fauxAssistantMessage([fauxToolCall("first_tool", {}), fauxToolCall("second_tool", {})], { stopReason: "toolUse" }),
		fauxAssistantMessage("Tool spacing checked"),
	]);
	await app.run("Show both tools");
	await vi.waitFor(async () => {
		const lines = await terminal.screen();
		const first = lines.findIndex((line) => line.includes("first_tool output"));
		const second = lines.findIndex((line) => line.includes("Tool · second_tool"));
		expect(first).toBeGreaterThanOrEqual(0);
		expect(second).toBeGreaterThan(first);
		const buffer = terminal.emulator.buffer.active;
		const gap = lines.slice(first + 1, second).map((line, index) => ({
			line,
			mode: buffer
				.getLine(buffer.viewportY + first + 1 + index)
				?.getCell(0)
				?.getBgColorMode(),
		}));
		expect(gap.filter((row) => !row.line.trim() && row.mode === 0)).toHaveLength(1);
	});
});

test("expanding long thinking retains the fullscreen viewport instead of following the new bottom", async () => {
	const { app, terminal, provider } = await start();
	provider.setResponses([
		fauxAssistantMessage([
			fauxThinking(Array.from({ length: 80 }, (_, i) => `reasoning-row-${i}`).join("\n")),
			{ type: "text", text: "Final response marker" },
		]),
	]);
	await app.run("Reason first");
	await vi.waitFor(async () => expect((await terminal.screen()).join("\n")).toContain("Final response marker"));
	terminal.input("\x14");
	await vi.waitFor(async () => expect((await terminal.screen()).join("\n")).toContain("reasoning-row-0"));
	expect((await terminal.screen()).join("\n")).not.toContain("Final response marker");
	terminal.input("\x14");
	await vi.waitFor(async () => expect((await terminal.screen()).join("\n")).toContain("Final response marker"));
});
