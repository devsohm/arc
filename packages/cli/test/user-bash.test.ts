import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, test } from "vitest";
import { createModels, fauxProvider, fauxAssistantMessage, fauxToolCall } from "@arc/ai";
import { createApplication, type ApplicationOptions } from "../src/core/application.ts";
import { userBashEntry } from "../src/core/tools/user-bash.ts";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
async function open(extra: Partial<ApplicationOptions> = {}) {
	const cwd = await mkdtemp(join(tmpdir(), "arc-user-bash-"));
	cleanups.push(() => rm(cwd, { recursive: true, force: true }));
	const models = createModels();
	const provider = fauxProvider();
	models.setProvider(provider.provider);
	const options: ApplicationOptions = {
		cwd,
		home: join(cwd, "home"),
		models,
		backend: "sqlite",
		model: { provider: "faux", modelId: "faux-1" },
		resources: { contextFiles: [], skills: [], prompts: [], extensionFiles: [] },
		...extra,
	};
	const app = await createApplication(options);
	cleanups.push(() => app.close());
	return { app, options, provider, cwd };
}

test("user shell commands persist their results and exclude private output from model context", async () => {
	const { app, options, provider, cwd } = await open();
	await mkdir(join(cwd, "files"));
	const chunks: string[] = [];
	expect(
		await app.executeBash("printf visible; printf error >&2; exit 7", { onChunk: (chunk) => chunks.push(chunk) }),
	).toMatchObject({ output: "visibleerror", exitCode: 7, cancelled: false, truncated: false });
	await app.executeBash("printf hidden", { excludeFromContext: true });
	expect(chunks.join("")).toBe("visibleerror");
	expect(provider.state.callCount).toBe(0);
	const before = await app.snapshot();
	expect(before.view.entries.flatMap((entry) => userBashEntry(entry) ?? [])).toHaveLength(2);
	const messages = (await app.conversation.context(app.context)).messages;
	expect(JSON.stringify(messages)).toContain("visibleerror");
	expect(JSON.stringify(messages)).not.toContain("hidden");
	await app.close();
	const reopened = await createApplication({ ...options, sessionFile: before.sessionFile });
	cleanups.push(() => reopened.close());
	expect((await reopened.snapshot()).view.entries.flatMap((entry) => userBashEntry(entry) ?? [])).toEqual(
		before.view.entries.flatMap((entry) => userBashEntry(entry) ?? []),
	);
});

test("streaming user shell work prevents session switches and abort records its partial output", async () => {
	const { app } = await open();
	const started = Promise.withResolvers<void>();
	const running = app.executeBash("printf ready; sleep 30", { onChunk: () => started.resolve() });
	await started.promise;
	expect((await app.snapshot()).userBash?.[0]?.output).toBe("ready");
	await expect(app.command("/new")).rejects.toThrow("Abort current work");
	await app.abort();
	await expect(running).resolves.toMatchObject({ output: "ready", cancelled: true });
	expect((await app.snapshot()).userBash).toEqual([]);
	await expect(app.executeBash("printf usable")).resolves.toMatchObject({ output: "usable", exitCode: 0 });
});

test("user shell extension interception can replace results and failures never fall back to local execution", async () => {
	const { app, cwd, provider } = await open({
		extensions: [
			{
				name: "shell-intercept",
				onUserBash(_context, event) {
					if (event.command === "remote")
						return { result: { output: "remote result", exitCode: 0, cancelled: false, truncated: false } };
					throw new Error("Execution denied");
				},
			},
		],
	});
	await expect(app.executeBash("remote")).resolves.toMatchObject({ output: "remote result" });
	await expect(app.executeBash("printf forbidden > forbidden.txt")).rejects.toThrow("Execution denied");
	await expect(readFile(join(cwd, "forbidden.txt"))).rejects.toMatchObject({ code: "ENOENT" });
	expect(provider.state.callCount).toBe(0);
});

test("shell output is bounded and spills complete output; closing joins an active process", async () => {
	const { app } = await open();
	const result = await app.executeBash("node -e \"process.stdout.write('x'.repeat(60000))\"");
	expect(result.truncated).toBe(true);
	expect(Buffer.byteLength(result.output)).toBeLessThanOrEqual(50 * 1024);
	if (!result.fullOutputPath) throw new Error("Complete output path missing");
	expect((await readFile(result.fullOutputPath)).length).toBe(60000);
	const started = Promise.withResolvers<void>();
	const running = app.executeBash("printf ready; sleep 30", { onChunk: () => started.resolve() });
	await started.promise;
	await app.close();
	await expect(running).resolves.toMatchObject({ cancelled: true });
});

test("the configured shell prefix applies to user commands and the model bash tool", async () => {
	const { app, provider } = await open({ settings: { shellCommandPrefix: "export ARC_TEST_PREFIX=present" } });
	const command = 'printf "%s" "$ARC_TEST_PREFIX"';
	await expect(app.executeBash(command)).resolves.toMatchObject({ output: "present", exitCode: 0 });
	provider.setResponses([
		fauxAssistantMessage(fauxToolCall("bash", { command }), { stopReason: "toolUse" }),
		fauxAssistantMessage("Prefix checked"),
	]);
	await app.run("Check the configured shell environment");
	const result = (await app.conversation.context(app.context)).messages.findLast(
		(message) => message.role === "toolResult",
	);
	expect(JSON.stringify(result?.content)).toContain("present");
});
