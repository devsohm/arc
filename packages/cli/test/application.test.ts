import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	createModels,
	registerSessionResourceCleanup,
	fauxAssistantMessage,
	fauxProvider,
	fauxText,
	fauxThinking,
	fauxToolCall,
} from "@arc/ai";
import { getCurrentTools, normalizeContext } from "@arc/ai/utils/transcript";
import { MemoryStorage, CompactionEntry, defineDoc, defineTask, ProviderDoc } from "@arc/durable";
import { listSessions } from "../src/core/sessions/sessions.ts";
import { BACKGROUND_CONTEXT as context, withAbortSignal } from "@arc/durable/context";
import { NodeExecutionEnv } from "@arc/durable/env/node";
import { afterEach, expect, test, vi } from "vitest";
import { createApplication, type Application, type ApplicationOptions, type ApplicationState } from "../src/sdk.ts";
import { importTranscript } from "../src/core/sessions/transcript.ts";
import { defineTool, hook, ToolTask } from "@arc/durable";
import { Type } from "typebox";
import { Text } from "@arc/tui";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function fixture(extra: Partial<ApplicationOptions> = {}) {
	const directory = await realpath(await mkdtemp(join(tmpdir(), "arc-application-")));
	cleanups.push(() => rm(directory, { recursive: true, force: true }));
	const cwd = join(directory, "work");
	const home = join(directory, "home");
	await mkdir(cwd);
	await mkdir(home);
	const models = createModels();
	const provider = fauxProvider({
		models: [
			{ id: "alpha", reasoning: true },
			{ id: "beta", reasoning: true },
			{ id: "plain", reasoning: false },
		],
	});
	models.setProvider(provider.provider);
	const storage = extra.storage ?? (extra.backend && extra.backend !== "memory" ? undefined : new MemoryStorage());
	const options: ApplicationOptions = {
		projectTrusted: true,
		cwd,
		home,
		models,
		storage,
		backend: "memory",
		model: { provider: "faux", modelId: "alpha" },
		resources: { contextFiles: [], skills: [], prompts: [], extensionFiles: [] },
		...extra,
	};
	const app = await createApplication(options);
	cleanups.push(() => app.close());
	return { app, provider, models, storage, cwd, home, directory, options };
}

function messages(state: ApplicationState) {
	return state.view.entries.flatMap((entry) => entry.model ?? []);
}

test("explicit JSONL sessions write inspectable files and reopen with their history", async () => {
	const f = await fixture({ backend: "jsonl", storage: undefined });
	f.provider.setResponses([fauxAssistantMessage("Stored answer")]);
	await f.app.run("Keep this session");
	const file = (await f.app.snapshot()).sessionFile;
	expect(file).toMatch(/\.jsonl$/);
	if (!file) throw new Error("Session path missing");
	await f.app.close();
	const lines = (await readFile(join(file, "main.jsonl"), "utf8")).trim().split("\n");
	expect(lines.length).toBeGreaterThan(1);
	for (const line of lines) expect(() => JSON.parse(line)).not.toThrow();
	const reopened = await createApplication({ ...f.options, sessionFile: file });
	try {
		expect(messages(await reopened.snapshot())).toContainEqual(
			expect.objectContaining({ role: "user", content: "Keep this session" }),
		);
		expect(messages(await reopened.snapshot())).toContainEqual(
			expect.objectContaining({
				role: "assistant",
				content: expect.arrayContaining([expect.objectContaining({ type: "text", text: "Stored answer" })]),
			}),
		);
		await reopened.command("/new");
		expect((await reopened.snapshot()).sessionFile).toMatch(/\.jsonl$/);
	} finally {
		await reopened.close();
	}
});

test("explicit memory sessions do not create session files", async () => {
	const f = await fixture({ backend: "memory", storage: undefined });
	f.provider.setResponses([fauxAssistantMessage("In memory")]);
	await f.app.run("Temporary conversation");
	expect((await f.app.snapshot()).sessionFile).toBeUndefined();
	expect(await listSessions(f.home, f.cwd)).toEqual([]);
});

test("Arc identity reaches generation and model calls made inside tools", async () => {
	const identities: (import("@arc/ai").ClientIdentity | undefined)[] = [];
	const tool = defineTool({
		name: "identity_check",
		description: "Call a model from a tool",
		parameters: Type.Object({}),
		async execute(_args, api) {
			const model = api.models.getModel("faux", "alpha");
			if (!model) throw new Error("Test model missing");
			await api.models.completeSimple(
				model,
				normalizeContext({ messages: [{ role: "user", content: "Tool request", timestamp: 0 }] }),
				{ identity: { userAgent: { custom: "tool-host" } } },
			);
			return { output: [{ type: "text", text: "Checked" }] };
		},
	});
	const f = await fixture({ extensions: [{ name: "identity-test", tools: [tool] }] });
	f.provider.setResponses([
		(_context, options) => {
			identities.push(options?.identity);
			return fauxAssistantMessage(fauxToolCall("identity_check", {}), { stopReason: "toolUse" });
		},
		(_context, options) => {
			identities.push(options?.identity);
			return fauxAssistantMessage("Nested");
		},
		(_context, options) => {
			identities.push(options?.identity);
			return fauxAssistantMessage("Done");
		},
	]);
	await expect(f.app.run("Check tool model identity")).resolves.toEqual({ status: "done", text: "Done" });
	expect(identities).toHaveLength(3);
	for (const identity of identities) expect(identity?.attribution?.name).toBe("arc");
	expect(identities[1]?.userAgent).toEqual({ custom: "tool-host" });
});

test("dynamic extension registrations reach Durable, commands, flags, shortcuts and renderers", async () => {
	let retained: import("../src/core/types.ts").ExtensionContext | undefined;
	const messageRenderer = () => new Text("dynamic message"),
		entryRenderer = () => new Text("dynamic entry");
	const toolRenderer = { renderCall: () => new Text("dynamic call") };
	const f = await fixture({
		extensionArgs: ["--dynamic-option", "configured"],
		extensions: [
			{
				name: "dynamic-registration",
				activate(context) {
					retained = context;
					context.registerTool(
						defineTool({
							name: "dynamic_echo",
							description: "Dynamic echo",
							parameters: Type.Object({}),
							execute: async () => ({ output: [{ type: "text", text: "dynamic output" }] }),
						}),
					);
					context.registerFlag("dynamic-option", { type: "string", default: "default" });
					context.registerCommand({
						name: "dynamic-command",
						description: "Dynamic command",
						execute: () => ({ message: String(context.getFlag("dynamic-option")) }),
					});
					context.registerShortcut({ key: "ctrl+j", execute: () => context.setSessionName("shortcut invoked") });
					context.registerMessageRenderer("dynamic", messageRenderer);
					context.registerEntryRenderer("dynamic", entryRenderer);
					context.registerToolRenderer("dynamic_echo", toolRenderer);
					expect(() =>
						context.registerCommand({ name: "abort", description: "Reserved", execute: () => ({}) }),
					).toThrow("reserved");
				},
			},
		],
	});
	expect((await f.app.command("/dynamic-command")).message).toBe("configured");
	expect(f.app.messageRenderer("dynamic")).toBe(messageRenderer);
	expect(f.app.entryRenderer("dynamic")).toBe(entryRenderer);
	expect(f.app.toolRenderers("dynamic_echo")).toBe(toolRenderer);
	await f.app
		.shortcuts()
		.find((value) => value.key === "ctrl+j")
		?.execute();
	expect((await f.app.snapshot()).sessionName).toBe("shortcut invoked");
	f.provider.setResponses([
		fauxAssistantMessage(fauxToolCall("dynamic_echo", {}), { stopReason: "toolUse" }),
		fauxAssistantMessage("dynamic completed"),
	]);
	await expect(f.app.run("Use the registered tool")).resolves.toEqual({ status: "done", text: "dynamic completed" });
	expect(messages(await f.app.snapshot())).toContainEqual(
		expect.objectContaining({
			role: "toolResult",
			toolName: "dynamic_echo",
			content: [{ type: "text", text: "dynamic output" }],
		}),
	);
	await f.app.close();
	if (!retained) throw new Error("Extension context missing");
	const saved = retained;
	expect(() =>
		saved.registerTool(
			defineTool({ name: "stale", description: "Stale", parameters: Type.Object({}), execute: async () => ({}) }),
		),
	).toThrow("closed");
});

test("dynamic file contributions retain reload ownership and disappear when their owner is removed", async () => {
	const f = await fixture();
	const file = join(f.cwd, "dynamic.mjs");
	const source = (text: string) =>
		`export default {name:"dynamic-file",activate(context){context.registerCommand({name:"dynamic-file-command",description:"Dynamic file",execute(){return {message:${JSON.stringify(text)}}}});}};`;
	await writeFile(file, source("first"));
	const options = { ...f.options, storage: new MemoryStorage(), extensionFiles: [file] };
	const app = await createApplication(options);
	cleanups.push(() => app.close());
	expect((await app.command("/dynamic-file-command")).message).toBe("first");
	await writeFile(file, source("second"));
	await app.reload();
	expect((await app.command("/dynamic-file-command")).message).toBe("second");
	await writeFile(file, 'export default {name:"dynamic-file"};');
	await app.reload();
	expect(app.commands().some((command) => command.name === "dynamic-file-command")).toBe(false);
});

test("runtime event subscriptions and removable hooks use the existing Durable tool lifecycle", async () => {
	const completed: string[] = [];
	let stopEvents = () => {},
		stopHook = () => {};
	const f = await fixture({
		extensions: [
			{
				name: "runtime-events",
				activate(context) {
					context.registerTool(
						defineTool({
							name: "event_tool",
							description: "Tool for lifecycle checks",
							parameters: Type.Object({ text: Type.String() }),
							async execute(args) {
								return { output: [{ type: "text", text: args.text }] };
							},
						}),
					);
					stopHook = context.registerHook(
						hook(ToolTask, {
							beforeTool(call) {
								return { arguments: { ...call.arguments, text: "changed" } };
							},
						}),
					);
					stopEvents = context.on("tool_execution_end", (_current, event) => {
						completed.push(event.toolName);
					});
				},
			},
		],
	});
	f.provider.setResponses([
		fauxAssistantMessage(fauxToolCall("event_tool", { text: "original" }), { stopReason: "toolUse" }),
		fauxAssistantMessage("First complete"),
		fauxAssistantMessage(fauxToolCall("event_tool", { text: "original" }), { stopReason: "toolUse" }),
		fauxAssistantMessage("Second complete"),
	]);
	await f.app.run("First run");
	await vi.waitFor(() => expect(completed).toEqual(["event_tool"]));
	expect(messages(await f.app.snapshot())).toContainEqual(
		expect.objectContaining({ role: "toolResult", content: [{ type: "text", text: "changed" }] }),
	);
	stopEvents();
	stopEvents();
	stopHook();
	stopHook();
	await f.app.run("Second run");
	await f.app.close();
	expect(completed).toEqual(["event_tool"]);
	expect(stopEvents).not.toThrow();
	expect(stopHook).not.toThrow();
});

test("input hooks chain text and image changes, can consume input, and report a failed hook without losing input", async () => {
	const observed: unknown[] = [],
		reported: unknown[] = [];
	const f = await fixture({
		onReport: (error) => {
			reported.push(error);
		},
		extensions: [
			{
				name: "rewrite",
				onInput(_context, event) {
					observed.push([event.text, event.images?.length, event.source]);
					return { action: "transform", text: `Changed: ${event.text}` };
				},
			},
			{
				name: "drop-image",
				onInput(_context, event) {
					observed.push([event.text, event.images?.length]);
					return { action: "transform", text: event.text, images: [] };
				},
			},
			{
				name: "fault",
				onInput() {
					throw new Error("Input hook failed");
				},
			},
			{
				name: "consume",
				onInput(_context, event) {
					return event.text.includes("consume") ? { action: "handled" } : { action: "continue" };
				},
			},
		],
	});
	f.provider.setResponses([fauxAssistantMessage("Received transformed input")]);
	expect(await f.app.submit("consume this")).toBeUndefined();
	expect(messages(await f.app.snapshot())).toEqual([]);
	expect(f.provider.state.callCount).toBe(0);
	await f.app.run([
		{ type: "text", text: "original" },
		{ type: "image", mimeType: "image/png", data: "unused" },
	]);
	expect(observed.slice(-2)).toEqual([
		["original", 1, "extension"],
		["Changed: original", 1],
	]);
	expect(messages(await f.app.snapshot()).find((message) => message.role === "user")?.content).toBe(
		"Changed: original",
	);
	expect(reported).toHaveLength(2);
});

