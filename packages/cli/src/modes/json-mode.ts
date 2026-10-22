import type { UserInput } from "@arc/durable";
import { watchEvents } from "@arc/durable";
import type { Application } from "../core/types.ts";
export async function runJson(
	app: Application,
	prompts: readonly UserInput[],
	write: (record: unknown) => Promise<void>,
): Promise<number> {
	const stream = await watchEvents(app.harness, app.conversation.id, app.context);
	let failure: { error: unknown } | undefined;
	try {
		await write(stream.snapshot);
		stream.start(async (events) => {
			try {
				for (const event of events) await write(event);
			} catch (error) {
				failure = { error };
				void app.abort().catch(() => {});
				throw error;
			}
		});
		for (const prompt of prompts) {
			if (typeof prompt === "string" && prompt.startsWith("/"))
				throw new Error("JSON mode accepts conversation input. Use RPC for commands.");
			const result = await app.run(prompt);
			await write({ type: "result", ...result });
			if (result.status !== "done") return 1;
		}
		return 0;
	} finally {
		await stream.stop();
		if (failure) throw failure.error;
	}
}
