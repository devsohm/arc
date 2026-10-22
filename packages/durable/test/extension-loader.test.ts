import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

it("loads and replaces modules through the native Node loader and a SQLite-backed Harness", () => {
	const result = spawnSync(
		process.execPath,
		["--conditions=source", fileURLToPath(new URL("./fixtures/extension-loader.mjs", import.meta.url))],
		{ encoding: "utf8", timeout: 25_000 },
	);
	expect(result.error).toBeUndefined();
	expect(result.stderr, result.stdout).not.toContain("AssertionError");
	expect(result.status, result.stderr).toBe(0);
	expect(JSON.parse(result.stdout)).toEqual({ modules: true, ownership: true, harness: [1, 2, 3], persisted: 42 });
}, 30_000);