test("session-operation gates cancel before allocating sessions, forks or tree branches", async () => {
	const events: string[] = [];
	const f = await fixture({
		backend: "sqlite",
		extensions: [
			{
				name: "gates",
				beforeSessionSwitch(_context, event) {
					events.push(event.reason);
					return { cancel: true };
				},
				beforeFork(_context, event) {
					events.push(event.clone ? "clone" : "fork");
					return { cancel: true };
				},
				beforeTree(_context, event) {
					events.push(`tree:${event.entriesToSummarize.length}`);
					return { cancel: true };
				},
			},
		],
	});
	f.provider.setResponses([fauxAssistantMessage("First"), fauxAssistantMessage("Second")]);
	await f.app.run("One");
	await f.app.run("Two");
	const before = await f.app.snapshot(),
		files = await listSessions(f.home, f.cwd);
	const target = before.view.entries.find((entry) => entry.model?.some((message) => message.role === "assistant"));
	if (!target) throw new Error("Missing target");
	for (const command of ["/new", "/resume absent.sqlite", "/fork", "/clone", `/tree entry:${target.id}`])
		expect(await f.app.command(command)).toEqual({ cancelled: true });
	expect((await listSessions(f.home, f.cwd)).map((file) => file.path)).toEqual(files.map((file) => file.path));
	expect((await f.app.snapshot()).view).toEqual(before.view);
	expect(events).toEqual(["new", "resume", "fork", "clone", "tree:2"]);
});

test.each(["sqlite", "jsonl"] as const)("entry labels survive %s reopening and can be removed", async (backend) => {
	const f = await fixture({ backend });
	f.provider.setResponses([fauxAssistantMessage("Labeled answer")]);
	await f.app.run("Label this");
	const state = await f.app.snapshot(),
		entry = state.view.entries.at(-1);
	if (!entry) throw new Error("Missing entry");
	await f.app.setLabel(entry.id, "  checkpoint  ");
	expect(await f.app.getLabel(entry.id)).toBe("checkpoint");
	await f.app.close();
	const app = await reopen({ ...f.options, sessionFile: state.sessionFile });
	expect(await app.getLabel(entry.id)).toBe("checkpoint");
	await app.setLabel(entry.id, undefined);
	expect(await app.getLabel(entry.id)).toBeUndefined();
});

test("tree summaries preserve the abandoned branch, record usage and become durable target context", async () => {
	const f = await fixture({ backend: "sqlite" });
	f.provider.setResponses([
		fauxAssistantMessage("First answer"),
		fauxAssistantMessage("Work being left"),
		fauxAssistantMessage("## Progress\nPreserved branch work"),
	]);
	await f.app.run("First question");
	await f.app.run("Second question");
	const before = await f.app.snapshot(),
		source = f.app.conversation.id;
	const firstAnswer = before.view.entries.find((entry) => entry.model?.some((message) => message.role === "assistant"));
	if (!firstAnswer) throw new Error("Missing branch point");
	await f.app.command(`/tree entry:${firstAnswer.id} --summarize preserve paths`);
	const after = await f.app.snapshot();
	expect(after.view.entries.at(-1)).toMatchObject({
		kind: "arc.branch-summary",
		data: { summary: "## Progress\nPreserved branch work" },
	});
	expect(messages(after).at(-1)).toMatchObject({
		role: "user",
		content: expect.stringContaining("Preserved branch work"),
	});
	expect(f.provider.state.callCount).toBe(3);
	expect((await f.app.harness.usage(context)).models["faux/alpha"].totalTokens).toBeGreaterThan(0);
	await f.app.command(`/tree ${source}`);
	expect((await f.app.snapshot()).view.entries).toEqual(before.view.entries);
	const file = before.sessionFile;
	await f.app.close();
	const reopened = await reopen({ ...f.options, sessionFile: file });
	expect((await reopened.command("/tree")).message?.split("\n")).toHaveLength(2);
});

test("an extension can provide a branch summary without a provider call and abort can cancel preparation", async () => {
	let pause = false;
	const entered = Promise.withResolvers<void>();
	const f = await fixture({
		extensions: [
			{
				name: "summary",
				async beforeTree(_context, event) {
					if (!pause) return { summary: "Extension summary" };
					entered.resolve();
					await new Promise<void>((_resolve, reject) =>
						event.signal.addEventListener("abort", () => reject(event.signal.reason), { once: true }),
					);
				},
			},
		],
	});
	f.provider.setResponses([fauxAssistantMessage("One"), fauxAssistantMessage("Two")]);
	await f.app.run("First");
	await f.app.run("Second");
	const state = await f.app.snapshot(),
		first = state.view.entries.find((entry) => entry.kind === "arc.assistant");
	if (!first) throw new Error("Missing target");
	await f.app.command(`/tree entry:${first.id} --summarize`);
	expect((await f.app.snapshot()).view.entries.at(-1)?.data).toMatchObject({ summary: "Extension summary" });
	expect(f.provider.state.callCount).toBe(2);
	pause = true;
	const before = await f.app.snapshot();
	const operation = f.app.command(`/tree entry:${state.view.entries[0].id} --summarize`);
	const rejected = expect(operation).rejects.toThrow("Operation cancelled");
	await entered.promise;
	await f.app.abort();
	await rejected;
	expect((await f.app.snapshot()).view).toEqual(before.view);
});

test.each(["failure", "abort"] as const)("a branch-summary provider %s leaves navigation unchanged", async (mode) => {
	const entered = Promise.withResolvers<void>();
	const f = await fixture();
	f.provider.setResponses([
		fauxAssistantMessage("One"),
		fauxAssistantMessage("Two"),
		async (_transcript, options) => {
			entered.resolve();
			if (mode === "failure") throw new Error("Fixture summary failure");
			await new Promise<void>((_resolve, reject) =>
				options?.signal?.addEventListener("abort", () => reject(options.signal?.reason), { once: true }),
			);
			return fauxAssistantMessage("Should not be stored");
		},
	]);
	await f.app.run("First");
	await f.app.run("Second");
	const before = await f.app.snapshot(),
		target = before.view.entries.find((entry) => entry.kind === "arc.assistant");
	if (!target) throw new Error("Missing target");
	const operation = f.app.command(`/tree entry:${target.id} --summarize`);
	const rejected = expect(operation).rejects.toThrow(
		mode === "failure" ? "Fixture summary failure" : /cancelled|aborted/i,
	);
	await entered.promise;
	if (mode === "abort") {
		expect((await f.app.snapshot()).busy).toBe(true);
		await f.app.abort();
	}
	await rejected;
	expect((await f.app.snapshot()).view).toEqual(before.view);
	expect((await f.app.snapshot()).busy).toBe(false);
});

async function reopen(options: ApplicationOptions): Promise<Application> {
	const app = await createApplication(options);
	cleanups.push(() => app.close());
	return app;
}

test("the public SDK runs all four default tools against the project and returns the final visible answer", async () => {
	const f = await fixture();
	f.provider.setResponses([
		fauxAssistantMessage(fauxToolCall("write", { path: "sample.txt", content: "before\n" }), { stopReason: "toolUse" }),
		fauxAssistantMessage(fauxToolCall("read", { path: "sample.txt" }), { stopReason: "toolUse" }),
		fauxAssistantMessage(
			fauxToolCall("edit", { path: "sample.txt", edits: [{ oldText: "before", newText: "after" }] }),
			{ stopReason: "toolUse" },
		),
		fauxAssistantMessage(fauxToolCall("bash", { command: "printf 'shell-result' > shell.txt", timeout: 3 }), {
			stopReason: "toolUse",
		}),
		fauxAssistantMessage([
			fauxThinking("Internal calculation"),
			fauxText("Changed the file."),
			fauxText("Verified the shell."),
		]),
	]);
	expect(await f.app.run("Make the local change and check the shell.")).toEqual({
		status: "done",
		text: "Changed the file.\nVerified the shell.",
	});
	expect(await readFile(join(f.cwd, "sample.txt"), "utf8")).toBe("after\n");
	expect(await readFile(join(f.cwd, "shell.txt"), "utf8")).toBe("shell-result");
	const state = await f.app.snapshot();
	const results = messages(state).filter((message) => message.role === "toolResult");
	expect(results.map((result) => ({ name: result.toolName, isError: result.isError }))).toEqual([
		{ name: "write", isError: false },
		{ name: "read", isError: false },
		{ name: "edit", isError: false },
		{ name: "bash", isError: false },
	]);
	expect(results.find((result) => result.toolName === "read")?.content).toEqual([{ type: "text", text: "before\n" }]);
	expect(state.busy).toBe(false);
	expect(Object.values(state.usage.models).reduce((total, usage) => total + usage.totalTokens, 0)).toBeGreaterThan(0);
});

test("edit previews use the tool environment and matching rules without changing the file", async () => {
	const target = await mkdtemp(join(tmpdir(), "arc-preview-env-"));
	cleanups.push(() => rm(target, { recursive: true, force: true }));
	const env = new NodeExecutionEnv({ cwd: target });
	const f = await fixture({ env: () => env });
	const original = "\ufefffirst\r\nold text\r\nlast\r\n";
	await writeFile(join(target, "file.txt"), original);
	await writeFile(join(f.cwd, "file.txt"), "Different local file\n");
	const input = { path: "file.txt", edits: [{ oldText: "old text", newText: "new text" }] };
	const preview = await f.app.previewEdit(input);
	expect(preview).toEqual({ diff: " 1 first\n-2 old text\n+2 new text\n 3 last", firstChangedLine: 2 });
	expect(await readFile(join(target, "file.txt"), "utf8")).toBe(original);
	await expect(f.app.previewEdit({ ...input, edits: [{ oldText: "missing", newText: "bad" }] })).rejects.toThrow();
	expect(await readFile(join(target, "file.txt"), "utf8")).toBe(original);
	f.provider.setResponses([
		fauxAssistantMessage(fauxToolCall("edit", input), { stopReason: "toolUse" }),
		fauxAssistantMessage("Edited."),
	]);
	await f.app.run("Apply the previewed edit.");
	const result = messages(await f.app.snapshot()).find((message) => message.role === "toolResult");
	expect(result?.role === "toolResult" && result.details).toMatchObject(preview);
	expect(await readFile(join(target, "file.txt"), "utf8")).toBe(original.replace("old text", "new text"));
	expect(await readFile(join(f.cwd, "file.txt"), "utf8")).toBe("Different local file\n");
});

test("model, thinking, and tool commands change the next model request and failed commands leave those controls unchanged", async () => {
	const f = await fixture();
	const requests: { model: string; reasoning: string | undefined; tools: string[] }[] = [];
	f.provider.setResponses([
		(transcript, options, _state, model) => {
			requests.push({
				model: model.id,
				reasoning: options?.reasoning,
				tools: getCurrentTools(transcript.messages).map((tool) => tool.name),
			});
			return fauxAssistantMessage("Configured.");
		},
	]);
	expect((await f.app.command("/model")).message).toBe("faux/alpha\nfaux/beta\nfaux/plain");
	await f.app.command("/model faux/beta");
	await f.app.command("/thinking high");
	await f.app.command("/tools read,edit");
	for (const command of [
		"/model unknown/model",
		"/tools imaginary",
		"/thinking impossible",
		"/tree 999999",
		"/fork 999999",
		"/settings fullscreen maybe",
		"/import",
		"/logout",
		"/unknown",
	])
		await expect(f.app.command(command)).rejects.toThrow();
	expect((await f.app.snapshot()).agent).toMatchObject({
		model: { provider: "faux", modelId: "beta" },
		thinkingLevel: "high",
	});
	expect((await f.app.command("/tools")).message).toBe("read\nedit");
	expect(await f.app.run("Use the selected controls.")).toEqual({ status: "done", text: "Configured." });
	expect(requests).toEqual([{ model: "beta", reasoning: "high", tools: ["read", "edit"] }]);
	await f.app.command("/model faux/plain");
	await expect(f.app.command("/thinking high")).rejects.toThrow("off");
	await f.app.command("/thinking off");
	expect((await f.app.snapshot()).agent.thinkingLevel).toBe("off");
	await expect(f.app.submit(" \n")).rejects.toThrow("Input is empty");
	expect(await f.app.command("/quit")).toEqual({ quit: true });
});

test("an application without a model gives an actionable error and accepts a model registered later", async () => {
	const models = createModels();
	const f = await fixture({ models, model: undefined });
	await expect(f.app.submit("No model yet")).rejects.toThrow("Select a model");
	expect(messages(await f.app.snapshot())).toEqual([]);
	models.setProvider(f.provider.provider);
	f.provider.setResponses([fauxAssistantMessage("Model connected")]);
	await f.app.command("/model faux/alpha");
	expect(await f.app.run("The model is available now")).toEqual({ status: "done", text: "Model connected" });
});

