import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as context, traceIn, withTelemetry } from "@arc/durable/context";
import { InMemoryTelemetryContext } from "@arc/telemetry";
import { renderTrace } from "@arc/telemetry/render";
import {
	Harness,
	createRegistry,
	defineDoc,
	defineTool,
	ProviderDoc,
	ToolResultEntry,
	DEFAULT_COMPACTION_POLICY,
	DEFAULT_PROGRESS_POLICY,
	DEFAULT_RESTART_LIMIT,
	DEFAULT_RETRY_POLICY,
} from "@arc/durable";
import { createModels, Type, fauxProvider, fauxAssistantMessage, fauxText, fauxToolCall } from "@arc/ai";
import { createApplication } from "@arc/cli";
import { MemoryStorage } from "@arc/durable";
import { ExtensionLoader } from "@arc/durable/extensions/node";
import { openNodeSqliteStorage } from "@arc/durable/storage/sqlite/node";
import { Connection, RemoteExecutionEnv, localDaemon } from "@arc/env";
import { CodingTools } from "@arc/durable/tools";
import { createNodePhotonImages } from "@arc/durable/images/node";
import { createCodemodeExtension, CodemodeStoreDoc } from "@arc/durable/codemode";
import { CodemodeSandbox } from "@arc/codemode";
import { McpClient, LATEST_PROTOCOL_VERSION } from "@arc/mcp";
import { createInMemoryTransportPair } from "@arc/mcp/testing";

const tui = await import("@arc/tui");
const plain = (text) => text;
const markdownTheme = Object.fromEntries(
	[
		"heading",
		"link",
		"linkUrl",
		"code",
		"codeBlock",
		"codeBlockBorder",
		"quote",
		"quoteBorder",
		"hr",
		"listBullet",
		"bold",
		"italic",
		"strikethrough",
		"underline",
	].map((name) => [name, plain]),
);
const markdown = new tui.Markdown("# Installed\n\nHello **world**", 0, 0, markdownTheme);
assert.deepEqual(markdown.render(40).map(tui.stripTerminalSequences), [
	"Installed".padEnd(40),
	" ".repeat(40),
	"Hello world".padEnd(40),
]);
assert.equal(tui.renderLatex("x^2"), "x²");
assert.equal(tui.colorToHex(tui.rgbColor(255, 128, 0)), "#ff8000");
const stack = new tui.VStack([new tui.Text("one", 0, 0), new tui.Text("two", 0, 0)]);
assert.deepEqual(
	stack.render(8).map((line) => tui.stripTerminalSequences(line).trimEnd()),
	["one", "two"],
);
assert.equal(tui.oklabToOkhslLightness(0), 0);

const telemetry = new InMemoryTelemetryContext();
assert.equal(
	renderTrace([
		{
			id: "installed",
			traceId: "installed",
			name: "archive",
			startedMs: 10,
			endedMs: 13,
			attributes: {},
			events: [],
			links: [],
			status: { status: "ok" },
		},
	]),
	"archive (3ms)",
);
const receiver = new InMemoryTelemetryContext();
await traceIn(withTelemetry(telemetry, context), { name: "installed" }, async (child) => {
	telemetry.counter("requests").add(1, { mode: "installed" }, child.telemetry);
	const carrier = telemetry.inject(child.telemetry);
	assert.ok(carrier);
	await receiver.extract(JSON.parse(JSON.stringify(carrier))).startSpan({ name: "received" }, () => 42);
});
assert.deepEqual(
	telemetry.getSpans().map((span) => [span.name, span.settled]),
	[["installed", true]],
);
assert.deepEqual(
	receiver.getSpans().map((span) => span.name),
	["received"],
);
assert.deepEqual(receiver.getSpans()[0].parentContext, telemetry.getSpans()[0].context);
assert.deepEqual(
	telemetry.getMetrics().map((measurement) => [measurement.name, measurement.value]),
	[["requests", 1]],
);

