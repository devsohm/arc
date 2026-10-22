import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, PassThrough } from "node:stream";
import { afterEach, expect, it, vi } from "vitest";
import { createModels, fauxProvider, fauxAssistantMessage } from "@arc/ai";
import * as durable from "@arc/durable";
import { createApplication } from "../src/core/application.ts";
import { runPrint } from "../src/modes/print-mode.ts";
import { runJson } from "../src/modes/json-mode.ts";
import { runRpc } from "../src/modes/rpc/rpc-mode.ts";
import type { ApplicationOptions } from "../src/core/application.ts";
const directories: string[] = [];

it("JSON output failure on the initial snapshot releases its real event watch", async () => {
	const { app } = await open();
	const original = durable.watchEvents;
	let stopped = 0;
	const spy = vi.spyOn(durable, "watchEvents").mockImplementation(async (...args) => {
		const stream = await original(...args);
		return {
			...stream,
			stop: () => {
				stopped++;
				return stream.stop();
			},
		};
	});
	try {
		await expect(
			runJson(app, [], async () => {
				throw new Error("Initial output closed");
			}),
		).rejects.toThrow("Initial output closed");
		expect(stopped).toBe(1);
	} finally {
		spy.mockRestore();
		await app.close();
	}
});

it("RPC input failure cancels and joins admitted model work before returning", async () => {
	const { app, provider } = await open(100);
	const input = new PassThrough();
	provider.setResponses([fauxAssistantMessage("A long response that must be cancelled. ".repeat(100))]);
	const result = runRpc(app, input, async () => {}).catch((error: unknown) => error);
	try {
		input.write(
			JSON.stringify({ jsonrpc: "2.0", id: 1, method: "prompt", params: { message: "Respond slowly" } }) + "\n",
		);
		await vi.waitFor(async () => expect((await app.snapshot()).busy).toBe(true));
		await vi.waitFor(() => expect(provider.state.callCount).toBeGreaterThan(0));
		input.destroy(new Error("RPC input disconnected"));
		const error = await result;
		expect(error).toMatchObject({ message: "RPC input disconnected" });
		expect((await app.snapshot()).busy).toBe(false);
		expect(app.ui.supported).toBe(false);
	} finally {
		input.destroy();
		await app.close();
	}
});
afterEach(async () => {
	for (const path of directories.splice(0)) await rm(path, { recursive: true, force: true });
});
async function open(rate = 0, extra: Partial<ApplicationOptions> = {}) {
	const cwd = await mkdtemp(join(tmpdir(), "arc-modes-"));
	directories.push(cwd);
	const provider = fauxProvider({ tokensPerSecond: rate }),
		models = createModels();
	models.setProvider(provider.provider);
	const app = await createApplication({
		cwd,
		home: join(cwd, "home"),
		models,
		model: { provider: "faux", modelId: "faux-1" },
		backend: "memory",
		resources: { contextFiles: [], skills: [], prompts: [], extensionFiles: [] },
		...extra,
	});
	return { app, provider };
}
it("prints the answer belonging to each submitted prompt and command results", async () => {
	const { app, provider } = await open();
	provider.setResponses([fauxAssistantMessage("first"), fauxAssistantMessage("second")]);
	const output: string[] = [];
	try {
		expect(await runPrint(app, ["one", "two", "/tools"], (text) => output.push(text))).toBe(0);
		expect(output.slice(0, 2)).toEqual(["first\n", "second\n"]);
		expect(output[2]).toBe("read\nwrite\nedit\nbash\ncodemode\n");
	} finally {
		await app.close();
	}
});

it("RPC clients answer extension dialogs without blocking the command that opened them", async () => {
	const { app } = await open(0, {
		mode: "rpc",
		extensions: [
			{
				name: "rpc-dialogs",
				commands: [
					{
						name: "choose",
						description: "Choose through RPC",
						async execute(_args, _app, context) {
							expect(context.hasUI).toBe(true);
							expect(context.mode).toBe("rpc");
							const selected = await context.ui.select("Choose", [{ value: "chosen", label: "Chosen" }]);
							const confirmed = await context.ui.confirm("Confirm", "Continue?");
							const text = await context.ui.input("Input", "seed", { secret: true });
							return { message: `${selected}:${confirmed}:${text}` };
						},
					},
				],
			},
		],
	});
	const input = new PassThrough();
	const records: unknown[] = [];
	let id = 10;
	const running = runRpc(app, input, async (record) => {
		records.push(record);
		if (!record || typeof record !== "object") return;
		if ("method" in record && record.method === "extension_ui_request" && "params" in record) {
			const params = record.params;
			if (!params || typeof params !== "object" || !("requestId" in params) || !("method" in params)) return;
			const value = params.method === "select" ? "chosen" : params.method === "confirm" ? true : "secret";
			input.write(
				JSON.stringify({
					jsonrpc: "2.0",
					id: id++,
					method: "extension_ui_response",
					params: { requestId: params.requestId, value },
				}) + "\n",
			);
		}
		if ("id" in record && record.id === 1) input.end();
	});
	try {
		input.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "command", params: { input: "/choose" } }) + "\n");
		await running;
		expect(records).toContainEqual({ jsonrpc: "2.0", id: 1, result: { message: "chosen:true:secret" } });
		expect(records).toContainEqual({ jsonrpc: "2.0", id: 10, result: { accepted: true } });
		expect(app.ui.supported).toBe(false);
	} finally {
		input.destroy();
		await app.close();
	}
});