test("resource commands prepare editor input and the caller chooses when to submit it", async () => {
	const f = await fixture();
	const prompt = join(f.directory, "review.md");
	const skill = join(f.directory, "SKILL.md");
	await writeFile(prompt, "Review $1 for defects.");
	await writeFile(skill, "---\nname: inspect\ndescription: Inspect a patch\n---\nRead the patch before reviewing.");
	const app = await reopen({
		...f.options,
		storage: new MemoryStorage(),
		resources: {
			contextFiles: [],
			prompts: [{ name: "review", description: "Review a path", path: prompt, content: "Review $1 for defects." }],
			skills: [{ name: "inspect", description: "Inspect a patch", path: skill }],
			extensionFiles: [],
		},
	});
	expect(app.commands()).toContainEqual({ name: "review", description: "Review a path" });
	expect(app.commands()).toContainEqual({ name: "skill:inspect", description: "Inspect a patch" });
	const editor = await app.command('/review "file with spaces.ts"');
	expect(editor).toEqual({ editorText: "Review file with spaces.ts for defects." });
	expect((await app.command("/skill:inspect current patch")).editorText).toContain(JSON.stringify(skill));
	expect(f.provider.state.callCount).toBe(0);
	f.provider.setResponses([fauxAssistantMessage("Review complete")]);
	expect(await app.run(editor.editorText ?? "")).toEqual({ status: "done", text: "Review complete" });
	expect(messages(await app.snapshot()).find((message) => message.role === "user")?.content).toBe(
		"Review file with spaces.ts for defects.",
	);
});

test("fork, tree, clone, and new preserve the selected history boundaries", async () => {
	const f = await fixture();
	f.provider.setResponses([
		fauxAssistantMessage("First answer"),
		fauxAssistantMessage("Second answer"),
		fauxAssistantMessage("Branch answer"),
	]);
	await f.app.run("First question");
	const firstState = await f.app.snapshot();
	const root = f.app.conversation.id;
	const boundary = firstState.view.entries.findLast((entry) =>
		entry.model?.some((message) => message.role === "assistant"),
	);
	if (boundary === undefined) throw new Error("First answer did not create an entry");
	await f.app.run("Second question");
	await f.app.command(`/fork ${boundary.id}`);
	const fork = f.app.conversation.id;
	const forked = await f.app.snapshot();
	expect(forked.view.conversation.parent).toEqual({ conversationId: root, at: boundary.id });
	expect(
		messages(forked)
			.filter((message) => message.role === "user")
			.map((message) => message.content),
	).toEqual(["First question"]);
	await f.app.run("Branch question");
	await f.app.command(`/tree ${root}`);
	expect(
		messages(await f.app.snapshot())
			.filter((message) => message.role === "user")
			.map((message) => message.content),
	).toEqual(["First question", "Second question"]);
	await f.app.command("/clone");
	const clone = f.app.conversation.id;
	const cloned = await f.app.snapshot();
	expect(cloned.view.conversation.parent?.conversationId).toBe(root);
	expect(
		messages(cloned)
			.filter((message) => message.role === "user")
			.map((message) => message.content),
	).toEqual(["First question", "Second question"]);
	await f.app.command("/new");
	const fresh = f.app.conversation.id;
	expect(messages(await f.app.snapshot())).toEqual([]);
	expect((await f.app.snapshot()).view.conversation.parent).toBeUndefined();
	expect((await f.app.command("/tree")).message?.split("\n")).toEqual([
		`${root}`,
		`${fork} <- ${root}`,
		`${clone} <- ${root}`,
		`${fresh} *`,
	]);
});

test("entry navigation reuses a branch tip, forks a historical answer, and restores user text before its entry", async () => {
	const f = await fixture();
	f.provider.setResponses([
		fauxAssistantMessage("First navigation answer"),
		fauxAssistantMessage("Second navigation answer"),
	]);
	await f.app.run("First navigation question");
	const first = await f.app.snapshot();
	const root = f.app.conversation.id;
	const answer = first.view.entries.findLast((entry) => entry.model?.some((message) => message.role === "assistant"));
	const user = first.view.entries.find((entry) => entry.model?.some((message) => message.role === "user"));
	if (!answer || !user) throw new Error("Missing navigation entries");
	await f.app.run("Second navigation question");
	const final = (await f.app.snapshot()).view.entries.at(-1);
	if (!final) throw new Error("Missing root tip");
	await f.app.command(`/tree entry:${answer.id}`);
	expect(f.app.conversation.id).not.toBe(root);
	expect(
		messages(await f.app.snapshot())
			.filter((message) => message.role === "user")
			.map((message) => message.content),
	).toEqual(["First navigation question"]);
	const branches = (await f.app.command("/tree")).message;
	expect(await f.app.command(`/tree entry:${answer.id}`)).toEqual({ message: "Already at this point" });
	expect((await f.app.command("/tree")).message).toBe(branches);
	await f.app.command(`/tree entry:${final.id}`);
	expect(f.app.conversation.id).toBe(root);
	const result = await f.app.command(`/tree entry:${user.id}`);
	expect(result.editorText).toBe("First navigation question");
	expect(messages(await f.app.snapshot()).filter((message) => message.role === "user")).toEqual([]);
	await expect(f.app.command("/tree entry:99999999")).rejects.toThrow("Unknown entry");
	expect(f.provider.state.callCount).toBe(2);
});

test("export and import preserve model history without replaying recorded file writes", async () => {
	const f = await fixture();
	f.provider.setResponses([
		fauxAssistantMessage(fauxToolCall("write", { path: "receipt.txt", content: "original" }), {
			stopReason: "toolUse",
		}),
		fauxAssistantMessage("Saved answer"),
		(transcript) => {
			expect(
				transcript.messages.some((message) => message.role === "user" && message.content === "Saved question"),
			).toBe(true);
			return fauxAssistantMessage("Continued answer");
		},
	]);
	await f.app.run("Saved question");
	await f.app.command("/export archive.json");
	const source = await readFile(join(f.cwd, "archive.json"), "utf8");
	expect(importTranscript(source).map((message) => message.role)).toEqual([
		"user",
		"system",
		"assistant",
		"toolResult",
		"assistant",
	]);
	await writeFile(join(f.cwd, "receipt.txt"), "external edit");
	const previous = f.app.conversation.id;
	expect((await f.app.command("/import archive.json")).message).toBe("Imported 5 messages");
	expect(f.app.conversation.id).not.toBe(previous);
	expect(messages(await f.app.snapshot()).map((message) => message.role)).toEqual([
		"user",
		"system",
		"assistant",
		"toolResult",
		"assistant",
	]);
	expect(await readFile(join(f.cwd, "receipt.txt"), "utf8")).toBe("external edit");
	expect(await f.app.run("Continue this conversation.")).toEqual({ status: "done", text: "Continued answer" });
	expect(await readFile(join(f.cwd, "receipt.txt"), "utf8")).toBe("external edit");
	await writeFile(join(f.cwd, "bad.json"), '{"format":"wrong"}');
	const imported = f.app.conversation.id;
	await expect(f.app.command("/import bad.json")).rejects.toThrow("malformed");
	expect(f.app.conversation.id).toBe(imported);
});

test("SQLite sessions reject a second owner, release their lock on close, and reopen persisted state", async () => {
	const f = await fixture({ backend: "sqlite" });
	const file = (await f.app.snapshot()).sessionFile;
	if (file === undefined) throw new Error("Persistent session did not get a filename");
	f.provider.setResponses([
		fauxAssistantMessage("Persisted answer"),
		fauxAssistantMessage("Owner still usable"),
		fauxAssistantMessage("Reopened answer"),
	]);
	await f.app.command("/model faux/beta");
	await f.app.command("/thinking high");
	await f.app.command("/tools read");
	await f.app.command("/name Fixture session");
	await f.app.run("Persisted question");
	await expect(createApplication({ ...f.options, sessionFile: file })).rejects.toThrow(
		`Session is already open: ${file}`,
	);
	expect(await f.app.run("Still the owner")).toEqual({ status: "done", text: "Owner still usable" });
	await f.app.close();
	const reopened = await reopen({ ...f.options, sessionFile: file, model: undefined });
	const state = await reopened.snapshot();
	expect(state.agent).toMatchObject({ model: { provider: "faux", modelId: "beta" }, thinkingLevel: "high" });
	expect(state.agent.tools.map((tool) => tool.name)).toEqual(["read"]);
	expect(
		messages(state)
			.filter((message) => message.role === "user")
			.map((message) => message.content),
	).toEqual(["Persisted question", "Still the owner"]);
	expect(JSON.parse((await reopened.command("/session")).message ?? "null")).toMatchObject({
		name: "Fixture session",
		file,
	});
	expect((await reopened.command("/resume")).message).toContain(file);
	expect(await reopened.run("After reopening")).toEqual({ status: "done", text: "Reopened answer" });
	await reopened.command("/new");
	const next = (await reopened.snapshot()).sessionFile;
	expect(next).not.toBe(file);
	expect(messages(await reopened.snapshot())).toEqual([]);
	await reopened.command(`/resume ${file}`);
	expect((await reopened.snapshot()).sessionFile).toBe(file);
	expect(
		messages(await reopened.snapshot()).some(
			(message) => message.role === "user" && message.content === "After reopening",
		),
	).toBe(true);
});

test("subscriptions report live and settled states and unsubscribe before application close", async () => {
	const f = await fixture();
	const entered = Promise.withResolvers<void>();
	const finish = Promise.withResolvers<void>();
	f.provider.setResponses([
		async () => {
			entered.resolve();
			await finish.promise;
			return fauxAssistantMessage("Observed answer");
		},
	]);
	const states: ApplicationState[] = [];
	const unsubscribe = f.app.subscribe((state) => states.push(state));
	expect(states.map((state) => state.busy)).toEqual([false]);
	const run = f.app.run("Observe this request");
	try {
		await entered.promise;
		await vi.waitFor(() => expect(states.some((state) => state.busy)).toBe(true));
	} finally {
		finish.resolve();
	}
	expect(await run).toEqual({ status: "done", text: "Observed answer" });
	expect(states.at(-1)?.busy).toBe(false);
	expect(
		states.at(-1)?.view.entries.some((entry) => entry.model?.some((message) => message.role === "assistant")),
	).toBe(true);
	unsubscribe();
	const count = states.length;
	await f.app.command("/thinking low");
	await f.app.snapshot();
	expect(states.length).toBe(count);
	const closing = f.app.close();
	expect(f.app.close()).toBe(closing);
	await closing;
	await expect(f.app.snapshot()).rejects.toThrow("Application is closed");
	await expect(f.app.command("/help")).rejects.toThrow("Application is closed");
	if (f.storage === undefined) throw new Error("Expected injected storage");
	await expect(f.storage.mintId()).rejects.toThrow("closed");
});

test.skipIf(process.platform === "win32")(
	"a session symlink cannot acquire a second owner of the same SQLite file",
	async () => {
		const f = await fixture({ backend: "sqlite" });
		const file = (await f.app.snapshot()).sessionFile;
		if (file === undefined) throw new Error("Persistent session did not get a filename");
		const alias = join(f.directory, "session-alias.sqlite");
		await symlink(file, alias);
		const attempt = createApplication({ ...f.options, sessionFile: alias }).then((app) => {
			cleanups.push(() => app.close());
			return app;
		});
		await expect(attempt).rejects.toThrow("already open");
		f.provider.setResponses([fauxAssistantMessage("Original owner works")]);
		expect(await f.app.run("Keep using the original owner")).toEqual({ status: "done", text: "Original owner works" });
	},
);

test.each(["new", "clone", "fork"])("a rejected busy /%s does not create an orphan conversation", async (command) => {
	const f = await fixture();
	const entered = Promise.withResolvers<void>();
	f.provider.setResponses([
		fauxAssistantMessage("Seed answer"),
		async (_transcript, options) => {
			entered.resolve();
			const signal = options?.signal;
			if (signal === undefined) throw new Error("Request has no cancellation signal");
			await new Promise<void>((resolve) => {
				if (signal.aborted) resolve();
				else signal.addEventListener("abort", () => resolve(), { once: true });
			});
			return fauxAssistantMessage("Cancelled", { stopReason: "aborted" });
		},
	]);
	await f.app.run("Seed question");
	const boundary = (await f.app.snapshot()).view.entries.at(-1);
	if (boundary === undefined) throw new Error("Seed answer did not create an entry");
	const before = (await f.app.command("/tree")).message;
	const submission = await f.app.submit("Wait until cancelled");
	if (!submission) throw new Error("Input was unexpectedly handled");
	try {
		await entered.promise;
		await expect(f.app.command(`/${command}${command === "fork" ? ` ${boundary.id}` : ""}`)).rejects.toThrow(
			"Abort current work",
		);
		expect((await f.app.command("/tree")).message).toBe(before);
	} finally {
		await f.app.abort();
	}
	expect((await submission.wait(f.app.context)).status).toBe("unanswered");
});

test("an initial subscriber exception is reported without stopping other subscribers", async () => {
	const reports: unknown[] = [];
	const f = await fixture({ onReport: (error) => reports.push(error) });
	const failure = new Error("Subscriber failed");
	let unsubscribe = () => {};
	expect(() => {
		unsubscribe = f.app.subscribe(() => {
			throw failure;
		});
	}).not.toThrow();
	const states: ApplicationState[] = [];
	const stop = f.app.subscribe((state) => states.push(state));
	await f.app.command("/thinking low");
	expect(states.at(-1)?.agent.thinkingLevel).toBe("low");
	expect(reports).toContain(failure);
	unsubscribe();
	stop();
});