assert.equal(DEFAULT_RESTART_LIMIT, 5);
assert.equal(DEFAULT_RETRY_POLICY.maxRetries, 3);
assert.equal(DEFAULT_COMPACTION_POLICY.reserveTokens, 16384);
assert.equal(DEFAULT_PROGRESS_POLICY.partialIntervalMs, 100);
assert.equal("classifierJson" in (await import("@arc/ai/api/classifier-shared")), false);
assert.equal("openRouterModelSchema" in (await import("@arc/ai/providers/openrouter-api")), false);
assert.equal("isOpenRouterModel" in (await import("@arc/ai/providers/openrouter-api")), false);
for (const subpath of ["api/anthropic-request", "api/bedrock-client", "providers/builtin"])
	assert.throws(() => import.meta.resolve(`@arc/ai/${subpath}`), { code: "ERR_PACKAGE_PATH_NOT_EXPORTED" });
const cwd = await mkdtemp(join(tmpdir(), "arc-public-"));
const envConnection = new Connection({ command: [localDaemon()] });
const Counter = defineDoc({
	checkpointWhen: () => false,
	kind: "counter",
	scope: "session",
	version: 1,
	initial: () => ({ count: 0 }),
});
const models = createModels(),
	faux = fauxProvider(),
	registry = createRegistry(),
	reports = [],
	events = [];
models.setProvider(faux.provider);
const sandbox = new CodemodeSandbox();
const pair = createInMemoryTransportPair(),
	client = new McpClient({ name: "installed", version: "1" });
let harness, subscription;
const openHarness = async () =>
	Harness.open(
		await openNodeSqliteStorage(join(cwd, "session.sqlite")),
		{
			models,
			registry,
			env: () => new RemoteExecutionEnv({ connection: envConnection, id: "installed:remote", cwd }),
			onReport: (error) => reports.push(error),
		},
		context,
	);
