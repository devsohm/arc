import { execFile } from "node:child_process";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
const run = promisify(execFile);

export async function shareHtml(html: string, signal: AbortSignal): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), "arc-share-"));
	try {
		const file = join(directory, "conversation.html");
		await writeFile(file, html, { mode: 0o600 });
		const result = await run("gh", ["gist", "create", "--public=false", file], {
			signal,
			timeout: 60_000,
			maxBuffer: 1024 * 1024,
		});
		const url = result.stdout.trim();
		if (!URL.canParse(url) || new URL(url).origin !== "https://gist.github.com")
			throw new Error("GitHub CLI returned an invalid gist URL");
		return url;
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
}