test("constructor failure closes admitted storage and releases its session lock", async () => {
	const f = await fixture();
	const file = join(f.directory, "failed.sqlite");
	const storage = new MemoryStorage();
	const failure = new Error("Constructor cancelled");
	await expect(
		createApplication({
			...f.options,
			sessionFile: file,
			storage,
			context: withAbortSignal(AbortSignal.abort(failure), context),
		}),
	).rejects.toThrow("Constructor cancelled");
	await expect(storage.mintId()).rejects.toThrow("closed");
	const recovered = await reopen({ ...f.options, storage: undefined, backend: "sqlite", sessionFile: file });
	expect((await recovered.snapshot()).sessionFile).toBe(file);
});

test("close cancels active model work before closing the owned storage", async () => {
	const f = await fixture();
	const entered = Promise.withResolvers<void>();
	let cancelled = false;
	f.provider.setResponses([
		async (_transcript, options) => {
			const signal = options?.signal;
			if (signal === undefined) throw new Error("Request has no cancellation signal");
			entered.resolve();
			await new Promise<void>((resolve) => {
				const finish = () => {
					cancelled = signal.aborted;
					resolve();
				};
				if (signal.aborted) finish();
				else signal.addEventListener("abort", finish, { once: true });
			});
			return fauxAssistantMessage("Cancelled", { stopReason: "aborted" });
		},
	]);
	await f.app.submit("Wait for close");
	await entered.promise;
	await f.app.close();
	expect(cancelled).toBe(true);
	if (f.storage === undefined) throw new Error("Expected injected storage");
	await expect(f.storage.mintId()).rejects.toThrow("closed");
});

test("file extension commands reload atomically and invalid replacements leave the previous command available", async () => {
	const f = await fixture();
	const path = join(f.directory, "commands.ts");
	const code = (command: string, label: string) =>
		`export default { name: "fixture-commands", commands: [{ name: ${JSON.stringify(command)}, description: "Fixture command", execute(args, app) { return { message: ${JSON.stringify(label)} + " " + args + " " + app.cwd }; } }] };`;
	await writeFile(path, code("greet", "First"));
	const app = await reopen({
		...f.options,
		storage: new MemoryStorage(),
		extensionFiles: [path],
		extensions: [
			{
				name: "fixed-command",
				commands: [{ name: "fixed", description: "Fixed command", execute: () => ({ message: "Fixed response" }) }],
			},
		],
	});
	expect(await app.command("/greet reader")).toEqual({ message: `First reader ${f.cwd}` });
	expect(app.commands()).toContainEqual({ name: "greet", description: "Fixture command" });
	await writeFile(path, code("quit", "Rejected"));
	await expect(app.reload()).rejects.toThrow("reserved");
	expect(await app.command("/greet reader")).toEqual({ message: `First reader ${f.cwd}` });
	await writeFile(path, code("invalid command", "Rejected invalid name"));
	await expect(app.reload()).rejects.toThrow("Invalid extension command");
	expect(await app.command("/fixed")).toEqual({ message: "Fixed response" });
	expect(await app.command("/greet reader")).toEqual({ message: `First reader ${f.cwd}` });
	await writeFile(path, code("salute", "Second"));
	await app.reload();
	expect(await app.command("/salute reader")).toEqual({ message: `Second reader ${f.cwd}` });
	await expect(app.command("/greet reader")).rejects.toThrow("Unknown command");
});

test("provider contributions restore the borrowed registration on close and constructor failure", async () => {
	const f = await fixture();
	const original = fauxProvider({ provider: "borrowed", models: [{ id: "original" }] });
	const replacement = fauxProvider({ provider: "borrowed", models: [{ id: "replacement" }] });
	f.models.setProvider(original.provider);
	const extension = { name: "borrowed-provider", providers: [replacement.provider] };
	const options = {
		...f.options,
		storage: new MemoryStorage(),
		extensions: [extension],
		model: { provider: "borrowed", modelId: "replacement" },
	};
	const app = await reopen(options);
	replacement.setResponses([fauxAssistantMessage("Extension provider response")]);
	expect(await app.run("Use the contributed provider")).toEqual({
		status: "done",
		text: "Extension provider response",
	});
	expect(f.models.getProvider("borrowed")).toBe(replacement.provider);
	await app.close();
	expect(f.models.getProvider("borrowed")).toBe(original.provider);
	await expect(
		createApplication({
			...options,
			storage: new MemoryStorage(),
			context: withAbortSignal(AbortSignal.abort(new Error("Provider setup cancelled")), context),
		}),
	).rejects.toThrow("Provider setup cancelled");
	expect(f.models.getProvider("borrowed")).toBe(original.provider);
	original.setResponses([fauxAssistantMessage("Original provider response")]);
	await f.app.command("/model borrowed/original");
	expect(await f.app.run("Use the restored provider")).toEqual({ status: "done", text: "Original provider response" });
});

test("an external provider replacement remains registered when the application closes", async () => {
	const f = await fixture();
	const owned = fauxProvider({ provider: "shared", models: [{ id: "owned" }] });
	const external = fauxProvider({ provider: "shared", models: [{ id: "external" }] });
	const app = await reopen({
		...f.options,
		storage: new MemoryStorage(),
		extensions: [{ name: "shared-provider", providers: [owned.provider] }],
	});
	expect(f.models.getProvider("shared")).toBe(owned.provider);
	f.models.setProvider(external.provider);
	external.setResponses([fauxAssistantMessage("External provider response")]);
	await app.close();
	expect(f.models.getProvider("shared")).toBe(external.provider);
	await f.app.command("/model shared/external");
	expect(await f.app.run("Use the caller's replacement")).toEqual({
		status: "done",
		text: "External provider response",
	});
});

test("removing provider contributions on file reload restores previous registrations and removes newly owned ones", async () => {
	const f = await fixture();
	const original = fauxProvider({ provider: "file-provider", models: [{ id: "original" }] });
	f.models.setProvider(original.provider);
	const path = join(f.directory, "providers.ts");
	const aiModule = fileURLToPath(new URL("../../ai/src/index.ts", import.meta.url));
	await writeFile(
		path,
		`import { fauxProvider, fauxAssistantMessage } from ${JSON.stringify(aiModule)};
const replacement = fauxProvider({ provider: "file-provider", models: [{ id: "provided" }] });
replacement.setResponses([fauxAssistantMessage("File provider response")]);
const added = fauxProvider({ provider: "temporary-provider", models: [{ id: "temporary" }] });
export default { name: "file-providers", providers: [replacement.provider, added.provider] };`,
	);
	const app = await reopen({
		...f.options,
		storage: new MemoryStorage(),
		extensionFiles: [path],
		model: { provider: "file-provider", modelId: "provided" },
	});
	expect(await app.run("Use the file provider")).toEqual({ status: "done", text: "File provider response" });
	expect(f.models.getModel("temporary-provider", "temporary")).toMatchObject({
		provider: "temporary-provider",
		id: "temporary",
	});
	await writeFile(path, 'export default { name: "file-providers", providers: [] };');
	await app.reload();
	expect(f.models.getProvider("file-provider")).toBe(original.provider);
	expect(f.models.getProvider("temporary-provider")).toBeUndefined();
	original.setResponses([fauxAssistantMessage("Restored after reload")]);
	await app.command("/model file-provider/original");
	expect(await app.run("Use the restored file provider")).toEqual({ status: "done", text: "Restored after reload" });
});

test("model cycling follows the chosen order and only saves scope when requested", async () => {
	const f = await fixture();
	await f.app.command("/scoped-models faux/beta,faux/alpha");
	expect((await f.app.snapshot()).enabledModels).toEqual(["faux/beta", "faux/alpha"]);
	await f.app.cycleModel();
	expect((await f.app.snapshot()).agent.model).toEqual({ provider: "faux", modelId: "beta" });
	await f.app.cycleModel("backward");
	expect((await f.app.snapshot()).agent.model).toEqual({ provider: "faux", modelId: "alpha" });
	await expect(readFile(join(f.home, "settings.json"))).rejects.toMatchObject({ code: "ENOENT" });
	await f.app.command("/scoped-models save");
	expect(JSON.parse(await readFile(join(f.home, "settings.json"), "utf8")).enabledModels).toEqual([
		"faux/beta",
		"faux/alpha",
	]);
	await expect(f.app.command("/scoped-models faux/absent")).rejects.toThrow("Unknown model");
	expect((await f.app.snapshot()).enabledModels).toEqual(["faux/beta", "faux/alpha"]);
});

test("model patterns apply thinking overrides before per-model settings and clamp non-reasoning models", async () => {
	const f = await fixture({
		settings: { thinkingLevel: "medium", modelThinkingLevels: { "faux/alpha": "low", "faux/beta": "high" } },
	});
	await f.app.command("/scoped-models faux/b*:low,faux/p*:high,faux/a*");
	await f.app.cycleModel();
	expect((await f.app.snapshot()).agent).toMatchObject({
		model: { provider: "faux", modelId: "beta" },
		thinkingLevel: "low",
	});
	await f.app.cycleModel();
	expect((await f.app.snapshot()).agent).toMatchObject({
		model: { provider: "faux", modelId: "plain" },
		thinkingLevel: "off",
	});
	await f.app.cycleModel();
	expect((await f.app.snapshot()).agent).toMatchObject({
		model: { provider: "faux", modelId: "alpha" },
		thinkingLevel: "low",
	});
	await f.app.command("/model faux/beta");
	expect((await f.app.snapshot()).agent.thinkingLevel).toBe("high");
	await f.app.command("/model faux/plain");
	expect((await f.app.snapshot()).agent.thinkingLevel).toBe("off");
	await expect(f.app.command("/scoped-models absent/*")).rejects.toThrow("Unknown model pattern");
	expect((await f.app.snapshot()).enabledModels).toEqual(["faux/b*:low", "faux/p*:high", "faux/a*"]);
});

test("saved per-model thinking and model patterns survive startup without replacing resumed state", async () => {
	const f = await fixture();
	await f.app.command("/thinking save high");
	await f.app.command("/scoped-models save faux/b*:low,faux/a*:high");
	expect(JSON.parse(await readFile(join(f.home, "settings.json"), "utf8"))).toMatchObject({
		modelThinkingLevels: { "faux/alpha": "high" },
		enabledModels: ["faux/b*:low", "faux/a*:high"],
	});
	const app = await reopen({ ...f.options, model: undefined, storage: undefined, backend: "sqlite" });
	expect((await app.snapshot()).agent).toMatchObject({
		model: { provider: "faux", modelId: "beta" },
		thinkingLevel: "low",
	});
	await app.command("/model faux/alpha");
	expect((await app.snapshot()).agent.thinkingLevel).toBe("high");
	await app.command("/thinking off");
	const sessionFile = (await app.snapshot()).sessionFile;
	await app.close();
	const resumed = await reopen({ ...f.options, model: undefined, storage: undefined, backend: "sqlite", sessionFile });
	expect((await resumed.snapshot()).agent.thinkingLevel).toBe("off");
});

test("HTML export escapes message markup and includes a non-executable transcript", async () => {
	const f = await fixture();
	f.provider.setResponses([fauxAssistantMessage('<script>alert("untrusted")</script>')]);
	await f.app.run("Show the markup");
	await f.app.command("/export");
	const html = await readFile(join(f.cwd, "conversation.html"), "utf8");
	expect(html).toContain("&lt;script&gt;alert(&quot;untrusted&quot;)&lt;/script&gt;");
	expect(html).not.toContain('<script>alert("untrusted")</script>');
	expect(html).toContain('type="application/json"');
	expect(html).toContain("Content-Security-Policy");
});

test("HTML export applies selected theme export colors after variable and palette resolution", async () => {
	const f = await fixture();
	const base = f.app.themes.get("dark");
	if (!base) throw new Error("Missing built-in theme");
	await mkdir(join(f.home, "themes"), { recursive: true });
	await writeFile(
		join(f.home, "themes", "exported.json"),
		JSON.stringify({
			...base.definition,
			name: "exported",
			vars: { page: "#123456" },
			export: { pageBg: "page", cardBg: 196, infoBg: "#789abc" },
		}),
	);
	await f.app.reload();
	await f.app.command("/settings theme exported");
	await f.app.command("/export themed.html");
	const html = await readFile(join(f.cwd, "themed.html"), "utf8");
	expect(html).toContain("--page-bg:#123456");
	expect(html).toContain("--card-bg:#ff0000");
	expect(html).toContain("--info-bg:#789abc");
	expect(html).toContain("color-scheme:dark");
	expect(html).toContain("Content-Security-Policy");
});

test("an explicit provider without a model takes precedence over the configured default", async () => {
	const f = await fixture({
		model: undefined,
		provider: "faux",
		settings: { model: { provider: "faux", modelId: "plain" } },
	});
	expect((await f.app.snapshot()).agent.model).toEqual({ provider: "faux", modelId: "alpha" });
});

