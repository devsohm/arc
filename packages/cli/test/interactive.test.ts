import { plainText } from "../src/core/ui/text.ts";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	createModels,
	fauxAssistantMessage,
	fauxProvider,
	fauxText,
	fauxThinking,
	fauxToolCall,
	Type,
	type ToolResultMessage,
} from "@arc/ai";
import { MemoryStorage, ToolTask, defineTool, type EntryId, type Extension, type SubmissionId } from "@arc/durable";
import {
	stripTerminalSequences,
	visibleWidth,
	setCapabilities,
	resetCapabilitiesCache,
	type TuiMouseEvent,
} from "@arc/tui";
import { afterEach, expect, test, vi } from "vitest";
import { createApplication } from "../src/core/application.ts";
import type { Application, ApplicationState } from "../src/core/types.ts";
import {
	Transcript,
	conversationItems,
	footerLines,
	messageComponent,
	queueText,
	statusText,
	toolComponent,
} from "../src/modes/interactive/components.ts";
import { runInteractive } from "../src/modes/interactive/interactive-mode.ts";
import { TestTerminal } from "../../tui/test/support/terminal.ts";

const resources = { contextFiles: [], skills: [], prompts: [], extensionFiles: [] };
const display = { toolsExpanded: false, thinkingVisible: false };
const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
	vi.restoreAllMocks();
});

async function fixture(extensions: Extension[] = [], tokensPerSecond?: number) {
	const directory = await mkdtemp(join(tmpdir(), "arc-interactive-"));
	cleanups.push(() => rm(directory, { recursive: true, force: true }));
	const provider = fauxProvider({
		tokensPerSecond,
		models: [
			{ id: "alpha", name: "Alpha", reasoning: true },
			{ id: "beta", name: "Beta", reasoning: true },
		],
	});
	const models = createModels();
	models.setProvider(provider.provider);
	const storage = new MemoryStorage();
	const app = await createApplication({
		cwd: directory,
		home: join(directory, "home"),
		backend: "memory",
		storage,
		models,
		model: { provider: "faux", modelId: "alpha" },
		resources,
		extensions,
	});
	cleanups.push(() => app.close());
	return { app, provider, directory, storage };
}

async function screen(
	app: Application,
	fullscreen = false,
	columns = 110,
	rows = 32,
	options: Pick<NonNullable<Parameters<typeof runInteractive>[1]>, "readClipboard"> = {},
) {
	const terminal = new TestTerminal(columns, rows);
	const writes = vi.spyOn(terminal, "write");
	const result = runInteractive(app, { terminal, fullscreen, ...options });
	cleanups.push(async () => {
		terminal.input("\x03");
		terminal.input("\x03");
		terminal.input("\x04");
		await result;
		terminal.dispose();
	});
	await vi.waitFor(async () => expect((await terminal.screen()).join("\n")).toContain("(auto)"));
	return { terminal, result, writes };
}

function entryState(
	state: ApplicationState,
	messages: ApplicationState["view"]["entries"][number]["model"],
	id: EntryId,
): ApplicationState {
	return {
		...state,
		view: {
			...state.view,
			entries: [{ id, conversationId: state.view.conversation.id, kind: "test", model: messages }],
		},
	};
}

test("message cards render Markdown and toggle the actual thinking text", () => {
	const message = fauxAssistantMessage([fauxThinking("private calculation"), fauxText("**Answer** with `code`")]);
	const collapsed = messageComponent(message, display).render(60).map(stripTerminalSequences).join("\n");
	expect(collapsed).toContain("Thinking...");
	expect(collapsed).not.toContain("private calculation");
	expect(collapsed).toContain("Answer with code");
	expect(collapsed).not.toContain("**Answer**");
	const expanded = messageComponent(message, { ...display, thinkingVisible: true })
		.render(60)
		.map(stripTerminalSequences)
		.join("\n");
	expect(expanded).toContain("private calculation");
	const user = messageComponent({ role: "user", content: "2. preserve my numbering", timestamp: 0 }, display)
		.render(60)
		.map(stripTerminalSequences)
		.join("\n");
	expect(user).toContain("2. preserve my numbering");
});

