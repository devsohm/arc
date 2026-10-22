import { writeFile, appendFile } from "node:fs/promises";
import { join } from "node:path";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } from "@arc/ai";
import { defineTool } from "@arc/durable";
import { openNodeSqliteStorage } from "@arc/durable/storage/sqlite/node";
import { Type } from "typebox";
import { createApplication } from "../../src/core/application.ts";
import { runInteractive } from "../../src/modes/interactive/interactive-mode.ts";

const directory = process.argv[2];
const replay = process.argv[3];
const generation = process.argv[4] === "generation";
const models = createModels();
const provider = fauxProvider({ tokensPerSecond: generation ? 10 : undefined });
models.setProvider(provider.provider);
provider.setResponses([
	generation
		? fauxAssistantMessage("Partial response ".repeat(100))
		: fauxAssistantMessage([fauxToolCall("checkpoint_write", {})], { stopReason: "toolUse" }),
]);
const keepAlive = setInterval(() => {}, 1000);
const app = await createApplication({
	cwd: directory,
	home: join(directory, "home"),
	models,
	storage: await openNodeSqliteStorage(join(directory, "interrupted.sqlite")),
	model: { provider: "faux", modelId: "faux-1" },
	settings: { codemode: false },
	resources: { contextFiles: [], skills: [], prompts: [], extensionFiles: [] },
	extensions: [
		{
			name: "checkpoint",
			tools: [
				defineTool({
					name: "checkpoint_write",
					description: "A controlled file write",
					parameters: Type.Object({}),
					replay,
					async execute(_args, _api, context) {
						await appendFile(join(directory, "attempts.txt"), "attempt\n");
						await writeFile(join(directory, "started"), "ready");
						process.stdout.write("WRITE_STARTED\n");
						await new Promise((resolve) => context.abortSignal.addEventListener("abort", resolve, { once: true }));
						context.abortSignal.throwIfAborted();
						return { output: [{ type: "text", text: "written" }] };
					},
				}),
			],
		},
	],
});
if (generation) {
	let announced = false;
	app.subscribe((state) => {
		if (!announced && state.live.generation?.message?.content.some((part) => part.type === "text" && part.text)) {
			announced = true;
			process.stdout.write("WRITE_STARTED\n");
		}
	});
}
const noop = () => {};
const terminal = {
	columns: 80,
	rows: 24,
	kittyProtocolActive: false,
	start: noop,
	stop: noop,
	drainInput: async () => {},
	write: noop,
	moveBy: noop,
	hideCursor: noop,
	showCursor: noop,
	clearLine: noop,
	clearFromCursor: noop,
	clearScreen: noop,
	setTitle: noop,
	setProgress: noop,
	setProgramStatus: noop,
};
const interactive = runInteractive(app, { terminal });
void app.run("Write the test file and finish the turn").catch(() => {});
await interactive;
await app.close({ preserveWork: true });
clearInterval(keepAlive);