test.each(["sqlite", "jsonl"] as const)(
	"%s cloning preserves durable history and receipts in an independent session",
	async (backend) => {
		const Shared = defineDoc({
			kind: "test.clone.shared",
			version: 1,
			scope: "session",
			initial: () => ({ value: "source" }),
			checkpointWhen: () => false,
		});
		const History = defineDoc({
			kind: "test.clone.history",
			version: 1,
			scope: "conversation",
			history: "rewindable",
			fork: "asOf",
			initial: () => ({ count: 0 }),
			checkpointWhen: () => false,
		});
		const Current = defineDoc({
			kind: "test.clone.current",
			version: 1,
			scope: "conversation",
			history: "latest",
			fork: "current",
			initial: () => ({ count: 0 }),
			checkpointWhen: () => false,
		});
		const f = await fixture({ backend });
		const root = f.app.conversation.id;
		const boundary = await f.app.harness.commit(async (tx) => {
			await tx.doc(Shared);
			(await tx.doc(History, root)).count = 1;
			(await tx.doc(Current, root)).count = 1;
			return tx.appendEntry(root, { kind: "bookmark", data: { label: "retained" } });
		}, context);
		f.provider.setResponses([fauxAssistantMessage("Source answer"), fauxAssistantMessage("Clone answer")]);
		await f.app.command("/model faux/beta");
		await f.app.command("/thinking high");
		await f.app.run("Source question");
		await f.app.harness.commit(async (tx) => {
			(await tx.doc(History, root)).count = 2;
			(await tx.doc(Current, root)).count = 2;
		}, context);
		const before = await f.app.snapshot();
		const sourceFile = before.sessionFile;
		if (!sourceFile) throw new Error("Missing source session");
		const sourceIdentity = await f.app.harness.snapshot(ProviderDoc, root, context);
		const receipts = await f.app.harness.commit(async (tx) => (await tx.scanTasks({}, 256)).items, context);
		const branches = (await f.app.command("/tree")).message;
		await f.app.command("/clone");
		const cloned = await f.app.snapshot();
		expect(cloned.sessionFile).not.toBe(sourceFile);
		expect(cloned.sessionFile?.endsWith(`.${backend}`)).toBe(true);
		expect(cloned.agent.model).toEqual({ provider: "faux", modelId: "beta" });
		expect(cloned.agent.thinkingLevel).toBe("high");
		const copiedRoot = await f.app.harness.conversation(root, context);
		expect((await copiedRoot?.agent(context))?.model).toEqual({ provider: "faux", modelId: "beta" });
		expect(cloned.view.conversation.parent?.conversationId).toBe(root);
		expect(await f.app.harness.snapshot(ProviderDoc, root, context)).not.toEqual(sourceIdentity);
		expect(await f.app.harness.snapshot(Shared, context)).toEqual({ value: "source" });
		expect(await f.app.harness.snapshot(History, f.app.conversation.id, context)).toEqual({ count: 1 });
		expect(await f.app.harness.snapshot(Current, f.app.conversation.id, context)).toEqual({ count: 2 });
		expect(await f.app.harness.snapshotAsOf(History, root, boundary.id, context)).toEqual({ count: 1 });
		expect(await f.app.harness.commit(async (tx) => (await tx.scanTasks({}, 256)).items, context)).toEqual(receipts);
		expect(f.provider.state.callCount).toBe(1);
		await f.app.harness.commit(async (tx) => {
			(await tx.doc(Shared)).value = "clone";
		}, context);
		await f.app.run("Clone question");
		expect(await f.app.harness.snapshot(ProviderDoc, f.app.conversation.id, context)).not.toEqual(sourceIdentity);
		expect(f.provider.state.callCount).toBe(2);
		const source = await reopen({ ...f.options, model: undefined, sessionFile: sourceFile });
		expect((await source.command("/tree")).message).toBe(branches);
		expect(await source.harness.snapshot(Shared, context)).toEqual({ value: "source" });
		expect(await source.harness.snapshot(History, root, context)).toEqual({ count: 2 });
		expect(
			messages(await source.snapshot())
				.filter((m) => m.role === "user")
				.map((m) => m.content),
		).toEqual(["Source question"]);
		expect(
			messages(await f.app.snapshot())
				.filter((m) => m.role === "user")
				.map((m) => m.content),
		).toEqual(["Source question", "Clone question"]);
	},
);

test.each(["sqlite", "jsonl"] as const)(
	"%s cloning rejects an unfinished task outside the active conversation without publishing a session",
	async (backend) => {
		const f = await fixture({ backend });
		f.provider.setResponses([fauxAssistantMessage("Source answer")]);
		await f.app.run("Source question");
		const blocked = defineTask<null, { phase: "wait" }, null>({
			name: "unregistered-background-work",
			version: 1,
			initial: () => ({ phase: "wait" }),
			phases: {
				wait: async () => {
					throw new Error("An unregistered task must not execute");
				},
			},
			abort: async () => {},
		});
		const conversation = await f.app.harness.createConversation({ ownership: { kind: "ownerless" } }, context);
		await f.app.harness.commit(
			(tx) =>
				tx.createTask(blocked, null, {
					conversationId: conversation.id,
					ownership: { kind: "conversation" },
					background: true,
				}),
			context,
		);
		const before = await f.app.snapshot();
		expect(before.busy).toBe(false);
		const files = (await listSessions(f.home, f.cwd)).map((s) => s.path);
		await expect(f.app.command("/clone")).rejects.toThrow("Finish or abort all session tasks");
		expect((await f.app.snapshot()).sessionFile).toBe(before.sessionFile);
		expect((await listSessions(f.home, f.cwd)).map((s) => s.path)).toEqual(files);
		expect(f.provider.state.callCount).toBe(1);
	},
);

test.each(["sqlite", "jsonl"] as const)(
	"%s reopening restores the selected branch and its agent state",
	async (backend) => {
		const f = await fixture({ backend });
		f.provider.setResponses([fauxAssistantMessage("Root answer"), fauxAssistantMessage("Branch answer")]);
		await f.app.run("Root question");
		await f.app.command("/clone");
		const branch = f.app.conversation.id;
		await f.app.command("/model faux/beta");
		await f.app.run("Branch question");
		const file = (await f.app.snapshot()).sessionFile;
		if (!file) throw new Error("Missing session file");
		await f.app.close();
		const next = await reopen({ ...f.options, model: undefined, storage: undefined, sessionFile: file });
		expect(next.conversation.id).toBe(branch);
		const state = await next.snapshot();
		expect(state.agent.model).toEqual({ provider: "faux", modelId: "beta" });
		expect(
			messages(state)
				.filter((message) => message.role === "user")
				.map((message) => message.content),
		).toEqual(["Root question", "Branch question"]);
	},
);

test("command interception cancels before allocation and permits contributed handlers to call the application", async () => {
	const calls: string[] = [];
	const f = await fixture({
		backend: "sqlite",
		mode: "rpc",
		extensions: [
			{
				name: "command-policy",
				beforeCommand(ctx, command) {
					calls.push(`first:${ctx.mode}:${command.name}`);
					return command.name === "new" ? { action: "cancel", message: "Keep this session" } : { action: "continue" };
				},
			},
			{
				name: "command-observer",
				beforeCommand(ctx, command) {
					calls.push(`second:${ctx.mode}:${command.name}`);
				},
				commands: [
					{
						name: "owned",
						description: "Change a session label",
						async execute(_args, app) {
							return app.command("/name nested-label");
						},
					},
				],
			},
		],
	});
	const before = await f.app.snapshot();
	const files = (await listSessions(f.home, f.cwd)).map((file) => file.path);
	expect(await f.app.command("/new")).toEqual({ cancelled: true, message: "Keep this session" });
	expect((await f.app.snapshot()).sessionFile).toBe(before.sessionFile);
	expect((await listSessions(f.home, f.cwd)).map((file) => file.path)).toEqual(files);
	expect(calls).toEqual(["first:rpc:new"]);
	calls.length = 0;
	await f.app.command("/owned");
	expect(calls).toEqual(["first:rpc:owned", "second:rpc:owned", "first:rpc:name", "second:rpc:name"]);
	calls.length = 0;
	await f.app.command("/abort");
	expect(await f.app.command("/quit")).toEqual({ quit: true });
	expect(calls).toEqual([]);
});

test("a throwing diagnostic callback cannot break observers or leave a session switch half-finished", async () => {
	const reports: unknown[] = [];
	const f = await fixture({
		backend: "sqlite",
		onReport(error) {
			reports.push(error);
			throw new Error("Reporter failed");
		},
	});
	expect(() =>
		f.app.subscribe(() => {
			throw new Error("Observer failed");
		}),
	).not.toThrow();
	const old = f.app.harness;
	const close = old.close.bind(old);
	vi.spyOn(old, "close").mockImplementationOnce(async (context) => {
		await close(context);
		throw new Error("Close failed after cleanup");
	});
	const source = (await f.app.snapshot()).sessionFile;
	await f.app.command("/new");
	expect((await f.app.snapshot()).sessionFile).not.toBe(source);
	f.provider.setResponses([fauxAssistantMessage("New session works")]);
	expect(await f.app.run("Continue after reporting failure")).toEqual({ status: "done", text: "New session works" });
	expect(reports.some((error) => error instanceof Error && error.message === "Close failed after cleanup")).toBe(true);
});

test("a command interceptor failure preserves selected model state", async () => {
	const f = await fixture({
		extensions: [
			{
				name: "failed-policy",
				beforeCommand(_context, command) {
					if (command.name === "model") throw new Error("Policy failed");
				},
			},
		],
	});
	await expect(f.app.command("/model faux/beta")).rejects.toThrow("Policy failed");
	expect((await f.app.snapshot()).agent.model).toEqual({ provider: "faux", modelId: "alpha" });
});

test("extension lifecycle follows startup, conversation changes, reload and shutdown", async () => {
	const events: string[] = [];
	const f = await fixture({
		extensions: [
			{
				name: "lifecycle",
				activate(context) {
					events.push(`activate:${context.state.cwd}`);
					return () => {
						events.push("cleanup");
					};
				},
				onSessionStart(_context, event) {
					events.push(`start:${event.reason}`);
				},
				onSessionShutdown(_context, event) {
					events.push(`shutdown:${event.reason}`);
				},
				onUIAttached() {
					events.push("ui:attach");
				},
				onUIDetached() {
					events.push("ui:detach");
				},
			},
		],
	});
	const { createUnavailableUI } = await import("../src/core/ui/ui.ts");
	const detach = f.app.attachUI(createUnavailableUI());
	await detach();
	await f.app.command("/new");
	await f.app.reload();
	await f.app.close();
	expect(events).toEqual([
		`activate:${f.cwd}`,
		"start:startup",
		"ui:attach",
		"ui:detach",
		"shutdown:new",
		"start:new",
		"shutdown:reload",
		"start:reload",
		"shutdown:quit",
		"cleanup",
	]);
});

test("file reload releases the old activation and removed definitions before shutdown", async () => {
	const f = await fixture();
	const file = join(f.cwd, "owned.ts"),
		log = join(f.cwd, "lifecycle.log");
	const definition = (version: number) => `import {appendFile} from "node:fs/promises";
export default { name: "owned-resources", activate: async () => { await appendFile(${JSON.stringify(log)}, "activate ${version}\\n"); return () => appendFile(${JSON.stringify(log)}, "cleanup ${version}\\n"); } };`;
	await writeFile(file, definition(1));
	await f.app.close();
	const app = await reopen({ ...f.options, storage: new MemoryStorage(), extensionFiles: [file] });
	await writeFile(file, definition(2));
	await app.reload();
	await app.close();
	expect(await readFile(log, "utf8")).toBe("activate 1\ncleanup 1\nactivate 2\ncleanup 2\n");
});

test("failing lifecycle callbacks and cleanup do not prevent other cleanup or storage close", async () => {
	const f = await fixture();
	await f.app.close();
	const storage = new MemoryStorage();
	const close = vi.spyOn(storage, "close");
	const events: string[] = [];
	const reports: unknown[] = [];
	const app = await createApplication({
		...f.options,
		storage,
		onReport: (error) => reports.push(error),
		extensions: [
			{
				name: "cleanup-failure",
				activate: () => () => {
					events.push("first");
					throw new Error("Fixture cleanup failed");
				},
				onSessionShutdown() {
					throw new Error("Fixture listener failed");
				},
			},
			{
				name: "other-cleanup",
				activate: () => () => {
					events.push("second");
				},
			},
		],
	});
	await expect(app.close()).rejects.toThrow("Application cleanup failed");
	expect(events).toEqual(["second", "first"]);
	expect(close).toHaveBeenCalledTimes(1);
	expect(reports).toContainEqual(expect.objectContaining({ message: "Fixture listener failed" }));
	await expect(app.snapshot()).rejects.toThrow("closed");
});

test("activation failure closes previously acquired resources and the backend", async () => {
	const f = await fixture();
	await f.app.close();
	const storage = new MemoryStorage();
	const close = vi.spyOn(storage, "close");
	let released = 0;
	await expect(
		createApplication({
			...f.options,
			storage,
			extensions: [
				{
					name: "acquired",
					activate: () => () => {
						released++;
					},
				},
				{
					name: "broken-activation",
					activate() {
						throw new Error("Fixture activation failed");
					},
				},
			],
		}),
	).rejects.toThrow("Extension activation or cleanup failed");
	expect(released).toBe(1);
	expect(close).toHaveBeenCalledTimes(1);
});

