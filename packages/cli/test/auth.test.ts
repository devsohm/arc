import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { promisify } from "node:util";
import { createModels, type Credential, type Provider } from "@arc/ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	createApplicationModels,
	FileCredentialStore,
	loginProvider,
	logoutProvider,
} from "../src/core/authentication/auth.ts";

const run = promisify(execFile);
let directory: string;
let home: string;
let authPath: string;

beforeEach(async () => {
	directory = await mkdtemp(join(tmpdir(), "arc-auth-test-"));
	home = join(directory, "home");
	authPath = join(home, "auth.json");
});

afterEach(async () => {
	await rm(directory, { recursive: true, force: true });
});

function provider(auth: Provider["auth"]): Provider {
	return {
		id: "fixture",
		name: "Fixture",
		auth,
		getModels: () => [],
		stream() {
			throw new Error("Unused fixture stream");
		},
		streamSimple() {
			throw new Error("Unused fixture stream");
		},
	};
}

describe("FileCredentialStore", () => {
	it("reads a missing file without creating storage", async () => {
		const store = new FileCredentialStore(authPath);
		expect(await store.read("fixture")).toBeUndefined();
		expect(await store.list()).toEqual([]);
		await expect(stat(home)).rejects.toMatchObject({ code: "ENOENT" });
	});

	it("persists canonical credentials and returns only metadata from list", async () => {
		const first = new FileCredentialStore(authPath);
		const api: Credential = { type: "api_key", key: "fixture-api-key", env: { REGION: "fixture-region" } };
		const oauth: Credential = {
			type: "oauth",
			access: "fixture-access",
			refresh: "fixture-refresh",
			expires: 10_000,
			accountId: "fixture-account",
			metadata: { tenant: "fixture-tenant" },
		};
		await first.modify("api", async () => api);
		await first.modify("oauth", async () => oauth);
		const reopened = new FileCredentialStore(authPath);
		expect(await reopened.read("api")).toEqual(api);
		expect(await reopened.read("oauth")).toEqual(oauth);
		expect(await reopened.list()).toEqual([
			{ providerId: "api", type: "api_key" },
			{ providerId: "oauth", type: "oauth" },
		]);
		await reopened.delete("api");
		expect(await first.read("api")).toBeUndefined();
		expect(await first.read("oauth")).toEqual(oauth);
	});

	it("leaves the credential unchanged for undefined and propagates callback errors", async () => {
		const store = new FileCredentialStore(authPath);
		await store.modify("fixture", async () => ({ type: "api_key", key: "original" }));
		expect(await store.modify("fixture", async () => undefined)).toEqual({ type: "api_key", key: "original" });
		expect(
			await store.modify("fixture", async (current) => {
				if (current?.type === "api_key") current.key = "uncommitted";
				return undefined;
			}),
		).toEqual({ type: "api_key", key: "original" });
		const failure = new Error("Fixture callback failed");
		await expect(
			store.modify("fixture", async () => {
				throw failure;
			}),
		).rejects.toBe(failure);
		await store.modify("another", async () => ({ type: "api_key", key: "next" }));
		expect(await store.read("fixture")).toEqual({ type: "api_key", key: "original" });
		expect(await store.read("another")).toEqual({ type: "api_key", key: "next" });
	});

	it("handles provider ids that match object prototype properties", async () => {
		const store = new FileCredentialStore(authPath);
		expect(await store.read("toString")).toBeUndefined();
		await store.modify("__proto__", async () => ({ type: "api_key", key: "fixture" }));
		expect(await store.read("__proto__")).toEqual({ type: "api_key", key: "fixture" });
		expect(await store.list()).toEqual([{ providerId: "__proto__", type: "api_key" }]);
	});

	it.skipIf(process.platform === "win32")(
		"writes private directories and files, including replacing broad modes",
		async () => {
			await mkdir(home, { mode: 0o755 });
			await writeFile(authPath, "{}", { mode: 0o644 });
			await new FileCredentialStore(authPath).modify("fixture", async () => ({ type: "api_key", key: "fixture" }));
			expect((await stat(home)).mode & 0o777).toBe(0o700);
			expect((await stat(authPath)).mode & 0o777).toBe(0o600);
		},
	);

	it.each([
		'{"fixture":{"type":"api_key","key":"fixture-secret"',
		'"fixture-secret"',
		'["fixture-secret"]',
		'{"fixture":{"type":"api_key","key":"fixture-secret","unexpected":true}}',
		'{"fixture":{"type":"api_key","key":"fixture-secret","env":{"REGION":1}}}',
		'{"fixture":{"type":"oauth","access":"fixture-secret","refresh":"r","expires":"later"}}',
		'{"fixture":{"type":"oauth","access":"fixture-secret","refresh":"r","expires":1e400}}',
		'{"fixture":null,"secret":"fixture-secret"}',
	])("rejects malformed storage without exposing or overwriting its contents", async (content) => {
		await mkdir(home);
		await writeFile(authPath, content);
		const store = new FileCredentialStore(authPath);
		const failure: unknown = await store.read("fixture").then(
			() => undefined,
			(error: unknown) => error,
		);
		expect(failure).toBeInstanceOf(Error);
		if (!(failure instanceof Error)) throw new Error("Expected storage failure");
		expect(failure.message).not.toContain("fixture-secret");
		expect(failure.cause).toBeUndefined();
		await expect(store.modify("another", async () => ({ type: "api_key", key: "new" }))).rejects.toThrow();
		expect(await readFile(authPath, "utf8")).toBe(content);
	});

	it("does not overwrite writes from other store instances", async () => {
		const first = new FileCredentialStore(authPath);
		const second = new FileCredentialStore(authPath);
		await Promise.all(
			Array.from({ length: 12 }, (_, index) =>
				(index % 2 ? first : second).modify(`provider-${index}`, async () => {
					await sleep(2);
					return { type: "api_key", key: String(index) };
				}),
			),
		);
		expect((await first.list()).length).toBe(12);
		for (let index = 0; index < 12; index++)
			expect(await first.read(`provider-${index}`)).toEqual({ type: "api_key", key: String(index) });
	});

	it("recovers a stale lock left by an interrupted writer", async () => {
		await mkdir(home);
		await mkdir(`${authPath}.lock`);
		const stale = new Date(Date.now() - 60_000);
		await utimes(`${authPath}.lock`, stale, stale);
		const store = new FileCredentialStore(authPath);
		await store.modify("fixture", async () => ({ type: "api_key", key: "after-recovery" }));
		expect(await store.read("fixture")).toEqual({ type: "api_key", key: "after-recovery" });
		await expect(stat(`${authPath}.lock`)).rejects.toMatchObject({ code: "ENOENT" });
	});

	it("serializes rotated-token refreshes through the real Models.getAuth path", async () => {
		const first = new FileCredentialStore(authPath);
		await first.modify("fixture", async () => ({ type: "oauth", access: "old", refresh: "old", expires: 0 }));
		let refreshes = 0;
		const auth = {
			oauth: {
				name: "Fixture OAuth",
				login: async () => ({ type: "oauth", access: "unused", refresh: "unused", expires: 0 }),
				async refresh(credential) {
					refreshes++;
					expect(credential.refresh).toBe("old");
					await sleep(20);
					return {
						type: "oauth",
						access: "rotated-access",
						refresh: "rotated-refresh",
						expires: Date.now() + 3_600_000,
					};
				},
				toAuth: async (credential) => ({ apiKey: credential.access }),
			},
		} satisfies Provider["auth"];
		const collections = [first, new FileCredentialStore(authPath)].map((credentials) => {
			const models = createModels({
				credentials,
				authContext: { env: async () => undefined, fileExists: async () => false },
			});
			models.setProvider(provider(auth));
			return models;
		});
		const results = await Promise.all(collections.map((models) => models.getAuth("fixture")));
		expect(results.map((result) => result?.auth.apiKey)).toEqual(["rotated-access", "rotated-access"]);
		expect(refreshes).toBe(1);
		expect(await first.read("fixture")).toMatchObject({ access: "rotated-access", refresh: "rotated-refresh" });
	});

	it("returns promptly on abort while holding the active lock until the callback settles", async () => {
		const store = new FileCredentialStore(authPath);
		const entered = Promise.withResolvers<void>();
		const finish = Promise.withResolvers<void>();
		const controller = new AbortController();
		const active = store.modify(
			"fixture",
			async () => {
				entered.resolve();
				await finish.promise;
				return { type: "api_key", key: "aborted-value" };
			},
			{ signal: controller.signal },
		);
		await entered.promise;
		controller.abort();
		await expect(active).rejects.toMatchObject({ name: "AbortError" });
		let nextEntered = false;
		const next = new FileCredentialStore(authPath).modify("fixture", async (current) => {
			nextEntered = true;
			expect(current).toBeUndefined();
			return { type: "api_key", key: "accepted-value" };
		});
		await sleep(20);
		expect(nextEntered).toBe(false);
		finish.resolve();
		await next;
		expect(await store.read("fixture")).toEqual({ type: "api_key", key: "accepted-value" });
	});

	it("preserves same-provider refresh state and unrelated writes across Node processes", async () => {
		const source = new URL("../src/core/authentication/auth.ts", import.meta.url).href;
		const script = `
import { FileCredentialStore } from ${JSON.stringify(source)};
import { setTimeout as sleep } from "node:timers/promises";
const store = new FileCredentialStore(process.argv[1]);
for (let iteration = 0; iteration < 6; iteration++) {
  await store.modify("shared", async (current) => {
    const value = current?.type === "api_key" ? Number(current.key) : 0;
    await sleep(3);
    return { type: "api_key", key: String(value + 1) };
  });
}
await store.modify(process.argv[2], async () => ({ type: "api_key", key: "complete" }));
`;
		await Promise.all(
			["child-a", "child-b", "child-c"].map((id) =>
				run(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", script, authPath, id]),
			),
		);
		const store = new FileCredentialStore(authPath);
		expect(await store.read("shared")).toEqual({ type: "api_key", key: "18" });
		for (const id of ["child-a", "child-b", "child-c"])
			expect(await store.read(id)).toEqual({ type: "api_key", key: "complete" });
	}, 20_000);
});

describe("application provider auth", () => {
	it("constructs the application catalog without credential reads or network calls", async () => {
		const models = createApplicationModels({ home });
		expect(models.getProvider("anthropic")?.id).toBe("anthropic");
		expect(models.getProvider("openai-codex")?.id).toBe("openai-codex");
		expect(models.getProvider("mistral")).toBeUndefined();
		expect(models.getProvider("radius")).toBeUndefined();
		await expect(stat(home)).rejects.toMatchObject({ code: "ENOENT" });
	});

	it("delegates API-key login to Models and persists logout", async () => {
		const store = new FileCredentialStore(authPath);
		const models = createModels({ credentials: store });
		models.setProvider(
			provider({
				apiKey: {
					name: "Fixture API key",
					login: async (interaction) => ({
						type: "api_key",
						key: await interaction.prompt({ type: "secret", message: "Fixture API key" }),
					}),
					resolve: async ({ credential }) => ({ auth: { apiKey: credential?.key } }),
				},
			}),
		);
		await loginProvider(models, "fixture", { prompt: async () => "entered-fixture-key", notify() {} });
		expect(await new FileCredentialStore(authPath).read("fixture")).toEqual({
			type: "api_key",
			key: "entered-fixture-key",
		});
		await logoutProvider(models, "fixture");
		expect(await store.list()).toEqual([]);
	});

	it("offers existing login methods and forwards the selected OAuth interaction", async () => {
		const store = new FileCredentialStore(authPath);
		const models = createModels({ credentials: store });
		models.setProvider(
			provider({
				apiKey: {
					name: "Fixture key",
					login: async () => ({ type: "api_key", key: "unused" }),
					resolve: async () => undefined,
				},
				oauth: {
					name: "Fixture OAuth",
					async login(interaction, options) {
						expect(options?.agentName).toBe("arc");
						interaction.notify({ type: "progress", message: "Fixture progress" });
						return {
							type: "oauth",
							access: await interaction.prompt({ type: "manual_code", message: "Code" }),
							refresh: "r",
							expires: 100,
						};
					},
					refresh: async (credential) => credential,
					toAuth: async (credential) => ({ apiKey: credential.access }),
				},
			}),
		);
		const events: string[] = [];
		await loginProvider(models, "fixture", {
			async prompt(prompt) {
				if (prompt.type === "select") {
					expect(prompt.options.map((option) => option.id)).toEqual(["api_key", "oauth"]);
					return "oauth";
				}
				return "fixture-code";
			},
			notify: (event) => events.push(event.type),
		});
		expect(events).toEqual(["progress"]);
		expect(await store.read("fixture")).toEqual({ type: "oauth", access: "fixture-code", refresh: "r", expires: 100 });
	});
});
