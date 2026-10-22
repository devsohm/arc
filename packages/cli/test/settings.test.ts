import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadSettings, saveSettings } from "../src/core/configuration/settings.ts";

let directory: string;
let home: string;
let cwd: string;

beforeEach(async () => {
	directory = await mkdtemp(join(tmpdir(), "arc-settings-test-"));
	home = join(directory, "home");
	cwd = join(directory, "project");
	await mkdir(join(cwd, ".arc"), { recursive: true });
});

afterEach(async () => {
	await rm(directory, { recursive: true, force: true });
});

async function writeGlobal(data: unknown): Promise<void> {
	await mkdir(home, { recursive: true });
	await writeFile(join(home, "settings.json"), JSON.stringify(data));
}

describe("application settings", () => {
	it("merges saved model thinking entries under the file lock and validates their levels", async () => {
		await Promise.all([
			saveSettings(home, { modelThinkingLevels: { "one/alpha": "high" } }),
			saveSettings(home, { modelThinkingLevels: { "two/beta": "low" } }),
		]);
		expect((await loadSettings({ cwd, home })).modelThinkingLevels).toEqual({ "one/alpha": "high", "two/beta": "low" });
		await writeGlobal({ modelThinkingLevels: { "one/alpha": "invalid" } });
		await expect(loadSettings({ cwd, home })).rejects.toThrow("Invalid settings");
	});
	it("returns independent defaults without creating home files", async () => {
		const settings = await loadSettings({ cwd, home });
		expect(settings).toEqual({
			toolExecution: "parallel",
			fullscreen: false,
			extensionFiles: [],
			mcpServers: [],
			codemode: true,
			resourcePaths: [],
		});
		settings.extensionFiles.push("mutated");
		expect((await loadSettings({ cwd, home })).extensionFiles).toEqual([]);
		await expect(stat(home)).rejects.toMatchObject({ code: "ENOENT" });
	});

	it("applies project precedence, replaces arrays, and resolves paths from each file's base", async () => {
		await writeGlobal({
			model: { provider: "fixture", modelId: "global-model" },
			thinkingLevel: "low",
			toolExecution: "sequential",
			fullscreen: true,
			extensionFiles: ["extensions/global.ts"],
			resourcePaths: ["resources"],
			mcpServers: [{ name: "global", transport: "stdio", command: "fixture-global", cwd: "servers" }],
		});
		await writeFile(
			join(cwd, ".arc", "settings.json"),
			JSON.stringify({
				thinkingLevel: "high",
				fullscreen: false,
				extensionFiles: ["extensions/project.ts"],
				mcpServers: [],
			}),
		);
		expect(await loadSettings({ cwd, home })).toEqual({
			model: { provider: "fixture", modelId: "global-model" },
			thinkingLevel: "high",
			toolExecution: "sequential",
			fullscreen: false,
			extensionFiles: [join(cwd, "extensions/project.ts")],
			resourcePaths: [join(home, "resources")],
			mcpServers: [],
			codemode: true,
		});
	});

	it("loads the configured stdio and HTTP MCP variants", async () => {
		await writeGlobal({
			mcpServers: [
				{
					name: "stdio",
					transport: "stdio",
					command: "fixture-command",
					args: ["--fixture"],
					env: { FIXTURE: "value" },
					cwd: "server",
				},
				{
					name: "http",
					transport: "http",
					url: "http://127.0.0.1:3210/mcp",
					headers: { Authorization: "fixture-secret" },
				},
			],
		});
		expect((await loadSettings({ cwd, home })).mcpServers).toEqual([
			{
				name: "stdio",
				transport: "stdio",
				command: "fixture-command",
				args: ["--fixture"],
				env: { FIXTURE: "value" },
				cwd: join(home, "server"),
			},
			{
				name: "http",
				transport: "http",
				url: "http://127.0.0.1:3210/mcp",
				headers: { Authorization: "fixture-secret" },
			},
		]);
	});

	it.each([
		{ unknown: true },
		{ model: "fixture/model" },
		{ model: { provider: "fixture", modelId: "model", extra: true } },
		{ thinkingLevel: "unlimited" },
		{ toolExecution: "random" },
		{ fullscreen: "true" },
		{ extensionFiles: "./extension.ts" },
		{ resourcePaths: [""] },
		{ mcpServers: [{ name: "fixture", transport: "stdio", command: "x", url: "https://example.invalid" }] },
		{
			mcpServers: [
				{ name: "fixture", transport: "http", url: "not a URL", headers: { Authorization: "fixture-secret" } },
			],
		},
		{ mcpServers: [{ name: "fixture", transport: "http", url: "file:///fixture" }] },
		{
			mcpServers: [
				{ name: "same", transport: "stdio", command: "x" },
				{ name: "same", transport: "stdio", command: "y" },
			],
		},
	])("rejects unknown keys or invalid typed values without modifying the file", async (data) => {
		await writeGlobal(data);
		const before = await readFile(join(home, "settings.json"), "utf8");
		await expect(loadSettings({ cwd, home })).rejects.toThrow(/Invalid settings/);
		await expect(saveSettings(home, { fullscreen: false })).rejects.toThrow(/Invalid settings/);
		expect(await readFile(join(home, "settings.json"), "utf8")).toBe(before);
	});

	it("reports corrupt JSON without including data and refuses to reset it", async () => {
		await mkdir(home);
		const content = '{"mcpServers":[{"headers":{"Authorization":"fixture-secret"';
		await writeFile(join(home, "settings.json"), content);
		await expect(loadSettings({ cwd, home })).rejects.toThrow(`Invalid JSON in ${join(home, "settings.json")}`);
		await expect(saveSettings(home, { fullscreen: false })).rejects.toThrow(
			`Invalid JSON in ${join(home, "settings.json")}`,
		);
		expect(await readFile(join(home, "settings.json"), "utf8")).toBe(content);
	});

	it("rejects corrupt project settings instead of falling back to global defaults", async () => {
		await writeGlobal({ fullscreen: true });
		await writeFile(join(cwd, ".arc", "settings.json"), "null");
		await expect(loadSettings({ cwd, home })).rejects.toThrow(/Invalid settings/);
	});

	it("merges only the saved change into the latest global file", async () => {
		await writeGlobal({ fullscreen: true, extensionFiles: ["old.ts"] });
		await loadSettings({ cwd, home });
		await writeGlobal({ fullscreen: true, extensionFiles: ["external.ts"], resourcePaths: ["external-resources"] });
		await saveSettings(home, { thinkingLevel: "high" });
		expect(JSON.parse(await readFile(join(home, "settings.json"), "utf8"))).toEqual({
			fullscreen: true,
			extensionFiles: ["external.ts"],
			resourcePaths: ["external-resources"],
			thinkingLevel: "high",
		});
	});

	it("preserves concurrent changes to different global fields", async () => {
		await Promise.all([
			saveSettings(home, { fullscreen: true }),
			saveSettings(home, { thinkingLevel: "max" }),
			saveSettings(home, { extensionFiles: ["fixture.ts"] }),
			saveSettings(home, { toolExecution: "sequential" }),
		]);
		expect(await loadSettings({ cwd, home })).toMatchObject({
			fullscreen: true,
			thinkingLevel: "max",
			extensionFiles: [join(home, "fixture.ts")],
			toolExecution: "sequential",
		});
	});

	it.skipIf(process.platform === "win32")("creates private settings files", async () => {
		await saveSettings(home, { fullscreen: true });
		expect((await stat(home)).mode & 0o777).toBe(0o700);
		expect((await stat(join(home, "settings.json"))).mode & 0o777).toBe(0o600);
	});
});

it("validates runtime compaction and queue settings and retains model-specific overrides", async () => {
	await writeGlobal({
		compaction: { enabled: false, keepRecentTokens: 100, modelOverrides: { "fixture/model": { reserveTokens: 200 } } },
		steeringMode: "all",
		followUpMode: "one-at-a-time",
	});
	expect(await loadSettings({ cwd, home })).toMatchObject({
		compaction: { enabled: false, keepRecentTokens: 100, modelOverrides: { "fixture/model": { reserveTokens: 200 } } },
		steeringMode: "all",
		followUpMode: "one-at-a-time",
	});
	for (const invalid of [
		{ compaction: { keepRecentTokens: -1 } },
		{ compaction: { keepRecentTokens: 1.5 } },
		{ compaction: { modelOverrides: { "fixture/model": { unknown: 1 } } } },
		{ steeringMode: "unknown" },
	]) {
		await writeGlobal(invalid);
		await expect(loadSettings({ cwd, home })).rejects.toThrow("Invalid settings");
	}
});