test("application snapshots do not mix an old agent read with a newer conversation view", async () => {
	const f = await fixture();
	const entered = Promise.withResolvers<void>(),
		release = Promise.withResolvers<void>();
	const read = f.app.conversation.agent.bind(f.app.conversation);
	let first = true;
	const spy = vi.spyOn(f.app.conversation, "agent").mockImplementation(async (context) => {
		const agent = await read(context);
		if (first) {
			first = false;
			entered.resolve();
			await release.promise;
		}
		return agent;
	});
	try {
		const snapshot = f.app.snapshot();
		await entered.promise;
		await f.app.conversation.configure({ thinkingLevel: "low" }, context);
		release.resolve();
		const state = await snapshot;
		expect(state.agent.thinkingLevel).toBe("low");
		expect(state.view.docs["arc.agent"]?.thinkingLevel).toBe("low");
	} finally {
		release.resolve();
		spy.mockRestore();
	}
});

test("task panel follows the actual Harness graph and can be detached", async () => {
	const f = await fixture();
	const entered = Promise.withResolvers<void>(),
		release = Promise.withResolvers<void>();
	f.provider.setResponses([
		async () => {
			entered.resolve();
			await release.promise;
			return fauxAssistantMessage("Graph done");
		},
	]);
	await f.app.command("/tasks on");
	const run = f.app.run("Hold a task");
	await entered.promise;
	try {
		await vi.waitFor(async () =>
			expect(Object.keys((await f.app.snapshot()).tasks?.tasks ?? {}).length).toBeGreaterThan(0),
		);
		const graph = (await f.app.snapshot()).tasks;
		expect(Object.values(graph?.tasks ?? {}).some((task) => task.conversationId === f.app.conversation.id)).toBe(true);
	} finally {
		release.resolve();
		await run;
	}
	await f.app.command("/tasks off");
	expect((await f.app.snapshot()).tasks).toBeUndefined();
});

test("an activation failure on reload still publishes current presentation state and permits a repaired reload", async () => {
	const f = await fixture();
	const file = join(f.cwd, "activation.ts");
	await writeFile(file, 'export default {name:"reload-activation", activate(){ return () => {}; }};');
	await f.app.close();
	const app = await reopen({ ...f.options, storage: new MemoryStorage(), extensionFiles: [file] });
	const revision = (await app.snapshot()).presentationRevision ?? 0;
	await writeFile(
		file,
		'export default {name:"reload-activation", activate(){ throw new Error("Fixture activation failure"); }};',
	);
	await expect(app.reload()).rejects.toThrow("Extension activation or cleanup failed");
	expect((await app.snapshot()).presentationRevision).toBeGreaterThan(revision);
	await writeFile(
		file,
		'export default {name:"reload-activation", activate(){ return () => {}; },commands:[{name:"repaired",description:"Repaired command",execute(){return {message:"repaired"};}}]};',
	);
	await app.reload();
	expect(await app.command("/repaired")).toEqual({ message: "repaired" });
});

test("the compact command executes a real summary task and preserves subsequent conversation use", async () => {
	const f = await fixture({ settings: { compaction: { enabled: false, keepRecentTokens: 1 } } });
	f.provider.setResponses([
		fauxAssistantMessage("First answer"),
		fauxAssistantMessage("Second answer"),
		fauxAssistantMessage("A compact record of completed work"),
		fauxAssistantMessage("Continued from the checkpoint"),
	]);
	await f.app.run("First question");
	await f.app.run("Second question");
	expect(await f.app.command("/compact Preserve completed work")).toEqual({ message: "Context compacted" });
	expect((await f.app.snapshot()).view.entries.some(CompactionEntry.is)).toBe(true);
	expect(JSON.stringify((await f.app.conversation.context(f.app.context)).messages)).toContain(
		"A compact record of completed work",
	);
	expect(await f.app.run("Continue")).toEqual({ status: "done", text: "Continued from the checkpoint" });
});

test("extension context controls preserve callable tools and use live session values inside input hooks", async () => {
	let retained: import("../src/sdk.ts").ExtensionContext | undefined;
	const names: string[] = [];
	const f = await fixture({
		settings: { codemode: false },
		extensions: [
			{
				name: "context-controls",
				activate(context) {
					retained = context;
				},
				async onInput(context, event) {
					if (event.text !== "configure") return;
					await context.setSessionName("Controlled");
					await context.setActiveTools(["read", "missing"]);
					await context.setThinkingLevel("high");
					names.push(...context.getActiveTools());
					return { action: "handled" };
				},
			},
		],
	});
	expect(retained?.hasUI).toBe(false);
	expect(retained?.model?.id).toBe("alpha");
	expect(retained?.isIdle()).toBe(true);
	expect(retained?.isProjectTrusted()).toBe(true);
	expect(retained?.hasPendingMessages()).toBe(false);
	expect(await f.app.submit("configure")).toBeUndefined();
	expect(names).toEqual(["read"]);
	expect(retained?.getSessionName()).toBe("Controlled");
	expect(retained?.thinkingLevel).toBe("high");
	expect(retained?.getThinkingLevel()).toBe("high");
	expect(retained?.getAllTools().map((t) => t.name)).toEqual(["read", "write", "edit", "bash"]);
	expect((await f.app.snapshot()).agent.callable.map((t) => t.name)).toEqual(["read", "write", "edit", "bash"]);
	await retained?.setActiveTools(["bash", "edit"]);
	expect(retained?.getActiveTools()).toEqual(["edit", "bash"]);
	const settings = retained?.getSettings();
	expect(settings).toBeDefined();
	expect(retained?.getCommands().map((c) => c.name)).toContain("tree");
	await f.app.command("/new");
	expect(retained?.getSessionName()).toBe("Controlled");
	expect(retained?.getActiveTools()).toEqual(["read", "write", "edit", "bash"]);
});

test("session naming dispatches one post-commit event and command contexts can navigate without admission deadlock", async () => {
	const observed: string[] = [];
	const f = await fixture({
		extensions: [
			{
				name: "command-controls",
				onSessionInfoChanged(context, event) {
					observed.push(`${event.name}:${context.getSessionName()}`);
				},
				commands: [
					{
						name: "rename",
						description: "Rename",
						async execute(args, _app, context) {
							await context.waitForIdle();
							await context.setSessionName(args);
							let message: string | undefined;
							await context.newSession({
								withSession(fresh) {
									message = fresh.getSessionName();
								},
							});
							expect(() => context.getSessionName()).toThrow("stale");
							return { message };
						},
					},
				],
			},
		],
	});
	expect(await f.app.command("/rename Example")).toEqual({ message: "Example" });
	expect(observed).toEqual(["Example:Example"]);
});

test.each(["memory", "sqlite"] as const)(
	"command session setup and fresh contexts work with %s and bypass command overrides",
	async (backend) => {
		const initialized = defineDoc<{ ready: boolean }>({
			kind: "test.session-setup",
			scope: "conversation",
			version: 1,
			history: "latest",
			fork: "initial",
			initial: () => ({ ready: false }),
			checkpointWhen: () => true,
		});
		let overrides = 0;
		const f = await fixture({
			backend,
			extensions: [
				{
					name: "session-setup",
					commands: [
						{
							name: "new",
							description: "Override new",
							execute() {
								overrides++;
								return { message: "override" };
							},
						},
						{
							name: "configured-new",
							description: "Create with setup",
							async execute(_args, _app, context) {
								await context.newSession({
									parentSession: "parent-session",
									async setup(tx, id) {
										(await tx.doc(initialized, id)).ready = true;
									},
									async withSession(fresh) {
										await fresh.setSessionName("initialized");
									},
								});
								expect(() => context.getSessionName()).toThrow("stale");
								return { message: "created" };
							},
						},
						{
							name: "failed-new",
							description: "Fail setup",
							async execute(_args, _app, context) {
								return context.newSession({
									async setup() {
										throw new Error("Setup rejected");
									},
								});
							},
						},
					],
				},
			],
		});
		expect((await f.app.command("/configured-new")).message).toBe("created");
		expect(overrides).toBe(0);
		expect(await f.app.snapshot()).toMatchObject({ sessionName: "initialized", parentSession: "parent-session" });
		expect(await f.app.harness.snapshot(initialized, f.app.conversation.id, f.app.context)).toEqual({ ready: true });
		const before = f.app.conversation.id;
		await expect(f.app.command("/failed-new")).rejects.toThrow("Setup rejected");
		expect(f.app.conversation.id).toBe(before);
	},
);

test("command forks support before and at boundaries and restore the selected user text", async () => {
	let selected: import("@arc/durable").EntryId | undefined;
	const f = await fixture({
		extensions: [
			{
				name: "positioned-fork",
				commands: [
					{
						name: "positioned-fork",
						description: "Fork boundary",
						async execute(args, _app, context) {
							if (!selected) throw new Error("Selected entry missing");
							return context.fork(selected, {
								position: args === "at" ? "at" : "before",
								async withSession(fresh) {
									await fresh.setSessionName("fork callback");
								},
							});
						},
					},
				],
			},
		],
	});
	f.provider.setResponses([fauxAssistantMessage("Original answer")]);
	await f.app.run("Original question");
	const first = (await f.app.snapshot()).view.entries.find((entry) =>
		entry.model?.some((message) => message.role === "user"),
	);
	if (!first) throw new Error("First user entry missing");
	selected = first.id;
	expect(await f.app.command("/positioned-fork before")).toMatchObject({ editorText: "Original question" });
	expect((await f.app.snapshot()).view.entries).toEqual([]);
	expect((await f.app.snapshot()).sessionName).toBe("fork callback");
});

test("tree controls forward replacement summary instructions and labels", async () => {
	let selected: import("@arc/durable").EntryId | undefined;
	const f = await fixture({
		extensions: [
			{
				name: "tree-options",
				commands: [
					{
						name: "tree-options",
						description: "Navigate with options",
						async execute(_args, _app, context) {
							if (!selected) throw new Error("Selected entry missing");
							return context.navigateTree(selected, {
								summarize: true,
								customInstructions: "Only report pending tasks.",
								replaceInstructions: true,
								label: "checkpoint",
							});
						},
					},
				],
			},
		],
	});
	f.provider.setResponses([
		fauxAssistantMessage("First answer"),
		fauxAssistantMessage("Second answer"),
		(transcript) => {
			const request = JSON.stringify(transcript.messages);
			expect(request).toContain("Only report pending tasks.");
			expect(request).not.toContain("Write a concise structured summary");
			return fauxAssistantMessage("No pending tasks.");
		},
	]);
	await f.app.run("First question");
	selected = (await f.app.snapshot()).view.entries.at(-1)?.id;
	await f.app.run("Second question");
	await f.app.command("/tree-options");
	if (!selected) throw new Error("Selected entry missing");
	expect(await f.app.getLabel(selected)).toBe("checkpoint");
	expect((await f.app.snapshot()).view.entries.some((entry) => entry.kind === "arc.branch-summary")).toBe(true);
});

test("extension model controls authenticate before selection and clamp thinking to model capabilities", async () => {
	let context: import("../src/sdk.ts").ExtensionContext | undefined;
	const f = await fixture({
		extensions: [
			{
				name: "model-controls",
				activate(c) {
					context = c;
				},
			},
		],
	});
	const plain = f.models.getModel("faux", "plain");
	if (!context || !plain) throw new Error("Missing fixture context");
	await context.setThinkingLevel("high");
	expect(context.thinkingLevel).toBe("high");
	expect(await context.setModel(plain)).toBe(true);
	expect(context.model?.id).toBe("plain");
	expect(context.thinkingLevel).toBe("off");
	expect(await context.setModel({ ...plain, id: "missing" })).toBe(false);
	expect(context.model?.id).toBe("plain");
});

test("tool renderer resolvers compose in load order and can intercept unregistered historical tools", async () => {
	const calls: string[] = [];
	const base = { renderShell: "default" as const };
	const f = await fixture({
		extensions: [
			{
				name: "outer-renderer",
				toolRendererResolvers: [
					(name, next) => {
						calls.push(`outer:${name}`);
						return { ...next(), renderShell: "self" };
					},
				],
			},
			{
				name: "inner-renderer",
				toolRendererResolvers: [
					(name, next) => {
						calls.push(`inner:${name}`);
						return next();
					},
				],
			},
		],
	});
	expect(f.app.toolRenderers("disconnected_tool", () => base)).toEqual({ renderShell: "self" });
	expect(calls).toEqual(["outer:disconnected_tool", "inner:disconnected_tool"]);
});

test("extension events share channels, isolate rejected listeners and release subscriptions at shutdown", async () => {
	let sender: import("../src/sdk.ts").ExtensionContext | undefined;
	const values: unknown[] = [],
		errors: unknown[] = [];
	const f = await fixture({
		onReport: (error) => {
			errors.push(error);
		},
		extensions: [
			{
				name: "sender",
				activate(context) {
					sender = context;
				},
			},
			{
				name: "receiver",
				activate(context) {
					context.events.on("changed", (value) => {
						values.push(value);
					});
					context.events.on("changed", async () => {
						throw new Error("Listener failed");
					});
				},
			},
		],
	});
	sender?.events.emit("changed", { value: 1 });
	expect(values).toEqual([{ value: 1 }]);
	await vi.waitFor(() => expect(errors).toHaveLength(1));
	await f.app.close();
	sender?.events.emit("changed", { value: 2 });
	expect(values).toEqual([{ value: 1 }]);
});

