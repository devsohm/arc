import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels, fauxProvider, fauxAssistantMessage, fauxToolCall } from "@arc/ai";
import { createRegistry, defineDoc, defineTask, Harness, ToolResultEntry } from "@arc/durable";
import { BACKGROUND_CONTEXT as context } from "@arc/durable/context";
import { ExtensionLoader } from "@arc/durable/extensions/node";
import { openNodeSqliteStorage } from "@arc/durable/storage/sqlite/node";

const directory = await mkdtemp(join(tmpdir(), "arc-extensions-"));
let harness;
let loader;
try {
	const entry = join(directory, "extension.ts");
	const helper = join(directory, "helper.ts");
	const write = async (value) => {
		await writeFile(helper, `export const Version: { current: number } = { current: ${value} };`);
		await writeFile(
			entry,
			`
			import { readFileSync } from 'node:fs';
			import { defineTask } from '@arc/durable';
			import { Type } from '@arc/ai';
			import { createModels } from '@arc/ai/models';
			if (typeof createModels().getModels !== 'function') throw Error('models subpath');
			import { Version } from './helper.ts';
			const value = Version.current;
			if (readFileSync(new URL('./asset.txt', import.meta.url), 'utf8') !== 'asset') throw Error('asset path');
			if (defineTask !== globalThis.expectedDefineTask) throw Error('package identity');
			export default { name: 'worker', tools: [{ name: 'version', description: 'Return the loaded version', parameters: Type.Object({}), async execute() { return { output: [{type:'text',text:String(value)}] }; } }], tasks: [defineTask({
				name: 'work', version: 1, initial: () => ({ phase: 'run' }),
				phases: { async run(_record, runtime, context) {
					if (value === 1) { globalThis.taskStarted(); await globalThis.taskGate; }
					await runtime.commit(() => ({ status: 'terminal', outcome: { status: 'completed', result: value } }), context);
				} }, async abort() {}
			})] };
		`,
		);
	};
	await writeFile(join(directory, "asset.txt"), "asset");
	globalThis.expectedDefineTask = defineTask;
	const registry = createRegistry();
	loader = new ExtensionLoader(registry);
	await write(1);
	const first = await loader.load(entry);
	assert.equal(registry.snapshot().extension("worker"), first);
	// Native stripping refuses syntax that needs generated JavaScript.
	await writeFile(entry, "enum Choice { value } export default { name: 'worker' };");
	await assert.rejects(loader.load(entry), { code: "ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX" });
	assert.equal(registry.snapshot().extension("worker"), first);
	for (const suffix of ["mts", "mjs", "js"]) {
		const path = join(directory, `native.${suffix}`);
		await writeFile(
			path,
			suffix === "mts"
				? `type Name = string; const name: Name = "native-${suffix}"; export default { name };`
				: `export default { name: "native-${suffix}" };`,
		);
		const loaded = await loader.load(path);
		assert.equal(registry.snapshot().extension(`native-${suffix}`), loaded);
		assert.equal(await loader.unload(path), true);
		assert.equal(registry.snapshot().extension(`native-${suffix}`), undefined);
		assert.equal(await loader.unload(path), false);
	}
	const tsx = join(directory, "native.tsx");
	await writeFile(tsx, "export default <span />;");
	await assert.rejects(loader.load(tsx), { code: "ERR_UNKNOWN_FILE_EXTENSION" });
	await writeFile(entry, "this is not TypeScript !!");
	await assert.rejects(loader.load(entry));
	assert.equal(registry.snapshot().extension("worker"), first);
	await writeFile(entry, "export default { name: 'worker', tools: [{name: 'x'}, {name: 'x'}] }");
	await assert.rejects(loader.load(entry), /two tools/);
	assert.equal(registry.snapshot().extension("worker"), first);
	await writeFile(entry, "export default null");
	await assert.rejects(loader.load(entry), /default-export/);
	assert.equal(registry.snapshot().extension("worker"), first);
	await writeFile(entry, "export default { name: 'renamed' }");
	await assert.rejects(loader.load(entry), /cannot rename/);
	const other = join(directory, "other.mjs");
	await writeFile(other, "export default { name: 'worker' }");
	await assert.rejects(loader.load(other), /another registration/);
	const cjs = join(directory, "extension.cjs");
	await writeFile(cjs, "module.exports = { name: 'commonjs' }");
	await assert.rejects(loader.load(cjs), /must use ESM/);
	await write(1);
	await loader.load(entry);
	const State = defineDoc({ kind: "loader-state", scope: "session", version: 1, initial: () => ({ count: 0 }) });
	const database = join(directory, "session.sqlite");
	const models = createModels();
	const provider = fauxProvider();
	models.setProvider(provider.provider);
	harness = await Harness.open(await openNodeSqliteStorage(database), { registry, models }, context);
	let root = await harness.root(context);
	await root.commit(async (tx) => {
		(await tx.doc(State)).count = 42;
	}, context);
	const runTool = async (version) => {
		await root.configure(
			{
				model: { provider: "faux", modelId: "faux-1" },
				extensions: [registry.snapshot().extension("worker")],
				tools: registry.snapshot().extension("worker").tools,
			},
			context,
		);
		provider.setResponses([
			fauxAssistantMessage([fauxToolCall("version", {}, { id: `tool-${version}` })], { stopReason: "toolUse" }),
			fauxAssistantMessage("Done"),
		]);
		assert.equal(
			(await (await root.submit({ type: "input", content: "Check version" }, context)).wait(context)).status,
			"done",
		);
		const entries = await harness.storage.scanEntries({ conversationId: root.id }, 100, undefined, context);
		const result = entries.items.find(
			(entry) => ToolResultEntry.is(entry) && entry.model?.[0]?.toolCallId === `tool-${version}`,
		);
		assert.equal(result.model[0].content[0].text, String(version));
	};
	const task = () => registry.snapshot().task("work");
	const start = () =>
		root.commit((tx) => tx.createTask(task(), null, { ownership: { kind: "conversation" } }), context);
	let release;
	globalThis.taskGate = new Promise((resolve) => {
		release = resolve;
	});
	const started = new Promise((resolve) => {
		globalThis.taskStarted = resolve;
	});
	const firstId = await start();
	const running = harness.waitForTask(firstId, context);
	await started;
	await write(2);
	await loader.load(entry);
	release();
	assert.equal((await running).state.outcome.result, 1);
	const secondId = await start();
	assert.equal((await harness.waitForTask(secondId, context)).state.outcome.result, 2);
	await runTool(2);
	await harness.close(context);
	harness = undefined;
	await loader.close();
	assert.equal(registry.snapshot().extension("worker"), undefined);
	loader = new ExtensionLoader(registry);
	await write(3);
	await loader.load(entry);
	harness = await Harness.open(await openNodeSqliteStorage(database), { registry, models }, context);
	root = await harness.root(context);
	assert.equal((await harness.snapshot(State, undefined, context)).count, 42);
	assert.equal((await harness.getTask(firstId, context)).state.outcome.result, 1);
	assert.equal((await harness.getTask(secondId, context)).state.outcome.result, 2);
	assert.equal((await harness.waitForTask(await start(), context)).state.outcome.result, 3);
	await runTool(3);
	await harness.close(context);
	harness = undefined;
	const replacement = { name: "worker" };
	registry.install(replacement);
	assert.equal(await loader.unload(entry), true);
	assert.equal(registry.snapshot().extension("worker"), replacement);
	assert.equal(await loader.unload(entry), false);
	const broken = join(directory, "listener.mjs");
	await writeFile(broken, "export default { name: 'listener' }");
	const unsubscribe = registry.subscribe(() => {
		throw Error("listener failed");
	});
	await assert.rejects(loader.load(broken), /listener failed/);
	assert.equal(registry.snapshot().extension("listener").name, "listener");
	unsubscribe();
	const admitted = loader.load(broken);
	const closing = loader.close();
	await admitted;
	assert.equal(loader.close(), closing);
	await closing;
	assert.equal(registry.snapshot().extension("listener"), undefined);
	await assert.rejects(loader.load(entry), /closed/);
	console.log(JSON.stringify({ modules: true, ownership: true, harness: [1, 2, 3], persisted: 42 }));
} finally {
	await harness?.close(context);
	await loader?.close();
	await rm(directory, { recursive: true, force: true });
}