test("message layout omits role headings, groups thinking and supports independent mouse disclosure", () => {
	const message = fauxAssistantMessage([
		fauxThinking("first secret"),
		fauxThinking("second secret"),
		fauxText("Visible answer"),
	]);
	const card = messageComponent(message, display);
	const lines = card.render(60),
		text = () => card.render(60).map(stripTerminalSequences).join("\n");
	expect(text()).not.toContain("Assistant");
	expect(text().match(/Thinking\.\.\./g)).toHaveLength(1);
	const row = lines.findIndex((line) => stripTerminalSequences(line).includes("Thinking..."));
	expect(
		card.handleMouse?.({
			type: "click",
			button: "left",
			x: 2,
			y: row,
			screenX: 2,
			screenY: row,
			width: 60,
			height: lines.length,
			shift: false,
			alt: false,
			ctrl: false,
		})?.handled,
	).toBe(true);
	expect(text()).toContain("first secret");
	expect(text()).toContain("second secret");
	expect(card.render(60).join("\n")).toContain("\x1b]133;A\x07");
	const user = messageComponent({ role: "user", content: "Only user text", timestamp: 0 }, display)
		.render(60)
		.map(stripTerminalSequences)
		.join("\n");
	expect(user).not.toContain("You");
	expect(user.trim()).toBe("Only user text");
});

test("expanded tool output remains plain and collapsed cards hide only the omitted lines", () => {
	const result: ToolResultMessage = {
		role: "toolResult",
		toolName: "echo",
		toolCallId: "call",
		timestamp: 0,
		isError: false,
		content: [{ type: "text", text: "\x1b[31mone\x1b[0m\ntwo\nthree\nfour\nfive\nsix\nseven" }],
	};
	const collapsed = toolComponent({ kind: "tool", name: "echo", result }, display)
		.render(50)
		.map(stripTerminalSequences)
		.join("\n");
	expect(collapsed).toContain("2 more lines");
	expect(collapsed).not.toContain("seven");
	const expanded = toolComponent({ kind: "tool", name: "echo", result }, { ...display, toolsExpanded: true }).render(
		50,
	);
	expect(expanded.map(stripTerminalSequences).join("\n")).toContain("seven");
	const output = expanded.find((line) => stripTerminalSequences(line).trim() === "one");
	expect(output).toBeDefined();
	expect(output).not.toContain("\x1b[");
});

test("clicking a completed tool expands only its card and global expansion still applies to every card", async () => {
	const { app } = await fixture();
	const messages = ["first", "second"].flatMap((name) => [
		fauxAssistantMessage([fauxToolCall(name, {}, { id: name })], { stopReason: "toolUse" }),
		{
			role: "toolResult" as const,
			toolName: name,
			toolCallId: name,
			timestamp: 0,
			isError: false,
			content: [
				{ type: "text" as const, text: Array.from({ length: 8 }, (_, i) => `${name} line ${i + 1}`).join("\n") },
			],
		},
	]);
	const state = entryState(await app.snapshot(), messages, 1 as EntryId);
	const onExpansion = vi.fn();
	const transcript = new Transcript(undefined, undefined, undefined, undefined, onExpansion);
	transcript.update(state, display);
	const text = () => transcript.render(100).map(stripTerminalSequences).join("\n");
	expect(text()).not.toContain("first line 8");
	expect(text()).not.toContain("second line 8");
	const tool = transcript.children.find((child) =>
		child.render(100).map(stripTerminalSequences).join("\n").includes("Tool · first"),
	);
	transcript.update(
		entryState(
			state,
			[...messages, { role: "user", content: "new message after tool completion", timestamp: 0 }],
			1 as EntryId,
		),
		display,
	);
	const event: TuiMouseEvent = {
		type: "click",
		button: "left",
		x: 1,
		y: 1,
		screenX: 1,
		screenY: 1,
		width: 100,
		height: 12,
		shift: false,
		alt: false,
		ctrl: false,
	};
	expect(tool?.handleMouse?.(event)?.handled).toBe(true);
	expect(onExpansion).toHaveBeenCalledTimes(1);
	expect(text()).toContain("first line 8");
	expect(text()).not.toContain("second line 8");
	expect(text()).toContain("new message after tool completion");
	transcript.update(state, { ...display, toolsExpanded: true });
	expect(text()).toContain("first line 8");
	expect(text()).toContain("second line 8");
	transcript.update(state, display);
	expect(text()).not.toContain("first line 8");
	transcript.dispose();
});