test("extension flags have typed defaults and command-line values before activation", async () => {
	const observed: unknown[] = [];
	const f = await fixture({
		extensionArgs: ["--profile", "fast", "--trace"],
		extensions: [
			{
				name: "flag-controls",
				flags: {
					profile: { type: "string", default: "safe" },
					trace: { type: "boolean", default: false },
					limit: { type: "string", default: "small" },
				},
				activate(context) {
					observed.push(
						context.getFlag("profile"),
						context.getFlag("trace"),
						context.getFlag("limit"),
						context.getFlag("constructor"),
					);
				},
			},
		],
	});
	expect(observed).toEqual(["fast", true, "small", undefined]);
	expect(f.app.flags()).toEqual({
		profile: { type: "string", default: "safe" },
		trace: { type: "boolean", default: false },
		limit: { type: "string", default: "small" },
	});
	await expect(fixture({ extensionArgs: ["--unknown"], extensions: [] })).rejects.toThrow("Unknown option");
	await expect(
		fixture({ extensions: [{ name: "reserved-flags", flags: { model: { type: "string" } } }] }),
	).rejects.toThrow("Reserved or invalid extension flag");
});

test("custom messages enter model context while custom entries remain display-only", async () => {
	let context: import("../src/sdk.ts").ExtensionContext | undefined;
	const f = await fixture({
		extensions: [
			{
				name: "custom-records",
				activate(c) {
					context = c;
				},
			},
		],
	});
	if (!context) throw new Error("Missing context");
	const message = await context.sendMessage({
		customType: "note",
		content: "Context from an extension",
		display: false,
		details: { source: "fixture" },
	});
	expect((await message?.status(f.app.context))?.status).toBe("done");
	await context.appendEntry("bookmark", { file: "a.ts" });
	expect(f.provider.state.callCount).toBe(0);
	const entries = (await f.app.snapshot()).view.entries;
	expect(entries.find((e) => e.kind === "application.message")).toMatchObject({
		data: { customType: "note", display: false },
		model: [{ role: "user", content: "Context from an extension" }],
	});
	expect(entries.find((e) => e.kind === "application.entry")).toMatchObject({
		data: { customType: "bookmark", data: { file: "a.ts" } },
	});
	expect(entries.find((e) => e.kind === "application.entry")?.model).toBeUndefined();
	const received: import("@arc/ai").Message[] = [];
	f.provider.setResponses([
		(request) => {
			received.push(...request.messages);
			return fauxAssistantMessage("Read extension context");
		},
	]);
	await f.app.run("Continue");
	expect(received).toContainEqual(expect.objectContaining({ role: "user", content: "Context from an extension" }));
});

test("next-turn custom messages survive reopening and are flushed exactly once before the next user input", async () => {
	let context: import("../src/sdk.ts").ExtensionContext | undefined;
	const extension: import("../src/sdk.ts").ApplicationExtension = {
		name: "pending-note",
		activate(c) {
			context = c;
		},
	};
	const f = await fixture({ backend: "sqlite", extensions: [extension] });
	if (!context) throw new Error("Missing context");
	await context.sendMessage(
		{ customType: "deferred", content: "Remember this", display: true },
		{ deliverAs: "nextTurn" },
	);
	expect((await f.app.snapshot()).view.entries.some((e) => e.kind === "application.message")).toBe(false);
	const file = (await f.app.snapshot()).sessionFile;
	await f.app.close();
	const app = await createApplication({ ...f.options, sessionFile: file, extensions: [extension] });
	cleanups.push(() => app.close());
	f.provider.setResponses([fauxAssistantMessage("First"), fauxAssistantMessage("Second")]);
	await app.run("One");
	await app.run("Two");
	const entries = (await app.snapshot()).view.entries;
	expect(entries.filter((e) => e.kind === "application.message")).toHaveLength(1);
	const contents = entries
		.flatMap((e) => e.model ?? [])
		.filter((m) => m.role === "user")
		.map((m) => m.content);
	expect(contents).toEqual(["Remember this", "One", "Two"]);
});

test("custom messages sent from a running tool wait until its result is recorded", async () => {
	let context: import("../src/sdk.ts").ExtensionContext | undefined;
	const { defineTool } = await import("@arc/durable");
	const { Type } = await import("typebox");
	const f = await fixture({
		extensions: [
			{
				name: "tool-message",
				activate(c) {
					context = c;
				},
				tools: [
					defineTool({
						name: "announce",
						description: "Announce",
						parameters: Type.Object({}),
						async execute() {
							if (!context) throw new Error("Missing context");
							await context.sendMessage(
								{ customType: "notice", content: "Tool finished", display: true },
								{ triggerTurn: false },
							);
							return { output: [{ type: "text", text: "Done" }] };
						},
					}),
				],
			},
		],
	});
	f.provider.setResponses([
		fauxAssistantMessage([fauxToolCall("announce", {}, { id: "call" })], { stopReason: "toolUse" }),
		fauxAssistantMessage("Acknowledged"),
	]);
	await f.app.run("Announce");
	const entries = (await f.app.snapshot()).view.entries;
	const result = entries.findIndex((e) => e.model?.some((m) => m.role === "toolResult" && m.toolCallId === "call"));
	const custom = entries.findIndex((e) => e.kind === "application.message");
	expect(result).toBeGreaterThan(-1);
	expect(custom).toBeGreaterThan(result);
});

test("extension prompt and usage queries use Durable sections and active conversation context", async () => {
	let context: import("../src/sdk.ts").ExtensionContext | undefined;
	const f = await fixture({
		systemPrompt: "Arc test role",
		appendSystemPrompt: "Extra instruction",
		extensions: [
			{
				name: "context-query",
				activate(c) {
					context = c;
				},
				sections: [{ key: "test-section", tag: false, render: () => "Extension instruction" }],
			},
		],
	});
	if (!context) throw new Error("Missing context");
	const prompt = await context.getSystemPrompt();
	expect(prompt).toContain("Arc test role");
	expect(prompt).toContain("Extra instruction");
	expect(prompt).toContain("Extension instruction");
	const before = await context.getContextUsage();
	expect(before).toMatchObject({ tokens: 0, percent: 0 });
	f.provider.setResponses([fauxAssistantMessage("A response")]);
	await f.app.run("Hello");
	const after = await context.getContextUsage();
	expect(after?.tokens).toBeGreaterThan(0);
	expect(after?.contextWindow).toBe(f.models.getModel("faux", "alpha")?.contextWindow);
	expect((await context.getSystemPrompt()).includes("Extension instruction")).toBe(true);
});

test("resource discovery adds skills and templates after startup and replaces contributions on reload", async () => {
	let enabled = true;
	const reasons: string[] = [];
	const directory = await mkdtemp(join(tmpdir(), "arc-extension-resources-"));
	cleanups.push(() => rm(directory, { recursive: true, force: true }));
	const skill = join(directory, "guide.md"),
		prompt = join(directory, "greet.md");
	await writeFile(skill, "---\nname: guide\ndescription: Project guide\n---\nGuide content");
	await writeFile(prompt, "---\ndescription: Greeting\n---\nHello $1");
	let context: import("../src/sdk.ts").ExtensionContext | undefined;
	const f = await fixture({
		extensions: [
			{
				name: "resource-discovery",
				activate(c) {
					context = c;
				},
				onResourcesDiscover(_context, event) {
					reasons.push(event.reason);
					return enabled ? { skillPaths: [skill], promptPaths: [prompt] } : {};
				},
			},
		],
	});
	expect(f.app.commands().map((c) => c.name)).toEqual(expect.arrayContaining(["skill:guide", "greet"]));
	expect(await context?.getSystemPrompt()).toContain("Project guide");
	enabled = false;
	await f.app.reload();
	expect(f.app.commands().map((c) => c.name)).not.toContain("greet");
	expect(f.app.commands().map((c) => c.name)).not.toContain("skill:guide");
	expect(reasons).toEqual(["startup", "reload"]);
});

test("provider callbacks reach Durable requests with mutable headers, payload replacement, response and raw events", async () => {
	const seen: unknown[] = [];
	const f = await fixture({
		extensions: [
			{
				name: "wire-observer",
				beforeProviderHeaders(context, event) {
					event.headers["x-extension"] = "yes";
					seen.push(["headers", context.model.id, context.signal.aborted]);
				},
				beforeProviderRequest(_context, event) {
					seen.push(["payload", event.payload]);
					return { changed: true };
				},
				afterProviderResponse(_context, event) {
					seen.push(["response", event.status, event.headers["x-id"]]);
				},
				onProviderStreamEvent(_context, event) {
					seen.push(["stream", event.data]);
				},
			},
		],
	});
	f.provider.setResponses([
		async (_request, options, _state, model) => {
			expect(options?.headers?.["x-extension"]).toBe("yes");
			expect(await options?.onPayload?.({ original: true }, model)).toEqual({ changed: true });
			await options?.onProviderStreamEvent?.({ type: "delta" }, model);
			return fauxAssistantMessage("Observed");
		},
	]);
	expect(await f.app.run("Observe")).toEqual({ status: "done", text: "Observed" });
	expect(seen).toEqual([
		["headers", "alpha", false],
		["response", 200, undefined],
		["payload", { original: true }],
		["stream", { type: "delta" }],
	]);
});

test("dynamic provider registrations restore the previous provider on extension shutdown", async () => {
	let context: import("../src/sdk.ts").ExtensionContext | undefined;
	const f = await fixture({
		extensions: [
			{
				name: "dynamic-provider",
				activate(c) {
					context = c;
				},
			},
		],
	});
	if (!context) throw new Error("Missing context");
	const previous = f.models.getProvider("faux");
	const next = fauxProvider({ models: [{ id: "replacement" }] }).provider;
	context.registerProvider(next);
	expect(f.models.getProvider("faux")).toBe(next);
	await f.app.close();
	expect(f.models.getProvider("faux")).toBe(previous);
});

test("provider request controls cancel one invocation without aborting another", async () => {
	const scopes: import("../src/sdk.ts").ProviderContext[] = [];
	const f = await fixture({
		extensions: [
			{
				name: "request-cancellation",
				beforeProviderHeaders(context) {
					scopes.push(context);
					if (context.model.id === "alpha") context.abort();
				},
			},
		],
	});
	const alpha = f.app.models.getModel("faux", "alpha"),
		beta = f.app.models.getModel("faux", "beta");
	if (!alpha || !beta) throw new Error("Missing models");
	f.provider.setResponses([fauxAssistantMessage("Ready"), fauxAssistantMessage("Ready")]);
	const [first, second] = await Promise.all([
		f.app.models.completeSimple(alpha, { messages: [{ role: "user", content: "One", timestamp: 1 }] }),
		f.app.models.completeSimple(beta, { messages: [{ role: "user", content: "Two", timestamp: 1 }] }),
	]);
	expect(first.stopReason).toBe("aborted");
	expect(second.stopReason).toBe("stop");
	expect(scopes.find((c) => c.model.id === "alpha")?.signal.aborted).toBe(true);
	expect(scopes.find((c) => c.model.id === "beta")?.signal.aborted).toBe(false);
});

test("cache warming replays native requests and persists separate usage without assistant replies", async () => {
	vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
	try {
		const decisions: unknown[] = [];
		let controls: import("../src/sdk.ts").ExtensionContext | undefined;
		const f = await fixture({
			settings: { cacheWarming: "idle" },
			extensions: [
				{
					name: "warm-policy",
					activate(context) {
						controls = context;
					},
					onCacheWarmingDecision(_context, event) {
						decisions.push(event);
						return { action: "warm" };
					},
				},
			],
		});
		const model = f.models.getModel("faux", "alpha");
		if (!model) throw new Error("Missing model");
		model.promptCache = { short: 20 };
		const requests: unknown[] = [];
		f.provider.setResponses([
			(_context, options) => {
				requests.push(options);
				return fauxAssistantMessage("real answer");
			},
			(_context, options) => {
				requests.push(options);
				return fauxAssistantMessage("warm output");
			},
		]);
		await f.app.run("question");
		await vi.advanceTimersByTimeAsync(10_000);
		const state = await f.app.snapshot();
		expect(requests).toHaveLength(2);
		expect(requests[1]).toMatchObject({ maxTokens: 1, maxRetries: 0 });
		expect(decisions).toHaveLength(1);
		expect(
			messages(state)
				.filter((message) => message.role === "assistant")
				.map((message) => message.content),
		).toEqual([[{ type: "text", text: "real answer" }]]);
		expect(state.view.entries.filter((entry) => entry.kind === "application.cache-warm")).toHaveLength(1);
		expect(state.usage.tools).toHaveProperty("cache_warm");
		if (!controls) throw new Error("Missing controls");
		await controls.sendMessage({ customType: "changed", content: "new model context", display: false });
		await f.app.snapshot();
		await vi.advanceTimersByTimeAsync(10_000);
		expect(requests).toHaveLength(2);
		expect(JSON.parse((await f.app.command("/session")).message ?? "{}").cacheWarming.reason).toBe(
			"conversation context changed",
		);

		await f.app.command("/settings cacheWarming off");
		expect(JSON.parse((await f.app.command("/session")).message ?? "{}").cacheWarming.reason).toBe(
			"cache warming disabled",
		);
		await f.app.close();
	} finally {
		vi.useRealTimers();
	}
});

