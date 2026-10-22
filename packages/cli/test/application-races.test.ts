import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { createModels, fauxAssistantMessage, fauxProvider } from "@arc/ai";
import { MemoryStorage } from "@arc/durable";
import { afterEach, expect, test, vi } from "vitest";
import { createApplication, type ApplicationOptions } from "../src/core/application.ts";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function fixture(automaticModel = false) {
	const cwd = await mkdtemp(join(tmpdir(), "arc-races-"));
	cleanups.push(() => rm(cwd, { recursive: true, force: true }));
	const provider = fauxProvider();
	const models = createModels({ authContext: { env: async () => undefined, fileExists: async () => false } });
	models.setProvider(provider.provider);
	const options: ApplicationOptions = {
		cwd,
		home: join(cwd, "home"),
		models,
		backend: "memory",
		storage: new MemoryStorage(),
		resources: { contextFiles: [], skills: [], prompts: [], extensionFiles: [] },
		...(automaticModel ? {} : { model: { provider: "faux", modelId: "faux-1" } }),
	};
	const app = await createApplication(options);
	cleanups.push(() => app.close());
	return { cwd, options, app, provider, models };
}

test("a snapshot waits for a session switch instead of pairing the new file with old entries", async () => {
	const f = await fixture();
	f.provider.setResponses([fauxAssistantMessage("Old session answer")]);
	await f.app.run("Old session input");
	const entered = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	const harness = f.app.harness;
	const close = harness.close.bind(harness);
	vi.spyOn(harness, "close").mockImplementation(async (context) => {
		entered.resolve();
		await release.promise;
		await close(context);
	});
	const target = join(f.cwd, "next.jsonl");
	const changing = f.app.command(`/resume ${target}`);
	try {
		await entered.promise;
		let snapshotReturned = false;
		const snapshot = f.app.snapshot().then((state) => {
			snapshotReturned = true;
			return state;
		});
		await sleep(20);
		expect(snapshotReturned).toBe(false);
		release.resolve();
		await changing;
		const state = await snapshot;
		expect(state.sessionFile).toBe(target);
		expect(state.view.entries.flatMap((entry) => entry.model ?? [])).toEqual([]);
	} finally {
		release.resolve();
		await changing.catch(() => {});
	}
});

test("close waits for a pending session open and releases its unused runtime and file lock", async () => {
	const f = await fixture(true);
	const entered = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	const check = f.models.checkAuth.bind(f.models);
	vi.spyOn(f.models, "checkAuth").mockImplementation(async (...args) => {
		entered.resolve();
		await release.promise;
		return check(...args);
	});
	const target = join(f.cwd, "next.jsonl");
	const changing = f.app.command(`/resume ${target}`);
	void changing.catch(() => {});
	try {
		await entered.promise;
		let closed = false;
		const closing = f.app.close().then(() => {
			closed = true;
		});
		await sleep(20);
		expect(closed).toBe(false);
		release.resolve();
		await expect(changing).rejects.toThrow("Application is closed");
		await closing;
		if (!f.options.storage) throw new Error("Expected owned fixture storage");
		await expect(f.options.storage.mintId()).rejects.toThrow("closed");
		const reopened = await createApplication({
			...f.options,
			storage: undefined,
			backend: "jsonl",
			sessionFile: target,
		});
		await reopened.close();
	} finally {
		release.resolve();
		await changing.catch(() => {});
	}
});

test("closing provider contributors in either order restores the original borrowed model collection", async () => {
	const f = await fixture();
	const base = f.models.getProvider("faux");
	const first = fauxProvider().provider;
	const second = fauxProvider().provider;
	for (const order of ["oldest-first", "newest-first"]) {
		const a = await createApplication({
			...f.options,
			storage: new MemoryStorage(),
			extensions: [{ name: "a", providers: [first] }],
		});
		const b = await createApplication({
			...f.options,
			storage: new MemoryStorage(),
			extensions: [{ name: "b", providers: [second] }],
		});
		try {
			expect(f.models.getProvider("faux")).toBe(second);
			if (order === "oldest-first") {
				await a.close();
				expect(f.models.getProvider("faux")).toBe(second);
				await b.close();
			} else {
				await b.close();
				expect(f.models.getProvider("faux")).toBe(first);
				await a.close();
			}
			expect(f.models.getProvider("faux")).toBe(base);
		} finally {
			await a.close();
			await b.close();
		}
	}
});

test("a caller's explicit provider replacement survives contributor removal", async () => {
	const f = await fixture();
	const contribution = fauxProvider().provider;
	const external = fauxProvider().provider;
	const app = await createApplication({
		...f.options,
		storage: new MemoryStorage(),
		extensions: [{ name: "owned", providers: [contribution] }],
	});
	try {
		f.models.setProvider(external);
		await app.close();
		expect(f.models.getProvider("faux")).toBe(external);
	} finally {
		await app.close();
	}
});