test("raw tool and Markdown text cannot emit terminal title, cursor, erase, or C1 control sequences", () => {
	const raw = "before\x1b]0;untrusted-title\x07\x1b[999;999H\x1b[2J\x1b[?25l\x9b2Jafter";
	expect(plainText(raw)).not.toContain("untrusted-title");
	expect(plainText(raw)).not.toMatch(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/);
	const result: ToolResultMessage = {
		role: "toolResult",
		toolName: "file",
		toolCallId: "call",
		timestamp: 0,
		isError: false,
		content: [{ type: "text", text: raw }],
	};
	const tool = toolComponent({ kind: "tool", name: "file", result }, { ...display, toolsExpanded: true })
		.render(80)
		.map(stripTerminalSequences)
		.join("\n");
	const markdown = messageComponent(fauxAssistantMessage(raw), display)
		.render(80)
		.map(stripTerminalSequences)
		.join("\n");
	expect(tool).not.toContain("untrusted-title");
	expect(markdown).not.toContain("untrusted-title");
	expect(tool).toContain("before");
	expect(tool).toContain("after");
});

test("tool results attach to the matching occurrence when call IDs repeat across turns", async () => {
	const { app, storage } = await fixture();
	const first = fauxAssistantMessage([fauxToolCall("first", {}, { id: "reused" })], { stopReason: "toolUse" });
	const second = fauxAssistantMessage([fauxToolCall("second", {}, { id: "reused" })], { stopReason: "toolUse" });
	const result = (toolName: string, text: string): ToolResultMessage => ({
		role: "toolResult",
		toolCallId: "reused",
		toolName,
		content: [{ type: "text", text }],
		timestamp: 0,
		isError: false,
	});
	const state = entryState(
		await app.snapshot(),
		[first, result("first", "old output"), second, result("second", "new output")],
		await storage.mintId<EntryId>(),
	);
	const cards = conversationItems(state).filter((item) => item.kind === "tool");
	expect(cards.map((card) => [card.name, card.result?.content])).toEqual([
		["first", [{ type: "text", text: "old output" }]],
		["second", [{ type: "text", text: "new output" }]],
	]);
	const transcript = new Transcript();
	transcript.update(state, display);
	expect(transcript.render(60).map(stripTerminalSequences).join("\n")).toContain("new output");
	const interrupted = entryState(
		await app.snapshot(),
		[fauxAssistantMessage([fauxToolCall("unfinished", {})], { stopReason: "aborted" })],
		await storage.mintId<EntryId>(),
	);
	transcript.update(interrupted, display);
	expect(transcript.render(60).map(stripTerminalSequences).join("\n")).toContain("unfinished [not run]");
});

test("footer derives model, usage, session, queue, and retry state without exceeding its width", async () => {
	const { app, storage } = await fixture();
	const base = await app.snapshot();
	const usage = fauxAssistantMessage("answer").usage;
	const state: ApplicationState = {
		...base,
		sessionFile: "/tmp/session.sqlite",
		inbox: {
			items: [
				{ id: await storage.mintId<SubmissionId>(), mode: "steer", content: "next request" },
				{ id: await storage.mintId<SubmissionId>(), mode: "followUp", content: "later request" },
			],
		},
		live: { generation: { attempt: 2, retry: { at: 1, error: "temporary failure" } } },
		usage: {
			models: { "faux/alpha": { ...usage, totalTokens: 1234, cost: { ...usage.cost, total: 0.25 } } },
			tools: {},
		},
	};
	expect(queueText(state)).toBe("Queued steer · next request\nQueued follow-up · later request");
	expect(statusText(state)).toBe("Retrying · temporary failure");
	const footer = footerLines(state, 180, app.models.getModel("faux", "alpha"));
	expect(footer[0]).toContain(app.cwd);
	expect(footer[1]).toContain("$0.250");
	expect(footer[1].trimEnd()).toMatch(/alpha • thinking off$/);
	expect(footer).toHaveLength(2);
	const annotated = footerLines(state, 180, app.models.getModel("faux", "alpha"), 1, {
		branch: "feature/footer",
		subscription: true,
	});
	expect(annotated[0]).toContain("(feature/footer)");
	expect(annotated[1]).toContain("$0.250 (sub)");
	expect(footerLines(state, 17).every((line) => visibleWidth(line) <= 17)).toBe(true);
});

