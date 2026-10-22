import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, appendFile, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createModels, fauxProvider, fauxAssistantMessage } from "@arc/ai";
import { defineTool } from "@arc/durable";
import { Type } from "typebox";
import { expect, test, vi } from "vitest";
import { createApplication } from "../src/core/application.ts";

for (const [signal, replay, startup, generation] of [
	["SIGKILL", "safe", false, false],
	["SIGKILL", "unsafe", false, false],
	["SIGHUP", "safe", true, false],
	["SIGKILL", "safe", true, true],
] as const)
	test.skipIf(process.platform === "win32")(
		`restores interrupted ${generation ? "generation" : replay + " tool"} work after ${signal} through ${startup ? "startup" : "/resume"}`,
		async () => {
			const directory = await mkdtemp(join(tmpdir(), "arc-recovery-"));
			const child = spawn(
				process.execPath,
				[
					"--conditions=source",
					fileURLToPath(new URL("./fixtures/interrupted-session.mjs", import.meta.url)),
					directory,
					replay,
					generation ? "generation" : "tool",
				],
				{ stdio: ["ignore", "pipe", "pipe"] },
			);
			const exited = once(child, "exit");
			let output = "",
				errors = "";
			child.stdout.on("data", (data) => {
				output += data;
			});
			child.stderr.on("data", (data) => {
				errors += data;
			});
			let app: Awaited<ReturnType<typeof createApplication>> | undefined;
			try {
				await vi.waitFor(
					() => {
						if (child.exitCode !== null || child.signalCode !== null) throw new Error(errors);
						expect(output).toContain("WRITE_STARTED");
					},
					{ timeout: 10000 },
				);
				child.kill(signal);
				await exited;
				const models = createModels(),
					provider = fauxProvider();
				models.setProvider(provider.provider);
				provider.setResponses([fauxAssistantMessage("Recovered turn completed")]);
				app = await createApplication({
					cwd: directory,
					home: join(directory, "reopened-home"),
					models,
					backend: startup ? "sqlite" : "memory",
					sessionFile: startup ? join(directory, "interrupted.sqlite") : undefined,
					model: { provider: "faux", modelId: "faux-1" },
					settings: { codemode: false },
					resources: { contextFiles: [], skills: [], prompts: [], extensionFiles: [] },
					extensions: [
						{
							name: "checkpoint",
							tools: [
								defineTool({
									name: "checkpoint_write",
									description: "A controlled file write",
									parameters: Type.Object({}),
									replay,
									async execute() {
										await appendFile(join(directory, "attempts.txt"), "attempt\n");
										await writeFile(join(directory, "finished.txt"), "recovered data");
										return { output: [{ type: "text", text: "written" }] };
									},
								}),
							],
						},
					],
				});
				if (!startup) await app.command(`/resume ${join(directory, "interrupted.sqlite")}`);
				const restored = app;
				await vi.waitFor(
					async () => {
						const state = await restored.snapshot();
						expect(state.view.entries.flatMap((entry) => entry.model ?? [])).toContainEqual(
							expect.objectContaining({
								role: "assistant",
								content: expect.arrayContaining([expect.objectContaining({ text: "Recovered turn completed" })]),
							}),
						);
					},
					{ timeout: 5000 },
				);
				if (generation) expect(provider.state.callCount).toBe(1);
				else {
					expect(await readFile(join(directory, "attempts.txt"), "utf8")).toBe(
						replay === "safe" ? "attempt\nattempt\n" : "attempt\n",
					);
					if (replay === "safe") expect(await readFile(join(directory, "finished.txt"), "utf8")).toBe("recovered data");
					else
						expect((await app.snapshot()).view.entries.flatMap((entry) => entry.model ?? [])).toContainEqual(
							expect.objectContaining({
								role: "toolResult",
								isError: true,
								content: expect.arrayContaining([
									expect.objectContaining({ text: expect.stringContaining("interrupted") }),
								]),
							}),
						);
				}
			} finally {
				if (child.exitCode === null && child.signalCode === null) {
					child.kill("SIGKILL");
					await exited;
				}
				await app?.close();
				await rm(directory, { recursive: true, force: true });
			}
		},
		20000,
	);