test("a pending submit admits its input before a later session switch checks for busy work", async () => {
	const f = await fixture(true);
	const agentEntered = Promise.withResolvers<void>();
	const agentRelease = Promise.withResolvers<void>();
	const responseRelease = Promise.withResolvers<void>();
	const originalConversation = f.app.conversation;
	const agent = f.app.conversation.agent.bind(f.app.conversation);
	let first = true;
	vi.spyOn(f.app.conversation, "agent").mockImplementation(async (...args) => {
		const result = await agent(...args);
		if (first) {
			first = false;
			agentEntered.resolve();
			await agentRelease.promise;
		}
		return result;
	});
	const check = f.models.checkAuth.bind(f.models);
	let nextSessionOpened = false;
	vi.spyOn(f.models, "checkAuth").mockImplementation(async (...args) => {
		nextSessionOpened = true;
		return check(...args);
	});
	f.provider.setResponses([
		async (_transcript, options) => {
			const signal = options?.signal;
			const cancelled = new Promise<void>((resolve) => {
				if (signal?.aborted) resolve();
				else signal?.addEventListener("abort", () => resolve(), { once: true });
			});
			await Promise.race([responseRelease.promise, cancelled]);
			return fauxAssistantMessage("Original session answer", { stopReason: signal?.aborted ? "aborted" : "stop" });
		},
	]);
	const submitting = f.app.submit("Input racing with a session switch");
	void submitting.catch(() => {});
	await agentEntered.promise;
	const changing = f.app.command(`/resume ${join(f.cwd, "next.jsonl")}`);
	void changing.catch(() => {});
	try {
		await sleep(20);
		expect(nextSessionOpened).toBe(false);
		agentRelease.resolve();
		const submission = await submitting;
		if (!submission) throw new Error("Input was unexpectedly handled");
		await expect(changing).rejects.toThrow("Abort current work");
		expect(nextSessionOpened).toBe(false);
		expect(f.app.conversation).toBe(originalConversation);
		responseRelease.resolve();
		expect((await submission.wait(f.app.context)).status).toBe("done");
		expect(JSON.stringify((await f.app.snapshot()).view.entries)).toContain("Input racing with a session switch");
	} finally {
		agentRelease.resolve();
		responseRelease.resolve();
		await changing.catch(() => {});
		await submitting.catch(() => {});
	}
});

test.skipIf(process.platform === "win32")(
	"RPC reserves stdout for records and SIGTERM exits with stdin still open",
	async () => {
		const cwd = await mkdtemp(join(tmpdir(), "arc-rpc-shutdown-"));
		cleanups.push(() => rm(cwd, { recursive: true, force: true }));
		await mkdir(join(cwd, "home"));
		const extension = join(cwd, "diagnostics.mjs");
		await writeFile(
			extension,
			'console.log("CONSOLE_DIAGNOSTIC"); process.stdout.write("DIRECT_DIAGNOSTIC\\n"); export default {name:"diagnostic-fixture"};\n',
		);
		const child = spawn(
			process.execPath,
			[
				fileURLToPath(new URL("../src/cli.ts", import.meta.url)),
				"--mode",
				"rpc",
				"--backend",
				"memory",
				"--cwd",
				cwd,
				"--home",
				join(cwd, "home"),
				"--model",
				"openai/gpt-4",
				"--models",
				" openai/gpt-*:high, openai/o*:low, ",
				"--extension",
				extension,
			],
			{ env: { PATH: process.env.PATH }, stdio: ["pipe", "pipe", "pipe"] },
		);
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (chunk: Buffer) => {
			stdout += chunk.toString();
		});
		child.stderr.on("data", (chunk: Buffer) => {
			stderr += chunk.toString();
		});
		const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
			child.once("error", reject);
			child.once("exit", (code, signal) => resolve({ code, signal }));
		});
		try {
			await vi.waitFor(() => expect(stdout).toContain('"method":"state"'), { timeout: 5_000 });
			child.stdin.write(
				JSON.stringify({ jsonrpc: "2.0", id: "scope-check", method: "command", params: { input: "/scoped-models" } }) +
					"\n",
			);
			await vi.waitFor(() =>
				expect(stdout).toContain(
					JSON.stringify({
						jsonrpc: "2.0",
						id: "scope-check",
						result: { message: "openai/gpt-*:high\nopenai/o*:low" },
					}),
				),
			);
			expect(stderr).toContain("CONSOLE_DIAGNOSTIC");
			expect(stderr).toContain("DIRECT_DIAGNOSTIC");
			for (const line of stdout.trim().split("\n")) expect(() => JSON.parse(line)).not.toThrow();
			child.kill("SIGTERM");
			expect(
				await Promise.race([
					exited,
					sleep(1_000).then(() => {
						throw new Error("RPC ignored SIGTERM while stdin remained open");
					}),
				]),
			).toEqual({ code: 0, signal: null });
		} finally {
			child.kill("SIGKILL");
			await exited.catch(() => {});
		}
	},
);