test.each([false, true])(
	"the %s fullscreen setting submits multiline text through the real application and restores the terminal",
	async (fullscreen) => {
		const { app, provider } = await fixture();
		provider.setResponses([fauxAssistantMessage("**Rendered answer**")]);
		const run = vi.spyOn(app, "run");
		const before = process.listenerCount("SIGTERM");
		const { terminal, result, writes } = await screen(app, fullscreen);
		terminal.input("first line");
		terminal.input("\x1b[13;2u");
		terminal.input("second line");
		terminal.input("\r");
		await vi.waitFor(() => expect(run).toHaveBeenCalledWith("first line\nsecond line"));
		await vi.waitFor(async () => expect((await terminal.screen()).join("\n")).toContain("Rendered answer"));
		terminal.input("\x04");
		await result;
		expect(process.listenerCount("SIGTERM")).toBe(before);
		expect(writes.mock.calls.some(([text]) => text.includes("\x1b[?25h"))).toBe(true);
		if (fullscreen) {
			expect(writes.mock.calls.some(([text]) => text.includes("\x1b[?1049h"))).toBe(true);
			expect(writes.mock.calls.some(([text]) => text.includes("\x1b[?1049l"))).toBe(true);
		}
	},
);

test("model and thinking selectors filter and change the real application", async () => {
	const { app } = await fixture();
	const { terminal } = await screen(app, true);
	terminal.input("/model");
	terminal.input("\r");
	await vi.waitFor(async () => expect((await terminal.screen()).join("\n")).toContain("Select model"));
	terminal.input("beta");
	terminal.input("\r");
	await vi.waitFor(async () => expect((await app.snapshot()).agent.model?.modelId).toBe("beta"));
	terminal.input("/thinking");
	terminal.input("\r");
	await vi.waitFor(async () => expect((await terminal.screen()).join("\n")).toContain("Select thinking"));
	terminal.input("high");
	terminal.input("\r");
	await vi.waitFor(async () => expect((await app.snapshot()).agent.thinkingLevel).toBe("high"));
	terminal.input("/model");
	terminal.input("\r");
	await vi.waitFor(async () => expect((await terminal.screen()).join("\n")).toContain("Select model"));
	terminal.input("\x1b");
	await vi.waitFor(async () => expect((await terminal.screen()).join("\n")).not.toContain("Select model"));
});

test("slash completion opens a selector and command failures remain visible while input stays usable", async () => {
	const { app } = await fixture();
	const { terminal, result } = await screen(app);
	terminal.input("/thi");
	terminal.input("\t");
	await vi.waitFor(async () => expect((await terminal.screen()).join("\n")).toContain("Set thinking level"));
	terminal.input("\r");
	await vi.waitFor(async () => expect((await terminal.screen()).join("\n")).toContain("Select thinking"));
	terminal.input("\x1b");
	terminal.input("/does-not-exist");
	terminal.input("\r");
	await vi.waitFor(async () => expect((await terminal.screen()).join("\n")).toContain("Unknown command"));
	terminal.input("draft input");
	terminal.input("\x03");
	await vi.waitFor(async () => expect((await terminal.screen()).join("\n")).not.toContain("draft input"));
	terminal.input("\x04");
	await result;
});

test("live tools and thinking render while steering and follow-up inputs queue, then Ctrl+C aborts", async () => {
	const gate = Promise.withResolvers<void>();
	const tool = defineTool({
		name: "wait_for_release",
		description: "Wait until released",
		parameters: Type.Object({}),
		async execute(_args, api, context) {
			api.output("line one\nline two\nline three\nline four\nline five\nline six\nlast live line\n");
			const cancellation = Promise.withResolvers<void>();
			const abort = () => cancellation.reject(context.abortSignal?.reason);
			context.abortSignal?.addEventListener("abort", abort, { once: true });
			try {
				await Promise.race([gate.promise, cancellation.promise]);
			} finally {
				context.abortSignal?.removeEventListener("abort", abort);
			}
			return { output: [{ type: "text", text: "tool finished" }] };
		},
	});
	const { app, provider } = await fixture([{ name: "interactive-tools", tools: [tool] }]);
	provider.setResponses([
		fauxAssistantMessage(
			[fauxThinking("considering the request"), fauxText("Starting work"), fauxToolCall("wait_for_release", {})],
			{ stopReason: "toolUse" },
		),
		fauxAssistantMessage("Completed"),
	]);
	const submit = vi.spyOn(app, "submit");
	const abort = vi.spyOn(app, "abort");
	const { terminal } = await screen(app, true, 120, 38);
	terminal.input("begin");
	terminal.input("\r");
	await vi.waitFor(async () => expect((await terminal.screen()).join("\n")).toContain("line five"));
	expect((await terminal.screen()).join("\n")).not.toContain("last live line");
	terminal.input("\x0f");
	terminal.input("\x14");
	await vi.waitFor(async () => {
		const text = (await terminal.screen()).join("\n");
		expect(text).toContain("last live line");
		expect(text).toContain("considering the request");
	});
	terminal.input("steer request");
	terminal.input("\r");
	terminal.input("follow request");
	terminal.input("\x1b\r");
	await vi.waitFor(() => {
		expect(submit).toHaveBeenCalledWith("steer request", { whenBusy: "steer" });
		expect(submit).toHaveBeenCalledWith("follow request", { whenBusy: "followUp" });
	});
	await vi.waitFor(async () =>
		expect((await terminal.screen()).join("\n")).toContain("Queued follow-up · follow request"),
	);
	terminal.input("\x03");
	await vi.waitFor(() => expect(abort).toHaveBeenCalled());
	gate.resolve();
	await vi.waitFor(async () => expect((await app.snapshot()).busy).toBe(false));
});