try {
	faux.setResponses([fauxAssistantMessage("Installed application answer")]);
	const applicationEvents = [];
	let installedContext;
	const application = await createApplication({
		cwd,
		home: join(cwd, "app-home"),
		extensions: [
			{
				name: "installed-lifecycle",
				virtualModels: [
					{
						provider: "router",
						id: "auto",
						name: "Installed router",
						route(request, context) {
							const model = context.models.getModel("faux", "faux-1");
							assert.ok(model);
							return { model, thinkingLevel: "off", state: { installed: true } };
						},
					},
				],
				onInput(_context, event) {
					if (event.text === "consume installed input") return { action: "handled" };
				},
				beforeSessionSwitch() {
					return { cancel: true };
				},
				activate: (context) => {
					installedContext = context;
					return () => {
						applicationEvents.push("cleanup");
					};
				},
				onSessionStart: (_context, event) => {
					applicationEvents.push(event.reason);
				},
				toolRenderers: { read: { renderCall: () => undefined } },
			},
		],
		models,
		model: { provider: "faux", modelId: "faux-1" },
		storage: new MemoryStorage(),
		resources: { contextFiles: [], skills: [], prompts: [], extensionFiles: [] },
	});
	try {
		assert.deepEqual(await application.run("Check the application"), {
			status: "done",
			text: "Installed application answer",
		});
		assert.equal(application.ui.supported, false);
		assert.ok(application.commands().some((command) => command.name === "reload"));
		assert.equal(typeof application.toolRenderers("read").renderCall, "function");
		assert.equal(await application.submit("consume installed input"), undefined);
		assert.deepEqual(await application.command("/new"), { cancelled: true });
		const labeled = (await application.snapshot()).view.entries.at(-1);
		assert.ok(labeled);
		await application.setLabel(labeled.id, "installed bookmark");
		assert.equal(await application.getLabel(labeled.id), "installed bookmark");
		await application.command("/scoped-models save faux/*:high");
		await application.cycleModel();
		assert.deepEqual((await application.snapshot()).agent.model, { provider: "faux", modelId: "faux-1" });
		assert.equal((await application.snapshot()).agent.thinkingLevel, "off");
		await application.command("/thinking save off");
		assert.equal(
			JSON.parse(await readFile(join(cwd, "app-home", "settings.json"), "utf8")).modelThinkingLevels["faux/faux-1"],
			"off",
		);
		await writeFile(join(cwd, "preview.txt"), "before\n");
		assert.deepEqual(
			await application.previewEdit({ path: "preview.txt", edits: [{ oldText: "before", newText: "after" }] }),
			{ diff: "-1 before\n+1 after", firstChangedLine: 1 },
		);
		assert.equal(await readFile(join(cwd, "preview.txt"), "utf8"), "before\n");
		assert.ok(installedContext);
		await installedContext.sendMessage({
			customType: "installed-note",
			content: "Installed custom context",
			display: false,
		});
		await application.command("/model router/auto");
		faux.setResponses([fauxAssistantMessage("Installed routed answer")]);
		assert.deepEqual(await application.run("Route the installed request"), {
			status: "done",
			text: "Installed routed answer",
		});
		const routed = await application.snapshot();
		assert.deepEqual(routed.agent.model, { provider: "router", modelId: "auto" });
		assert.equal(routed.routedModel.modelId, "faux-1");
		assert.ok(routed.view.entries.some((entry) => entry.kind === "application.message"));
		assert.ok((await installedContext.getSystemPrompt()).length > 0);
		assert.ok(JSON.parse((await application.command("/session")).message).cacheWarming);
	} finally {
		await application.close();
	}
	assert.deepEqual(applicationEvents, ["startup", "cleanup"]);
	const sessionBackends = [];
	for (const backend of ["sqlite", "jsonl"]) {
		faux.setResponses([
			fauxAssistantMessage("Installed source answer"),
			fauxAssistantMessage("Installed clone answer"),
		]);
		const options = {
			cwd,
			home: join(cwd, `session-home-${backend}`),
			models,
			backend,
			mode: "text",
			model: { provider: "faux", modelId: "faux-1" },
			resources: { contextFiles: [], skills: [], prompts: [], extensionFiles: [] },
			extensions: [
				{
					name: "installed-command-control",
					beforeCommand(context, command) {
						assert.equal(context.mode, "text");
						if (command.name === "new") return { action: "cancel" };
					},
				},
			],
		};
		const app = await createApplication(options);
		let sourceFile;
		try {
			await app.run("Installed source question");
			sourceFile = (await app.snapshot()).sessionFile;
			assert.deepEqual(await app.command("/new"), { cancelled: true });
			assert.equal((await app.snapshot()).sessionFile, sourceFile);
			const count = faux.state.callCount;
			await app.command("/clone");
			assert.notEqual((await app.snapshot()).sessionFile, sourceFile);
			assert.equal(faux.state.callCount, count);
			await app.run("Installed clone question");
			const user = (await app.snapshot()).view.entries.find((entry) =>
				entry.model?.some((message) => message.role === "user"),
			);
			assert.ok(user);
			assert.equal((await app.command(`/tree entry:${user.id}`)).editorText, "Installed source question");
			assert.equal(
				(await app.snapshot()).view.entries
					.flatMap((entry) => entry.model ?? [])
					.filter((message) => message.role === "user").length,
				0,
			);
		} finally {
			await app.close();
		}
		const original = await createApplication({ ...options, sessionFile: sourceFile });
		try {
			assert.deepEqual(
				(await original.snapshot()).view.entries
					.flatMap((entry) => entry.model ?? [])
					.filter((message) => message.role === "user")
					.map((message) => message.content),
				["Installed source question"],
			);
		} finally {
			await original.close();
		}
		sessionBackends.push(backend);
	}
	const loaderRegistry = createRegistry();
	const loader = new ExtensionLoader(loaderRegistry);
	try {
		const file = join(cwd, "extension.ts");
		await writeFile(
			file,
			"import { createModels } from '@arc/ai/models'; export default { name: 'installed-loader', sections: [{ key: 'extra', render: () => typeof createModels().getModels === 'function' ? 'one' : 'bad' }] }",
		);
		await loader.load(file);
		assert.equal(loaderRegistry.snapshot().extension("installed-loader").sections[0].render(), "one");
		await writeFile(
			file,
			"export default { name: 'installed-loader', sections: [{ key: 'extra', render: () => 'two' }] }",
		);
		await loader.load(file);
		assert.equal(loaderRegistry.snapshot().extension("installed-loader").sections[0].render(), "two");
	} finally {
		await loader.close();
	}
	assert.equal(loaderRegistry.snapshot().extension("installed-loader"), undefined);
	pair.server.onMessage(async (message) => {
		if (!("id" in message)) return;
		let result;
		if (message.method === "initialize")
			result = {
				protocolVersion: LATEST_PROTOCOL_VERSION,
				capabilities: { tools: {} },
				serverInfo: { name: "local", version: "1" },
			};
		else if (message.method === "tools/list")
			result = {
				tools: [
					{
						name: "increment",
						inputSchema: { type: "object", properties: { by: { type: "number" } }, required: ["by"] },
					},
				],
			};
		else if (message.method === "tools/call") {
			const count = await harness.commit(async (tx) => {
				const state = await tx.doc(Counter);
				state.count += message.params.arguments.by;
				return state.count;
			}, context);
			result = { content: [], structuredContent: { count } };
		} else throw new Error("Unexpected method " + message.method);
		await pair.server.send({ jsonrpc: "2.0", id: message.id, result });
	});
	await pair.server.start();
	await client.connect(pair.client);
	assert.equal((await client.listTools())[0].name, "increment");
	registry.install(CodingTools);
	registry.install(createCodemodeExtension({ sandbox, models: false }));
	registry.install({
		name: "bridge",
		tools: [
			defineTool({
				name: "increment",
				description: "Increment the persisted counter through MCP",
				parameters: Type.Object({ by: Type.Number() }),
				structuredOutputSchema: Type.Object({ count: Type.Number() }),
				execute: async (args) => ({ structuredOutput: (await client.callTool("increment", args)).structuredContent }),
			}),
		],
	});
	harness = await openHarness();
	let root = await harness.root(context, { agent: { model: { provider: "faux", modelId: "faux-1" } } });
	const identity = (await harness.snapshot(ProviderDoc, root.id, context)).sessionId;
	const view = await root.watch(context);
	view.start((value) => events.push(value.entries.length));
	subscription = () => view.stop();
	faux.setResponses([
		fauxAssistantMessage(
			[
				fauxToolCall(
					"codemode",
					{
						code: 'const a=await tools.increment({by:1}); const b=await tools.increment({by:2}); await tools.write({path:"saved.txt",content:String(b.count)}); text([a.count,b.count,await tools.read({path:"saved.txt"})]);store("finished",true);',
					},
					{ id: "script" },
				),
			],
			{ stopReason: "toolUse" },
		),
		fauxAssistantMessage([fauxText("done")]),
	]);
	assert.equal((await (await root.submit({ type: "input", content: "run" }, context)).wait(context)).status, "done");
	assert.equal((await harness.snapshot(Counter, context)).count, 3);
	assert.equal(await readFile(join(cwd, "saved.txt"), "utf8"), "3");
	assert.equal((await harness.snapshot(CodemodeStoreDoc, root.id, context)).values.finished, true);
	const page = await root.entries({}, 1000, undefined, context);
	const result = page.items.find(ToolResultEntry.is);
	assert.equal(result.model[0].isError, false);
	assert.ok(result.model[0].content.some((item) => item.type === "text" && item.text === '[1,3,"3"]'));
	assert.equal(result.model[0].details.calls.length, 4);
	await subscription();
	subscription = undefined;
	await harness.close(context);
	harness = await openHarness();
	root = await harness.root(context);
	assert.equal((await harness.snapshot(Counter, context)).count, 3);
	assert.equal((await harness.snapshot(ProviderDoc, root.id, context)).sessionId, identity);
	assert.equal((await harness.snapshot(CodemodeStoreDoc, root.id, context)).values.finished, true);
	assert.deepEqual(reports, []);
	const images = await createNodePhotonImages({ idleMs: 10 });
	const gif = "R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";
	assert.deepEqual(
		await images.prepare(Uint8Array.from(Buffer.from(gif, "base64")), "image/gif", {
			maxWidth: 2000,
			maxHeight: 2000,
			maxBytes: 100000,
		}),
		{ data: gif, mimeType: "image/gif" },
	);
	console.log(JSON.stringify({ counter: 3, viewUpdates: events.length, installed: true, sessionBackends }));
} finally {
	envConnection.close();
	await subscription?.();
	await sandbox.close();
	await client.close();
	await pair.server.close();
	await harness?.close(context);
	await rm(cwd, { recursive: true, force: true });
}
