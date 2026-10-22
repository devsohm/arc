import { createInterface } from "node:readline";
import type { Readable } from "node:stream";
import { Type } from "@arc/ai";
import { Value } from "typebox/value";
import type { Application } from "../../core/types.ts";

import { parseInput } from "../../core/input.ts";
import { createRpcUI } from "./ui.ts";

const requestSchema = Type.Object(
	{
		jsonrpc: Type.Literal("2.0"),
		id: Type.Union([Type.String(), Type.Number()]),
		method: Type.String(),
		params: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
	},
	{ additionalProperties: false },
);
function text(value: unknown, name: string): string {
	if (typeof value !== "string") throw new Error(`${name} must be a string`);
	return value;
}
export async function runRpc(
	app: Application,
	input: Readable,
	write: (record: unknown) => Promise<void>,
	signal?: AbortSignal,
): Promise<void> {
	const lines = createInterface({ input, crlfDelay: Infinity });
	let bridge: ReturnType<typeof createRpcUI> | undefined;
	const abort = () => {
		bridge?.close();
		lines.close();
		void app.abort().catch(() => {});
	};
	let inputFailure: { error: unknown } | undefined;
	const inputError = (error: unknown) => {
		inputFailure ??= { error };
		abort();
	};
	input.on("error", inputError);
	signal?.addEventListener("abort", abort, { once: true });
	if (signal?.aborted) abort();
	const pending = new Set<Promise<void>>(),
		active = new Set<string | number>();
	let output = Promise.resolve();
	let outputFailure: { error: unknown } | undefined;
	const send = (record: unknown) => {
		if (outputFailure) return Promise.reject(outputFailure.error);
		const next = output.then(() => write(record));
		output = next.catch((error) => {
			outputFailure ??= { error };
			abort();
		});
		return next;
	};
	bridge = createRpcUI(send);
	const detachUI = app.attachUI(bridge.ui);
	if (signal?.aborted) bridge.close();
	const stop = app.subscribe((state) => {
		void send({
			jsonrpc: "2.0",
			method: "state",
			params: {
				conversationId: state.view.conversation.id,
				sessionFile: state.sessionFile,
				entries: state.view.entries,
				live: state.live,
				userBash: state.userBash,
				inbox: state.inbox,
				usage: state.usage,
				model: state.agent.model,
				thinkingLevel: state.agent.thinkingLevel,
				busy: state.busy,
			},
		}).catch(() => {});
	});
	const dispatch = async (raw: string): Promise<void> => {
		let data: unknown;
		try {
			data = JSON.parse(raw);
		} catch {
			await send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Invalid JSON" } });
			return;
		}
		if (!Value.Check(requestSchema, data)) {
			await send({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid request" } });
			return;
		}
		if (active.has(data.id)) {
			await send({ jsonrpc: "2.0", id: data.id, error: { code: -32600, message: "Request ID is already active" } });
			return;
		}
		active.add(data.id);
		try {
			const params = data.params ?? {};
			let result: unknown;
			switch (data.method) {
				case "bash":
					if (params.excludeFromContext !== undefined && typeof params.excludeFromContext !== "boolean")
						throw new Error("excludeFromContext must be a boolean");
					result = await app.executeBash(text(params.command, "command"), {
						excludeFromContext: params.excludeFromContext,
					});
					break;
				case "extension_ui_response":
					result = { accepted: bridge.respond(params) };
					break;
				case "prompt":
					result = await app.run(parseInput(params.message));
					break;
				case "steer":
				case "follow_up": {
					const submission = await app.submit(parseInput(params.message), {
						whenBusy: data.method === "steer" ? "steer" : "followUp",
					});
					result = submission ? { submissionId: submission.id } : { handled: true };
					break;
				}
				case "abort":
					await app.abort();
					result = {};
					break;
				case "command":
					result = await app.command(text(params.input, "input"));
					break;
				case "get_state": {
					const state = await app.snapshot();
					result = {
						conversationId: state.view.conversation.id,
						sessionFile: state.sessionFile,
						entries: state.view.entries,
						live: state.live,
						userBash: state.userBash,
						inbox: state.inbox,
						usage: state.usage,
						model: state.agent.model,
						thinkingLevel: state.agent.thinkingLevel,
						busy: state.busy,
					};
					break;
				}
				case "get_commands":
					result = app.commands();
					break;
				case "get_models":
					result = app.models.getModels();
					break;
				default:
					await send({
						jsonrpc: "2.0",
						id: data.id,
						error: { code: -32601, message: `Unknown method: ${data.method}` },
					});
					return;
			}
			await send({ jsonrpc: "2.0", id: data.id, result });
		} catch (error) {
			await send({
				jsonrpc: "2.0",
				id: data.id,
				error: { code: -32000, message: error instanceof Error ? error.message : String(error) },
			});
		} finally {
			active.delete(data.id);
		}
	};
	try {
		for await (const line of lines) {
			if (!line.trim()) continue;
			const task = dispatch(line);
			pending.add(task);
			void task.finally(() => pending.delete(task)).catch(() => {});
		}
		bridge.close();
		await Promise.all(pending);
		await output;
		if (inputFailure) throw inputFailure.error;
		if (outputFailure) throw outputFailure.error;
	} catch (error) {
		bridge.close();
		await app.abort().catch(() => {});
		await Promise.allSettled(pending);
		throw error;
	} finally {
		bridge.close();
		await detachUI();
		signal?.removeEventListener("abort", abort);
		stop();
		input.removeListener("error", inputError);
		lines.close();
	}
}