test("model text appears before generation completes and Ctrl+C cancels a live provider stream", async () => {
	const { app, provider } = await fixture([], 30);
	provider.setResponses([
		fauxAssistantMessage("live provider prefix " + "more text ".repeat(60) + "generation complete"),
	]);
	const { terminal } = await screen(app, true);
	terminal.input("stream a response");
	terminal.input("\r");
	await vi.waitFor(async () => expect((await terminal.screen()).join("\n")).toContain("live provider"));
	expect((await app.snapshot()).busy).toBe(true);
	expect((await terminal.screen()).join("\n")).not.toContain("generation complete");
	terminal.input("\x03");
	await vi.waitFor(async () => expect((await app.snapshot()).busy).toBe(false));
});

test("fullscreen scrolls history while preserving the input dock and typed text across resize", async () => {
	const { app } = await fixture();
	const history = Array.from({ length: 45 }, (_, index) => `history ${String(index).padStart(2, "0")}`).join("\n\n");
	await app.harness.commit(
		(tx) => tx.appendEntry(app.conversation.id, { kind: "test", model: [fauxAssistantMessage(history)] }),
		app.context,
	);
	const { terminal } = await screen(app, true, 100, 20);
	await vi.waitFor(async () => expect((await terminal.screen()).join("\n")).toContain("history 44"));
	terminal.input("draft survives");
	terminal.input("\x1b[5~");
	await vi.waitFor(async () => {
		const text = (await terminal.screen()).join("\n");
		expect(text).toContain("draft survives");
		expect(text).not.toContain("history 44");
	});
	terminal.resize(54, 17);
	await vi.waitFor(async () => expect((await terminal.screen()).join("\n")).toContain("draft survives"));
	terminal.input("\x03");
});

test("AbortSignal stops the UI, removes handlers, and restores the previous fullscreen contents", async () => {
	const { app } = await fixture();
	const terminal = new TestTerminal(100, 20);
	terminal.write("previous shell contents");
	await terminal.screen();
	const stop = vi.spyOn(terminal, "stop");
	const controller = new AbortController();
	const signals = process.listenerCount("SIGTERM");
	const result = runInteractive(app, { terminal, fullscreen: true, signal: controller.signal });
	cleanups.push(async () => {
		controller.abort();
		await result;
		terminal.dispose();
	});
	await vi.waitFor(async () => expect((await terminal.screen()).join("\n")).toContain("Enter send"));
	controller.abort();
	await result;
	expect(stop).toHaveBeenCalledOnce();
	expect(process.listenerCount("SIGTERM")).toBe(signals);
	expect((await terminal.screen())[0]).toBe("previous shell contents");
	const untouched = new TestTerminal();
	const start = vi.spyOn(untouched, "start");
	await runInteractive(app, { terminal: untouched, signal: controller.signal });
	expect(start).not.toHaveBeenCalled();
	untouched.dispose();
});

test("user and tool images use terminal image protocols and reject raw control payloads", () => {
	const image = {
		type: "image" as const,
		mimeType: "image/png",
		data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1sAAAAASUVORK5CYII=",
	};
	setCapabilities({ images: "kitty", trueColor: true, hyperlinks: true });
	try {
		const user = messageComponent({ role: "user", content: [image], timestamp: 1 }, display)
			.render(80)
			.join("\n");
		expect(user).toContain("\x1b_G");
		const tool = toolComponent(
			{
				kind: "tool",
				name: "read",
				result: {
					role: "toolResult",
					toolCallId: "image-call",
					toolName: "read",
					content: [image],
					isError: false,
					timestamp: 1,
				},
			},
			display,
		)
			.render(80)
			.join("\n");
		expect(tool).toContain("\x1b_G");
		const unsafe = messageComponent(
			{ role: "user", content: [{ ...image, data: "\x1b]0;injected\x07" }], timestamp: 1 },
			display,
		)
			.render(80)
			.join("\n");
		expect(unsafe).toContain("Unsupported image");
		expect(unsafe).not.toContain("injected");
		setCapabilities({ images: null, trueColor: false, hyperlinks: false });
		expect(
			messageComponent({ role: "user", content: [image], timestamp: 1 }, display)
				.render(80)
				.join("\n"),
		).not.toContain("\x1b_G");
	} finally {
		resetCapabilitiesCache();
	}
});

