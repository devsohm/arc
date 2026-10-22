import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it, vi } from "vitest";
import { defineTool } from "@arc/durable";
import { Type } from "typebox";
import { createModels, fauxProvider, fauxAssistantMessage, fauxToolCall } from "@arc/ai";
import { createApplication } from "../src/core/application.ts";
const directories: string[] = [];
afterEach(async () => {
	for (const path of directories.splice(0)) await rm(path, { recursive: true, force: true });
});
async function fixture() {
	const cwd = await mkdtemp(join(tmpdir(), "arc-integrations-"));
	directories.push(cwd);
	const provider = fauxProvider(),
		models = createModels();
	models.setProvider(provider.provider);
	return {
		cwd,
		provider,
		options: {
			cwd,
			home: join(cwd, "home"),
			models,
			model: { provider: "faux", modelId: "faux-1" },
			backend: "memory" as const,
			resources: { contextFiles: [], skills: [], prompts: [], extensionFiles: [] },
		},
	};
}
it("exposes MCP directly to a model without Code Mode", async () => {
	const { provider, options } = await fixture();
	const app = await createApplication({
		...options,
		settings: {
			codemode: false,
			mcpServers: [
				{
					name: "fixture",
					transport: "stdio",
					command: process.execPath,
					args: [fileURLToPath(new URL("./fixtures/mcp-server.mjs", import.meta.url))],
				},
			],
		},
	});
	try {
		expect((await app.snapshot()).agent.tools.map((t) => t.name)).toContain("mcp_fixture_add");
		expect((await app.snapshot()).agent.tools.map((t) => t.name)).not.toContain("codemode");
		expect((await app.command("/mcp")).message).toContain("fixture · connected · 1 tools");
		await app.command("/mcp disconnect fixture");
		expect((await app.snapshot()).agent.tools.map((t) => t.name)).not.toContain("mcp_fixture_add");
		await app.command("/mcp connect fixture");
		expect((await app.snapshot()).agent.tools.map((t) => t.name)).toContain("mcp_fixture_add");
		provider.setResponses([
			fauxAssistantMessage([fauxToolCall("mcp_fixture_add", { a: 2, b: 3 }, { id: "sum" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("five"),
		]);
		expect(await app.run("add")).toEqual({ status: "done", text: "five" });
		const results = (await app.snapshot()).view.entries
			.flatMap((e) => e.model ?? [])
			.filter((m) => m.role === "toolResult");
		expect(results).toContainEqual(
			expect.objectContaining({ toolName: "mcp_fixture_add", isError: false, content: [{ type: "text", text: "5" }] }),
		);
	} finally {
		await app.close();
	}
});
it("runs Code Mode through Durable and the four tools without MCP", async () => {
	const { cwd, provider, options } = await fixture();
	const app = await createApplication(options);
	try {
		expect((await app.snapshot()).agent.tools.map((t) => t.name)).toContain("codemode");
		await app.command("/settings codemode false");
		expect((await app.snapshot()).agent.tools.map((t) => t.name)).not.toContain("codemode");
		await app.command("/settings codemode true");
		expect((await app.snapshot()).settings?.codemode).toBe(true);
		expect((await app.command("/mcp")).message).toContain("No MCP servers connected.");
		provider.setResponses([
			fauxAssistantMessage(
				[
					fauxToolCall(
						"codemode",
						{
							code: 'await tools.write({path:"result.txt",content:"saved"});text(await tools.read({path:"result.txt"}));',
						},
						{ id: "script" },
					),
				],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("saved"),
		]);
		expect(await app.run("save")).toEqual({ status: "done", text: "saved" });
		expect(await readFile(join(cwd, "result.txt"), "utf8")).toBe("saved");
		const result = (await app.snapshot()).view.entries
			.flatMap((e) => e.model ?? [])
			.find((m) => m.role === "toolResult" && m.toolName === "codemode");
		expect(result).toMatchObject({ isError: false });
	} finally {
		await app.close();
	}
});

it.each(["parallel", "sequential"] as const)(
	"the %s execution setting schedules real tools without advertising a mode tool",
	async (mode) => {
		const { provider, options } = await fixture();
		const release = Promise.withResolvers<void>();
		const started: string[] = [];
		let firstFinished = false;
		let secondAfterFirst = false;
		const app = await createApplication({
			...options,
			extensions: [
				{
					name: "schedule-test",
					tools: [
						defineTool({
							name: "first",
							description: "Wait for release",
							parameters: Type.Object({}),
							async execute() {
								started.push("first");
								await release.promise;
								firstFinished = true;
								return { output: [{ type: "text", text: "one" }] };
							},
						}),
						defineTool({
							name: "second",
							description: "Record order",
							parameters: Type.Object({}),
							async execute() {
								started.push("second");
								secondAfterFirst = firstFinished;
								return { output: [{ type: "text", text: "two" }] };
							},
						}),
					],
				},
			],
		});
		try {
			await app.command(`/settings toolExecution ${mode}`);
			const names = (await app.snapshot()).agent.tools.map((tool) => tool.name);
			expect(names).not.toContain("parallel");
			expect(names).not.toContain("sequential");
			provider.setResponses([
				fauxAssistantMessage([fauxToolCall("first", {}, { id: "one" }), fauxToolCall("second", {}, { id: "two" })], {
					stopReason: "toolUse",
				}),
				fauxAssistantMessage("finished"),
			]);
			const work = app.run("Run both tools");
			await vi.waitFor(() => expect(started).toContain("first"));
			if (mode === "parallel") await vi.waitFor(() => expect(started).toContain("second"));
			release.resolve();
			expect(await work).toEqual({ status: "done", text: "finished" });
			expect(secondAfterFirst).toBe(mode === "sequential");
		} finally {
			release.resolve();
			await app.close();
		}
	},
);

it("unloads extension-owned MCP servers when extension code is replaced", async () => {
	const { options, cwd } = await fixture();
	const { writeFile } = await import("node:fs/promises");
	const path = join(cwd, "servers.ts");
	const script = fileURLToPath(new URL("./fixtures/mcp-server.mjs", import.meta.url));
	await writeFile(
		path,
		`export default { name:'dynamic-server', async activate(context){ await context.registerMcpServer({name:'owned',transport:'stdio',command:${JSON.stringify(process.execPath)},args:[${JSON.stringify(script)}]}); } };`,
	);
	const app = await createApplication({ ...options, extensionFiles: [path] });
	try {
		expect((await app.snapshot()).agent.tools.map((t) => t.name)).toContain("mcp_owned_add");
		await writeFile(path, `export default { name:'dynamic-server' };`);
		await app.reload();
		expect((await app.snapshot()).agent.tools.map((t) => t.name)).not.toContain("mcp_owned_add");
		expect((await app.command("/mcp")).message).toContain("No MCP servers connected.");
	} finally {
		await app.close();
	}
});
