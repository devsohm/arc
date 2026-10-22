import type { UserInput } from "@arc/durable";
import type { Application } from "../core/types.ts";

export async function runPrint(
	app: Application,
	prompts: readonly UserInput[],
	write: (text: string) => void,
): Promise<number> {
	for (const prompt of prompts) {
		if (typeof prompt === "string" && prompt.startsWith("/")) {
			const result = await app.command(prompt);
			if (result.message) write(result.message + "\n");
			if (result.quit) return 0;
			if (result.editorText) {
				const answer = await app.run(result.editorText);
				write(answer.text + "\n");
				if (answer.status !== "done") return 1;
			}
		} else {
			const answer = await app.run(prompt);
			write(answer.text + "\n");
			if (answer.status !== "done") return 1;
		}
	}
	return 0;
}
