import { mkdtemp, rm, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels } from "@arc/ai";
import { expect, test, vi } from "vitest";
import { createApplication } from "../src/core/application.ts";
import { runInteractive } from "../src/modes/interactive/interactive-mode.ts";
import { TestTerminal } from "../../tui/test/support/terminal.ts";

for (const fullscreen of [false, true])
	test(`resume actions reach the real interactive UI (fullscreen=${fullscreen})`, async () => {
		const directory = await mkdtemp(join(tmpdir(), "arc-resume-ui-"));
		const app = await createApplication({
			cwd: directory,
			home: join(directory, "home"),
			models: createModels(),
			backend: "sqlite",
			resources: { contextFiles: [], skills: [], prompts: [], extensionFiles: [] },
		});
		const terminal = new TestTerminal(120, 40),
			controller = new AbortController();
		let running: Promise<void> | undefined;
		try {
			await app.command("/name Previous task");
			const previous = (await app.snapshot()).sessionFile!;
			await app.command("/new");
			await app.command("/name Current task");
			running = runInteractive(app, { terminal, fullscreen, signal: controller.signal });
			const screen = async () => (await terminal.screen()).join("\n");
			await vi.waitFor(async () => expect(await screen()).toContain("/ commands"));
			terminal.input("/resume");
			terminal.input("\r");
			await vi.waitFor(async () => expect(await screen()).toContain("Previous task"));
			terminal.input("Previous");
			terminal.input("\x12");
			await vi.waitFor(async () => expect(await screen()).toContain("Session name"));
			terminal.input("\x01");
			terminal.input("\x0b");
			terminal.input("Renamed task");
			terminal.input("\r");
			// Renaming can hide the selected row because its old search no longer matches.
			await vi.waitFor(async () => expect(await screen()).toContain("No sessions found"));
			terminal.input("\x01");
			terminal.input("\x0b");
			terminal.input("Renamed");
			await vi.waitFor(async () => expect(await screen()).toContain("Renamed task"));
			terminal.input("\x04");
			await vi.waitFor(async () => expect(await screen()).toContain("Permanently delete"));
			terminal.input("\x1b");
			await vi.waitFor(async () => expect(await screen()).not.toContain("Permanently delete"));
			await access(previous);
			terminal.input("\x04");
			await vi.waitFor(async () => expect(await screen()).toContain("Permanently delete"));
			terminal.input("\r");
			await vi.waitFor(async () => expect(await screen()).toContain("No sessions found"));
			await expect(access(previous)).rejects.toThrow();
			terminal.input("\x1b");
			await vi.waitFor(async () => expect(await screen()).not.toContain("Resume session"));
			expect((await app.snapshot()).sessionName).toBe("Current task");
		} finally {
			controller.abort();
			await running;
			await app.close();
			terminal.dispose();
			await rm(directory, { recursive: true, force: true });
		}
	}, 15000);
