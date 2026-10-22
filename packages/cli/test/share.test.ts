import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { shareHtml } from "../src/core/sessions/share.ts";
const paths: string[] = [];
afterEach(async () => {
	vi.unstubAllEnvs();
	for (const path of paths.splice(0)) await rm(path, { recursive: true, force: true });
});

test.skipIf(process.platform === "win32")(
	"sharing sends only a secret HTML gist and removes its temporary document",
	async () => {
		const directory = await mkdtemp(join(tmpdir(), "arc-gh-fixture-"));
		paths.push(directory);
		const receipt = join(directory, "receipt.json"),
			command = join(directory, "gh");
		await writeFile(
			command,
			`#!${process.execPath}\nimport fs from 'node:fs';const args=process.argv.slice(2);fs.writeFileSync(${JSON.stringify(receipt)},JSON.stringify({args,html:fs.readFileSync(args.at(-1),'utf8')}));console.log('https://gist.github.com/fixture');\n`,
		);
		await chmod(command, 0o700);
		vi.stubEnv("PATH", `${directory}${delimiter}${process.env.PATH ?? ""}`);
		expect(await shareHtml("<html>owned transcript</html>", new AbortController().signal)).toBe(
			"https://gist.github.com/fixture",
		);
		const result = JSON.parse(await readFile(receipt, "utf8"));
		expect(result.args.slice(0, 3)).toEqual(["gist", "create", "--public=false"]);
		expect(result.html).toBe("<html>owned transcript</html>");
		await expect(readFile(result.args[3])).rejects.toMatchObject({ code: "ENOENT" });
	},
);
