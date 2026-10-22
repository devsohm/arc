import { readFile, stat } from "node:fs/promises";
import type { UserInput } from "@arc/durable";
import { BACKGROUND_CONTEXT } from "@arc/durable/context";
import { NodeExecutionEnv } from "@arc/durable/env/node";
import { detectSupportedImageMimeType, resolveReadToolPath } from "@arc/durable/tools";

const MAX_FILE_BYTES = 16 * 1024 * 1024;

export async function processFileArguments(args: readonly string[], cwd: string): Promise<UserInput[]> {
	const paths = args.filter((arg) => arg.startsWith("@"));
	const message = args.filter((arg) => !arg.startsWith("@")).join(" ");
	if (!paths.length) return message ? [message] : [];
	const content: Exclude<UserInput, string> = [];
	const env = new NodeExecutionEnv({ cwd });
	let total = 0;
	for (const path of paths) {
		const absolute = await resolveReadToolPath(env, path, BACKGROUND_CONTEXT);
		const info = await stat(absolute);
		if (!info.isFile()) throw new Error(`Attachment is not a file: ${absolute}`);
		total += info.size;
		if (total > MAX_FILE_BYTES) throw new Error("Attachments exceed 16 MiB");
		if (!info.size) continue;
		const bytes = await readFile(absolute);
		const mimeType = detectSupportedImageMimeType(bytes);
		if (mimeType) {
			content.push({ type: "text", text: `<file name=${JSON.stringify(absolute)}></file>` });
			content.push({ type: "image", data: bytes.toString("base64"), mimeType });
		} else
			content.push({
				type: "text",
				text: `<file name=${JSON.stringify(absolute)}>\n${bytes.toString("utf8").replace(/^\uFEFF/, "")}\n</file>`,
			});
	}
	if (message) content.push({ type: "text", text: message });
	return content.length ? [content] : [];
}