it("RPC EOF cancels pending extension dialogs and restores the previous UI", async () => {
	const { app } = await open(0, {
		mode: "rpc",
		extensions: [
			{
				name: "rpc-eof",
				commands: [
					{
						name: "wait-ui",
						description: "Wait for RPC UI",
						async execute(_args, _app, context) {
							return { message: (await context.ui.input("Unanswered")) ?? "cancelled" };
						},
					},
				],
			},
		],
	});
	const input = new PassThrough();
	const records: unknown[] = [];
	const running = runRpc(app, input, async (record) => {
		records.push(record);
		if (record && typeof record === "object" && "method" in record && record.method === "extension_ui_request")
			input.end();
	});
	try {
		input.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "command", params: { input: "/wait-ui" } }) + "\n");
		await running;
		expect(records).toContainEqual({ jsonrpc: "2.0", id: 1, result: { message: "cancelled" } });
		expect(app.ui.supported).toBe(false);
	} finally {
		input.destroy();
		await app.close();
	}
});
it("emits a JSON snapshot, actual runtime events and result with clean teardown", async () => {
	const { app, provider } = await open();
	provider.setResponses([fauxAssistantMessage("json answer")]);
	const records: unknown[] = [];
	try {
		expect(
			await runJson(app, ["hello"], async (value) => {
				records.push(value);
			}),
		).toBe(0);
		expect(records[0]).toMatchObject({ type: "snapshot", entries: [] });
		expect(records).toContainEqual(expect.objectContaining({ type: "message_end" }));
		expect(records).toContainEqual({ type: "result", status: "done", text: "json answer" });
	} finally {
		await app.close();
	}
});
it("validates JSON-RPC boundaries and dispatches real application operations", async () => {
	const { app, provider } = await open();
	provider.setResponses([fauxAssistantMessage("rpc answer")]);
	const records: unknown[] = [];
	const lines =
		[
			"bad json",
			JSON.stringify({ jsonrpc: "1.0", id: 0, method: "get_state" }),
			JSON.stringify({ jsonrpc: "2.0", id: 1, method: "prompt", params: { message: "hello" } }),
			JSON.stringify({ jsonrpc: "2.0", id: 2, method: "missing" }),
			JSON.stringify({ jsonrpc: "2.0", id: 3, method: "command", params: { input: "/name RPC" } }),
		].join("\n") + "\n";
	try {
		await runRpc(app, Readable.from([lines]), async (value) => {
			records.push(value);
		});
		expect(records).toContainEqual({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Invalid JSON" } });
		expect(records).toContainEqual({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid request" } });
		expect(records).toContainEqual({ jsonrpc: "2.0", id: 1, result: { status: "done", text: "rpc answer" } });
		expect(records).toContainEqual({
			jsonrpc: "2.0",
			id: 2,
			error: { code: -32601, message: "Unknown method: missing" },
		});
		expect(records).toContainEqual({ jsonrpc: "2.0", id: 3, result: { message: "Session name: RPC" } });
	} finally {
		await app.close();
	}
});
it("does not block an abort request behind an in-flight prompt", async () => {
	const { app, provider } = await open(1);
	provider.setResponses([fauxAssistantMessage("wait")]);
	const input = new PassThrough();
	const records: unknown[] = [];
	const running = runRpc(app, input, async (value) => {
		records.push(value);
	});
	try {
		input.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "prompt", params: { message: "wait" } }) + "\n");
		await new Promise<void>((resolve, reject) => {
			const timer = setTimeout(() => {
				stop();
				reject(new Error("Prompt did not start"));
			}, 1500);
			const stop = app.subscribe((state) => {
				if (state.busy) {
					clearTimeout(timer);
					stop();
					resolve();
				}
			});
		});
		input.end(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "abort" }) + "\n");
		await running;
		expect(records).toContainEqual({ jsonrpc: "2.0", id: 2, result: {} });
		expect(records).toContainEqual(
			expect.objectContaining({ id: 1, result: expect.objectContaining({ status: "unanswered" }) }),
		);
	} finally {
		input.destroy();
		await app.close();
	}
});

it("propagates RPC output failures without leaving notifications or requests running", async () => {
	const { app } = await open();
	try {
		await expect(
			runRpc(app, Readable.from([JSON.stringify({ jsonrpc: "2.0", id: 1, method: "get_state" }) + "\n"]), async () => {
				throw new Error("Output closed");
			}),
		).rejects.toThrow("Output closed");
	} finally {
		await app.close();
	}
});
it("propagates JSON event output failures", async () => {
	const { app, provider } = await open();
	provider.setResponses([fauxAssistantMessage("answer")]);
	let writes = 0;
	try {
		await expect(
			runJson(app, ["hello"], async () => {
				if (++writes > 1) throw new Error("Event output closed");
			}),
		).rejects.toThrow("Event output closed");
	} finally {
		await app.close();
	}
});
