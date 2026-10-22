import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, expect, test } from "vitest";
import { createModels, fauxProvider, fauxAssistantMessage, type Message } from "@arc/ai";
import type { UserInput } from "@arc/durable";
import { createApplication } from "../src/sdk.ts";
import { processFileArguments } from "../src/cli/file-processor.ts";
import { runPrint } from "../src/modes/print-mode.ts";
import { runJson } from "../src/modes/json-mode.ts";
import { runRpc } from "../src/modes/rpc/rpc-mode.ts";

const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==";
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
async function fixture() {
	const cwd = await mkdtemp(join(tmpdir(), "arc-attachments-"));
	cleanups.push(() => rm(cwd, { recursive: true, force: true }));
	const provider = fauxProvider({ models: [{ id: "vision", input: ["text", "image"] }] });
	const models = createModels();
	models.setProvider(provider.provider);
	const app = await createApplication({
		cwd,
		home: join(cwd, "home"),
		models,
		backend: "memory",
		model: { provider: "faux", modelId: "vision" },
		resources: { contextFiles: [], skills: [], prompts: [], extensionFiles: [] },
	});
	cleanups.push(() => app.close());
	return { cwd, app, provider };
}

test("file arguments make one ordered multimodal message using file bytes rather than extensions", async () => {
	const { cwd } = await fixture();
	await writeFile(join(cwd, "notes.md"), "\ufeffRead this\n");
	await writeFile(join(cwd, "picture.bin"), Buffer.from(png, "base64"));
	await writeFile(join(cwd, "empty"), "");
	expect(await processFileArguments(["@notes.md", "@picture.bin", "@empty", "Explain", "both"], cwd)).toEqual([
		[
			{ type: "text", text: `<file name=${JSON.stringify(join(cwd, "notes.md"))}>\nRead this\n\n</file>` },
			{ type: "text", text: `<file name=${JSON.stringify(join(cwd, "picture.bin"))}></file>` },
			{ type: "image", data: png, mimeType: "image/png" },
			{ type: "text", text: "Explain both" },
		],
	]);
	expect(await processFileArguments(["hello", "world"], cwd)).toEqual(["hello world"]);
	await expect(processFileArguments(["@absent"], cwd)).rejects.toThrow();
	await expect(processFileArguments(["@."], cwd)).rejects.toThrow("not a file");
});

test.each(["sdk", "text", "json", "rpc"])(
	"%s carries images through the real Harness into the provider and committed history",
	async (mode) => {
		const { app, provider } = await fixture();
		const content: UserInput = [
			{ type: "text", text: "Describe" },
			{ type: "image", data: png, mimeType: "image/png" },
		];
		let seen: readonly Message[] = [];
		provider.setResponses([
			(transcript) => {
				seen = transcript.messages;
				return fauxAssistantMessage("A pixel");
			},
		]);
		if (mode === "sdk") expect(await app.run(content)).toEqual({ status: "done", text: "A pixel" });
		else if (mode === "text") expect(await runPrint(app, [content], () => {})).toBe(0);
		else if (mode === "json") expect(await runJson(app, [content], async () => {})).toBe(0);
		else {
			const records: unknown[] = [];
			await runRpc(
				app,
				Readable.from([
					JSON.stringify({ jsonrpc: "2.0", id: 1, method: "prompt", params: { message: content } }) + "\n",
				]),
				async (record) => {
					records.push(record);
				},
			);
			expect(records).toContainEqual({ jsonrpc: "2.0", id: 1, result: { status: "done", text: "A pixel" } });
		}
		expect(seen).toContainEqual(expect.objectContaining({ role: "user", content }));
		expect((await app.snapshot()).view.entries.flatMap((entry) => entry.model ?? [])).toContainEqual(
			expect.objectContaining({ role: "user", content }),
		);
	},
);

test("invalid multimodal input fails before history changes and a later valid request still works", async () => {
	const { app, provider } = await fixture();
	for (const message of [
		[],
		[{ type: "text", text: " " }],
		[{ type: "image", mimeType: "image/png" }],
		[{ type: "toolCall", name: "bash" }],
	]) {
		const records: unknown[] = [];
		await runRpc(
			app,
			Readable.from([JSON.stringify({ jsonrpc: "2.0", id: 1, method: "prompt", params: { message } }) + "\n"]),
			async (record) => {
				records.push(record);
			},
		);
		expect(records).toContainEqual(
			expect.objectContaining({ id: 1, error: expect.objectContaining({ code: -32000 }) }),
		);
	}
	await expect(app.run([{ type: "image", data: "broken", mimeType: "image/png" }])).rejects.toThrow("Cannot decode");
	expect((await app.snapshot()).view.entries).toEqual([]);
	provider.setResponses([fauxAssistantMessage("ok")]);
	expect(await app.run("valid")).toEqual({ status: "done", text: "ok" });
});

test("HTML export includes attached images without external image or script access", async () => {
	const { app, provider, cwd } = await fixture();
	provider.setResponses([fauxAssistantMessage("A pixel")]);
	await app.run([{ type: "image", data: png, mimeType: "image/png" }]);
	await app.command("/export");
	const html = await readFile(join(cwd, "conversation.html"), "utf8");
	expect(html).toContain(`<img alt="Attached image" src="data:image/png;base64,${png}">`);
	expect(html).toContain("default-src 'none'; style-src 'unsafe-inline'; img-src data:");
});