test("virtual model selection stays persistent while physical dispatch and branch state change", async () => {
	const routes: unknown[] = [];
	const f = await fixture({
		model: { provider: "router", modelId: "auto" },
		thinkingLevel: "high",
		extensions: [
			{
				name: "router",
				virtualModels: [
					{
						provider: "router",
						id: "auto",
						name: "Automatic",
						thinkingLevels: ["low", "high"],
						contextWindow: 200_000,
						route(request, context) {
							routes.push({ reason: request.reason, state: request.state, selected: request.model.id });
							const model = context.models.getModel("faux", request.state === undefined ? "alpha" : "beta");
							if (!model) throw new Error("Missing target");
							return { model, thinkingLevel: "high", state: { routed: true } };
						},
					},
				],
			},
		],
	});
	f.provider.setResponses([fauxAssistantMessage("first"), fauxAssistantMessage("second")]);
	await f.app.run("one");
	await f.app.run("two");
	const state = await f.app.snapshot();
	expect(state.agent.model).toEqual({ provider: "router", modelId: "auto" });
	expect(state.agent.thinkingLevel).toBe("high");
	expect(
		messages(state)
			.filter((message) => message.role === "assistant")
			.map((message) => message.model),
	).toEqual(["alpha", "beta"]);
	expect(routes).toEqual([
		{ reason: "user", state: undefined, selected: "auto" },
		{ reason: "user", state: { routed: true }, selected: "auto" },
	]);
	expect(state.routedModel?.modelId).toBe("beta");
	expect((await f.app.models.getAvailable()).some((model) => model.provider === "router" && model.id === "auto")).toBe(
		true,
	);
});

test("direct virtual requests clamp physical output and remove credentials when crossing providers", async () => {
	let received: unknown;
	const f = await fixture({
		extensions: [
			{
				name: "router",
				virtualModels: [
					{
						provider: "router",
						id: "auto",
						name: "Automatic",
						route(request, context) {
							expect(request.reason).toBe("direct");
							expect(request.state).toBeUndefined();
							const model = context.models.getModel("faux", "plain");
							if (!model) throw new Error("Missing target");
							return { model, thinkingLevel: "high" };
						},
					},
				],
			},
		],
	});
	f.provider.setResponses([
		(_context, options) => {
			received = options;
			return fauxAssistantMessage("direct");
		},
	]);
	const model = f.app.models.getModel("router", "auto");
	if (!model) throw new Error("Missing virtual");
	const result = await f.app.models.completeSimple(
		model,
		{ messages: [] },
		{
			maxTokens: 1_000_000,
			apiKey: "foreign-secret",
			headers: { "x-foreign": "secret" },
			env: { FOREIGN_KEY: "secret" },
		},
	);
	expect(result.model).toBe("plain");
	expect(received).toMatchObject({ maxTokens: f.models.getModel("faux", "plain")?.maxTokens });
	expect(received).not.toHaveProperty("apiKey", "foreign-secret");
	expect(received).not.toHaveProperty("headers.x-foreign");
	expect(received).not.toHaveProperty("env.FOREIGN_KEY");
	expect(received).not.toHaveProperty("reasoning", "high");
});

test("router failures terminate the request without sending a virtual model to a provider", async () => {
	const f = await fixture({
		model: { provider: "router", modelId: "broken" },
		extensions: [
			{
				name: "router",
				virtualModels: [
					{
						provider: "router",
						id: "broken",
						name: "Broken",
						route() {
							throw new Error("routing failed");
						},
					},
				],
			},
		],
	});
	f.provider.setResponses([
		() => {
			throw new Error("Provider must not run");
		},
	]);
	const result = await f.app.run("question");
	expect(result.status).toBe("unanswered");
	expect(messages(await f.app.snapshot()).filter((message) => message.role === "assistant")).toEqual([]);
});

test("virtual routing uses continuation reasons after tools and rejects virtual targets", async () => {
	const reasons: string[] = [];
	const f = await fixture({
		model: { provider: "router", modelId: "auto" },
		extensions: [
			{
				name: "router",
				virtualModels: [
					{
						provider: "router",
						id: "auto",
						name: "Automatic",
						route(request, context) {
							reasons.push(request.reason);
							const model = context.models.getModel("faux", "alpha");
							if (!model) throw new Error("Missing target");
							return { model, thinkingLevel: "off" };
						},
					},
				],
			},
		],
	});
	f.provider.setResponses([
		fauxAssistantMessage([fauxToolCall("read", { path: "absent" })], { stopReason: "toolUse" }),
		fauxAssistantMessage("done"),
	]);
	await f.app.run("read");
	expect(reasons).toEqual(["user", "continuation"]);
	const recursive = await fixture({
		model: { provider: "router", modelId: "loop" },
		extensions: [
			{
				name: "loop",
				virtualModels: [
					{
						provider: "router",
						id: "loop",
						name: "Loop",
						route(request) {
							return { model: request.model, thinkingLevel: "off" };
						},
					},
				],
			},
		],
	});
	expect((await recursive.app.run("no loop")).status).toBe("unanswered");
});

test("virtual router state survives SQLite reopen and unavailable selections fall back to the last physical response", async () => {
	const states: unknown[] = [];
	const extensions: ApplicationOptions["extensions"] = [
		{
			name: "router",
			virtualModels: [
				{
					provider: "router",
					id: "auto",
					name: "Automatic",
					route(request, context) {
						states.push(request.state);
						const model = context.models.getModel("faux", "alpha");
						if (!model) throw new Error("Missing target");
						return { model, thinkingLevel: "off", state: { saved: true } };
					},
				},
			],
		},
	];
	const f = await fixture({ backend: "sqlite", model: { provider: "router", modelId: "auto" }, extensions });
	f.provider.setResponses([fauxAssistantMessage("first")]);
	await f.app.run("one");
	const sessionFile = (await f.app.snapshot()).sessionFile;
	await f.app.close();
	const reopened = await createApplication({ ...f.options, sessionFile });
	cleanups.push(() => reopened.close());
	f.provider.setResponses([fauxAssistantMessage("second")]);
	await reopened.run("two");
	expect(states).toEqual([undefined, { saved: true }]);
	await reopened.close();
	const fallback = await createApplication({ ...f.options, model: undefined, extensions: [], sessionFile });
	cleanups.push(() => fallback.close());
	expect((await fallback.snapshot()).agent.model).toEqual({ provider: "faux", modelId: "alpha" });
});

test("virtual routing budgets against the physical limit and preserves the chosen route through automatic compaction", async () => {
	const reasons: string[] = [];
	const f = await fixture({
		model: { provider: "router", modelId: "auto" },
		settings: { compaction: { enabled: true, reserveTokens: 100, keepRecentTokens: 20, backgroundTokens: 0 } },
		extensions: [
			{
				name: "router",
				virtualModels: [
					{
						provider: "router",
						id: "auto",
						name: "Automatic",
						contextWindow: 1_000_000,
						maxTokens: 1000,
						route(request, context) {
							reasons.push(request.reason);
							const model = context.models.getModel("faux", "alpha");
							if (!model) throw new Error("Missing target");
							return { model, thinkingLevel: "off" };
						},
					},
				],
			},
		],
	});
	const physical = f.models.getModel("faux", "alpha");
	if (!physical) throw new Error("Missing target");
	physical.contextWindow = 10_000;
	f.provider.setResponses([fauxAssistantMessage("old answer ".repeat(100))]);
	await f.app.run("old input ".repeat(100));
	physical.contextWindow = 1000;
	f.provider.setResponses([fauxAssistantMessage("saved summary"), fauxAssistantMessage("after compact")]);
	expect((await f.app.run("new input")).status).toBe("done");
	const entries = (await f.app.conversation.entries({}, 100, undefined, context)).items;
	expect(entries.some(CompactionEntry.is)).toBe(true);
	expect(reasons.filter((reason) => reason === "user")).toHaveLength(2);
	expect(reasons).toContain("direct");
});

test("retry routing receives the failed physical request and can switch models", async () => {
	const observations: unknown[] = [];
	const f = await fixture({
		model: { provider: "router", modelId: "auto" },
		settings: { retry: { enabled: true, maxRetries: 1, baseDelayMs: 0, maxAgentDelayMs: 0 } },
		extensions: [
			{
				name: "router",
				virtualModels: [
					{
						provider: "router",
						id: "auto",
						name: "Automatic",
						route(request, context) {
							observations.push({
								reason: request.reason,
								failed: request.failed?.model.id,
								error: request.failed?.message.errorMessage,
							});
							const model = context.models.getModel("faux", request.reason === "retry" ? "beta" : "alpha");
							if (!model) throw new Error("Missing target");
							return { model, thinkingLevel: "off" };
						},
					},
				],
			},
		],
	});
	f.provider.setResponses([
		fauxAssistantMessage("", { stopReason: "error", errorMessage: "503 service unavailable" }),
		fauxAssistantMessage("recovered"),
	]);
	expect((await f.app.run("retry")).status).toBe("done");
	expect(observations).toEqual([
		{ reason: "user", failed: undefined, error: undefined },
		{ reason: "retry", failed: "alpha", error: "503 service unavailable" },
	]);
	expect((await f.app.snapshot()).routedModel?.modelId).toBe("beta");
});

test("invalid virtual model replacement is rejected before publishing the new extension", async () => {
	const f = await fixture();
	const file = join(f.directory, "router.ts");
	await writeFile(
		file,
		'export default {name:"route-file",virtualModels:[{provider:"router",id:"auto",name:"Automatic",route(request,context){return {model:context.models.getModel("faux","alpha"),thinkingLevel:"off"};}}]};',
	);
	const app = await reopen({ ...f.options, storage: new MemoryStorage(), extensionFiles: [file] });
	expect(app.models.getModel("router", "auto")?.name).toBe("Automatic");
	await writeFile(
		file,
		'export default {name:"route-file",virtualModels:[{provider:"router",id:"broken",name:"Broken",thinkingLevels:["impossible"],route(){}}]};',
	);
	await expect(app.reload()).rejects.toThrow("Invalid virtual thinking levels");
	expect(app.models.getModel("router", "auto")?.name).toBe("Automatic");
	expect(app.models.getModel("router", "broken")).toBeUndefined();
});

test("extension commands replace built-ins and duplicate names receive distinct invocation aliases", async () => {
	const completions = () => [{ value: "argument", label: "Argument" }];
	const f = await fixture({
		extensions: [
			{
				name: "one",
				commands: [
					{
						name: "model",
						description: "Custom model selection",
						getArgumentCompletions: completions,
						execute: () => ({ message: "custom model" }),
					},
					{ name: "same", description: "First", execute: () => ({ message: "first" }) },
				],
			},
			{ name: "two", commands: [{ name: "same", description: "Second", execute: () => ({ message: "second" }) }] },
		],
	});
	expect(await f.app.command("/model")).toEqual({ message: "custom model" });
	expect(f.app.hasCommandOverride("model")).toBe(true);
	expect(f.app.commands().filter((command) => command.name === "model")).toHaveLength(1);
	expect(
		f.app
			.commands()
			.find((command) => command.name === "model")
			?.getArgumentCompletions?.("a"),
	).toEqual([{ value: "argument", label: "Argument" }]);
	expect(await f.app.command("/same:1")).toEqual({ message: "first" });
	expect(await f.app.command("/same:2")).toEqual({ message: "second" });
	await expect(f.app.command("/same")).rejects.toThrow("Unknown command");
});

test("closing an application releases its provider sessions without releasing another application", async () => {
	const first = await fixture();
	const second = await fixture();
	const released: (string | undefined)[] = [];
	const unregister = registerSessionResourceCleanup((sessionId) => released.push(sessionId));
	try {
		first.provider.setResponses([fauxAssistantMessage("first")]);
		second.provider.setResponses([fauxAssistantMessage("second")]);
		await first.app.run("one");
		await second.app.run("two");
		const firstSession = (await first.app.harness.snapshot(ProviderDoc, first.app.conversation.id, context))?.sessionId;
		const secondSession = (await second.app.harness.snapshot(ProviderDoc, second.app.conversation.id, context))
			?.sessionId;
		expect(firstSession).toEqual(expect.any(String));
		expect(secondSession).toEqual(expect.any(String));
		await first.app.close();
		expect(released).toEqual([firstSession]);
		await first.app.close();
		expect(released).toEqual([firstSession]);
		await second.app.close();
		expect(released).toEqual([firstSession, secondSession]);
	} finally {
		unregister();
	}
});