test("tool renderers receive live state, survive historical missing tools and fall back on failures", async () => {
	const { app, storage } = await fixture();
	const call = fauxToolCall("historical-tool", { value: 7 }, { id: "owned-render" });
	const state = entryState(
		await app.snapshot(),
		[
			fauxAssistantMessage([call], { stopReason: "toolUse" }),
			{
				role: "toolResult",
				toolCallId: "owned-render",
				toolName: "historical-tool",
				content: [{ type: "text", text: "fallback output" }],
				isError: false,
				timestamp: 2,
			},
		],
		await storage.mintId<EntryId>(),
	);
	const failures: unknown[] = [];
	let disposed = 0;
	const { Text } = await import("@arc/tui");
	const transcript = new Transcript(
		(name) =>
			name === "historical-tool"
				? {
						renderCall(args, context) {
							context.state.value = args.value;
							return Object.assign(new Text(`CUSTOM ${args.value}`), {
								dispose() {
									disposed++;
								},
							});
						},
						renderResult(_result, context) {
							return new Text(`RESULT ${context.state.value} expanded=${context.expanded}`);
						},
					}
				: undefined,
		() => {},
		(error) => failures.push(error),
	);
	transcript.update(state, display);
	expect(transcript.render(80).map(stripTerminalSequences).join("\n")).toContain("CUSTOM 7");
	expect(transcript.render(80).map(stripTerminalSequences).join("\n")).toContain("RESULT 7 expanded=false");
	transcript.update(state, { ...display, thinkingVisible: true });
	expect(disposed).toBe(0);
	expect(transcript.render(80).map(stripTerminalSequences).join("\n")).toContain("CUSTOM 7");
	transcript.update(state, { ...display, toolsExpanded: true });
	expect(disposed).toBe(1);
	expect(transcript.render(80).map(stripTerminalSequences).join("\n")).toContain("expanded=true");
	transcript.dispose();
	expect(disposed).toBe(2);
	const broken = new Transcript(
		() => ({
			renderResult: () => ({
				render() {
					throw new Error("Fixture renderer failed");
				},
				invalidate() {},
			}),
		}),
		() => {},
		(error) => failures.push(error),
	);
	broken.update(state, display);
	expect(broken.render(80).map(stripTerminalSequences).join("\n")).toContain("fallback output");
	expect(failures).toHaveLength(1);
	broken.dispose();
});

test("terminal applies and reloads configured application/editor keys and retains valid keys after a bad reload", async () => {
	const { app } = await fixture();
	await mkdir(app.home, { recursive: true });
	const path = join(app.home, "keybindings.json");
	await writeFile(path, JSON.stringify({ "app.tools.expand": "ctrl+y", "tui.input.submit": "ctrl+s" }));
	const terminal = new TestTerminal(120, 60);
	const result = runInteractive(app, { terminal });
	cleanups.push(async () => {
		terminal.input("\x03");
		terminal.input("\x04");
		await result;
		terminal.dispose();
	});
	await vi.waitFor(async () => expect((await terminal.screen()).join("\n")).toContain("Ctrl+S send"));
	expect((await terminal.screen()).join("\n")).toContain("Ctrl+Y tools");
	terminal.input("/thinking high");
	terminal.input("\x13");
	await vi.waitFor(async () => expect((await app.snapshot()).agent.thinkingLevel).toBe("high"));
	await writeFile(path, JSON.stringify({ "app.tools.expand": "ctrl+w" }));
	terminal.input("/reload");
	terminal.input("\x13");
	await vi.waitFor(async () => {
		const text = (await terminal.screen()).join("\n");
		expect(text).toContain("Ctrl+W tools");
		expect(text).toContain("Enter send");
	});
	await writeFile(path, JSON.stringify({ "app.tools.expand": "invalid" }));
	terminal.input("/reload");
	terminal.input("\r");
	await vi.waitFor(async () => expect((await terminal.screen()).join("\n")).toContain("Invalid keys"));
	expect((await terminal.screen()).join("\n")).toContain("Ctrl+W tools");
	terminal.input("/hotkeys");
	terminal.input("\r");
	await vi.waitFor(async () => expect((await terminal.screen()).join("\n")).toContain("ctrl+w: Expand tool output"));
	terminal.input("\x04");
	await result;
});

