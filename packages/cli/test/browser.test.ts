import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import { openBrowser } from "../src/core/authentication/browser.ts";

test.skipIf(process.platform !== "linux")(
	"opens the complete authorization URL as one argument and reports launcher failure",
	async () => {
		const directory = await mkdtemp(join(tmpdir(), "arc-browser-"));
		const launcher = join(directory, "xdg-open");
		const output = join(directory, "url");
		try {
			await writeFile(launcher, '#!/bin/sh\nprintf "%s" "$1" > "$ARC_BROWSER_TEST_OUTPUT"\n');
			await chmod(launcher, 0o700);
			vi.stubEnv("PATH", directory);
			vi.stubEnv("ARC_BROWSER_TEST_OUTPUT", output);
			const url = "https://auth.openai.com/oauth/authorize?state=abc&scope=openid+profile&code_challenge=a-b_c";
			expect(await openBrowser(url)).toBe(true);
			expect(await readFile(output, "utf8")).toBe(url);
			await writeFile(launcher, "#!/bin/sh\nexit 1\n");
			expect(await openBrowser(url)).toBe(false);
			expect(await openBrowser("file:///etc/passwd")).toBe(false);
		} finally {
			vi.unstubAllEnvs();
			await rm(directory, { recursive: true, force: true });
		}
	},
);