test("clipboard image input reaches the runtime, clears after submission, and text paste remains editable", async () => {
	const { app, provider } = await fixture();
	const data = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==";
	let imageSeen = false;
	provider.setResponses([
		(transcript) => {
			imageSeen = transcript.messages.some(
				(message) =>
					message.role === "user" &&
					Array.isArray(message.content) &&
					message.content.some((part) => part.type === "image" && part.data === data),
			);
			return fauxAssistantMessage("Image received");
		},
	]);
	let reads = 0;
	const { terminal } = await screen(app, true, 120, 36, {
		readClipboard: async () =>
			++reads === 1
				? { type: "image", image: { type: "image", data, mimeType: "image/png" } }
				: { type: "text", text: "pasted text" },
	});
	terminal.input("\x16");
	await vi.waitFor(async () => expect((await terminal.screen()).join("\n")).toContain("1 attached image"));
	terminal.input("Describe this");
	terminal.input("\r");
	await vi.waitFor(async () => expect((await terminal.screen()).join("\n")).toContain("Image received"));
	expect(imageSeen).toBe(true);
	expect((await terminal.screen()).join("\n")).not.toContain("1 attached image");
	terminal.input("\x16");
	await vi.waitFor(() => expect(app.ui.getEditorText()).toBe("pasted text"));
});

test("an image-only draft can be cleared without exiting and a rejected image keeps its draft", async () => {
	const { app } = await fixture();
	const { terminal } = await screen(app, true, 120, 36, {
		readClipboard: async () => ({ type: "image", image: { type: "image", data: "invalid", mimeType: "image/png" } }),
	});
	terminal.input("\x16");
	await vi.waitFor(async () => expect((await terminal.screen()).join("\n")).toContain("1 attached image"));
	terminal.input("\x03");
	await vi.waitFor(async () => expect((await terminal.screen()).join("\n")).not.toContain("1 attached image"));
	expect(app.ui.supported).toBe(true);
	terminal.input("\x16");
	await vi.waitFor(async () => expect((await terminal.screen()).join("\n")).toContain("1 attached image"));
	terminal.input("Describe");
	terminal.input("\r");
	await vi.waitFor(async () => expect((await terminal.screen()).join("\n")).toContain("Cannot decode"));
	expect(app.ui.getEditorText()).toBe("Describe");
	expect((await terminal.screen()).join("\n")).toContain("1 attached image");
	expect((await app.snapshot()).view.entries).toEqual([]);
});

test("settings opens a keyboard menu and commits changes through the shared application", async () => {
	const { app } = await fixture();
	const { terminal } = await screen(app, true);
	terminal.input("/settings");
	terminal.input("\r");
	await vi.waitFor(async () => expect((await terminal.screen()).join("\n")).toContain("Tool execution"));
	terminal.input("Tool execution");
	terminal.input("\r");
	await vi.waitFor(async () => expect((await app.snapshot()).settings?.toolExecution).toBe("sequential"));
	terminal.input("\x1b");
	await vi.waitFor(async () => expect((await terminal.screen()).join("\n")).toContain("Enter send"));
	terminal.input("/settings toolExecution parallel");
	terminal.input("\r");
	await vi.waitFor(async () => expect((await app.snapshot()).settings?.toolExecution).toBe("parallel"));
});

test("fullscreen changes live from the settings menu and SDK while retaining the extension editor and draft", async () => {
	const { app } = await fixture();
	const { terminal } = await screen(app);
	const { Editor } = await import("@arc/tui");
	let disposed = 0;
	app.ui.setEditorComponent(
		(tui, theme) =>
			new (class extends Editor {
				override render(width: number) {
					return ["Screen-switch editor", ...super.render(width)];
				}
				dispose() {
					disposed++;
				}
			})(tui, theme),
	);
	terminal.input("/settings");
	terminal.input("\r");
	await vi.waitFor(async () => expect((await terminal.screen()).join("\n")).toContain("Tool execution"));
	terminal.input("Fullscreen");
	terminal.input("\r");
	await vi.waitFor(() => expect(terminal.emulator.buffer.active.type).toBe("alternate"));
	await vi.waitFor(async () => expect((await terminal.screen()).join("\n")).toContain("Fullscreen"));
	terminal.input("\x1b");
	await vi.waitFor(async () => expect((await terminal.screen()).join("\n")).toContain("Screen-switch editor"));
	terminal.input("kept draft");
	await app.command("/settings fullscreen false");
	await vi.waitFor(() => expect(terminal.emulator.buffer.active.type).toBe("normal"));
	await vi.waitFor(async () => expect((await terminal.screen()).join("\n")).toContain("kept draft"));
	terminal.input(" plus");
	expect(app.ui.getEditorText()).toBe("kept draft plus");
	expect(disposed).toBe(0);
});

test("model scope changes apply while the menu is open, Escape keeps them and explicit save persists them", async () => {
	const { app } = await fixture();
	const { terminal } = await screen(app, true);
	terminal.input("/scoped-models");
	terminal.input("\r");
	await vi.waitFor(async () => expect((await terminal.screen()).join("\n")).toContain("Models for cycling"));
	terminal.input(" ");
	await vi.waitFor(async () => expect((await app.snapshot()).enabledModels).toEqual(["faux/beta"]));
	terminal.input("\x1b");
	await vi.waitFor(async () => expect((await terminal.screen()).join("\n")).not.toContain("Models for cycling"));
	expect((await app.snapshot()).enabledModels).toEqual(["faux/beta"]);
	expect((await terminal.screen()).join("\n")).not.toContain("dialog was cancelled");
	terminal.input("/scoped-models");
	terminal.input("\r");
	await vi.waitFor(async () => expect((await terminal.screen()).join("\n")).toContain("Models for cycling"));
	terminal.input("\x01");
	await vi.waitFor(async () => expect((await app.snapshot()).enabledModels).toEqual(["faux/alpha", "faux/beta"]));
	terminal.input("\x10");
	await vi.waitFor(async () => expect((await app.snapshot()).enabledModels).toEqual([]));
	terminal.input("\x01");
	terminal.input("\x13");
	await vi.waitFor(async () =>
		expect(JSON.parse(await readFile(join(app.home, "settings.json"), "utf8")).enabledModels).toEqual([
			"faux/alpha",
			"faux/beta",
		]),
	);
});

test("the model scope menu expands patterns without losing thinking overrides when saved", async () => {
	const { app } = await fixture();
	await app.command("/scoped-models faux/b*:low,faux/a*:high");
	const { terminal } = await screen(app, true);
	terminal.input("/scoped-models");
	terminal.input("\r");
	await vi.waitFor(async () => expect((await terminal.screen()).join("\n")).toContain("Models for cycling"));
	terminal.input("\x13");
	await vi.waitFor(async () =>
		expect(JSON.parse(await readFile(join(app.home, "settings.json"), "utf8")).enabledModels).toEqual([
			"faux/beta:low",
			"faux/alpha:high",
		]),
	);
	await app.cycleModel();
	expect((await app.snapshot()).agent).toMatchObject({
		model: { provider: "faux", modelId: "beta" },
		thinkingLevel: "low",
	});
});

test("the terminal displays an on-disk edit preview before execution and then the actual result", async () => {
	const release = Promise.withResolvers<void>();
	const { app, provider, directory } = await fixture([
		{
			name: "pause-edit",
			hooks: [
				{
					task: ToolTask.definition.name,
					handlers: {
						async beforeTool() {
							await release.promise;
						},
					},
				},
			],
		},
	]);
	await writeFile(join(directory, "preview.txt"), "top\nbefore\nbottom\n");
	provider.setResponses([
		fauxAssistantMessage(
			fauxToolCall("edit", { path: "preview.txt", edits: [{ oldText: "before", newText: "after" }] }),
			{ stopReason: "toolUse" },
		),
		fauxAssistantMessage("Previewed edit complete"),
	]);
	const { terminal } = await screen(app, true);
	cleanups.push(() => release.resolve());
	terminal.input("Apply edit");
	terminal.input("\r");
	await vi.waitFor(async () => expect((await terminal.screen()).join("\n")).toContain("-2 before"));
	expect((await terminal.screen()).join("\n")).toContain("+2 after");
	expect(await readFile(join(directory, "preview.txt"), "utf8")).toBe("top\nbefore\nbottom\n");
	release.resolve();
	await vi.waitFor(async () => expect((await terminal.screen()).join("\n")).toContain("Previewed edit complete"));
	expect(await readFile(join(directory, "preview.txt"), "utf8")).toBe("top\nafter\nbottom\n");
	expect((await terminal.screen()).join("\n").match(/-2 before/g)).toHaveLength(1);
});
