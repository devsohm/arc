import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createModels, fauxProvider, fauxAssistantMessage, type Provider } from "@arc/ai";
import { expect, test, vi } from "vitest";
import { createApplication, FileCredentialStore } from "../src/sdk.ts";
import { runInteractive } from "../src/modes/interactive/interactive-mode.ts";
import { TestTerminal } from "../../tui/test/support/terminal.ts";

test("terminal login publishes models, waits for model selection, filters searches, runs it and removes the stored login", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "arc-login-models-"));
	const home = join(cwd, "home");
	const credentials = new FileCredentialStore(join(home, "auth.json"));
	const models = createModels({
		credentials,
		authContext: { env: async () => undefined, fileExists: async () => false },
	});
	const faux = fauxProvider({ models: [{ id: "alpha" }, { id: "beta" }] });
	let catalog: ReturnType<Provider["getModels"]> = [];
	models.setProvider({
		...faux.provider,
		name: "Fixture provider",
		getModels: () => catalog,
		auth: {
			apiKey: {
				name: "API key",
				login: async (interaction) => ({
					type: "api_key",
					key: await interaction.prompt({ type: "secret", message: "Fixture key" }),
				}),
				resolve: async ({ credential }) => (credential?.key ? { auth: { apiKey: credential.key } } : undefined),
			},
		},
		async refreshModels(context) {
			if (context.allowNetwork && context.credential)
				await context.publish({
					update: () => {
						catalog = faux.provider.getModels();
					},
				});
		},
	});
	const hidden = fauxProvider({ provider: "hidden", models: [{ id: "hidden-model" }] });
	models.setProvider({ ...hidden.provider, auth: { apiKey: { name: "Hidden key", resolve: async () => undefined } } });
	const app = await createApplication({
		cwd,
		home,
		models,
		backend: "memory",
		resources: { contextFiles: [], skills: [], prompts: [], extensionFiles: [] },
	});
	const terminal = new TestTerminal(120, 38);
	const writes = vi.spyOn(terminal, "write");
	const controller = new AbortController();
	const running = runInteractive(app, { terminal, fullscreen: true, signal: controller.signal });
	const send = (value: string) => {
		if (value) terminal.input(value);
		terminal.input("\r");
	};
	const text = async () => (await terminal.screen()).join("\n");
	try {
		await vi.waitFor(async () => expect(await text()).toContain("Enter send"));
		expect((await app.snapshot()).agent.model).toBeUndefined();
		send("/model");
		await vi.waitFor(async () => expect(await text()).toContain("Use /login"));
		send("/login faux");
		await vi.waitFor(async () => expect(await text()).toContain("Fixture key"));
		terminal.input("\x1b");
		await vi.waitFor(async () => expect(await text()).toContain("Enter send"));
		expect(await text()).not.toContain("Login cancelled");
		expect(await credentials.list()).toEqual([]);
		expect((await app.snapshot()).agent.model).toBeUndefined();
		send("/login");
		await vi.waitFor(async () => expect(await text()).toContain("Sign in"));
		send("");
		await vi.waitFor(async () => expect(await text()).toContain("Fixture key"));
		send("fixture-secret-not-visible");
		await vi.waitFor(async () => expect(await text()).toContain("Select model"));
		expect((await app.snapshot()).agent.model).toBeUndefined();
		terminal.input("\x1b");
		await vi.waitFor(async () => expect(await text()).toContain("Signed in to faux"));
		expect((await app.snapshot()).agent.model).toBeUndefined();
		send("/login faux");
		await vi.waitFor(async () => expect(await text()).toContain("Fixture key"));
		send("fixture-secret-not-visible");
		await vi.waitFor(async () => expect(await text()).toContain("Select model"));
		expect((await app.snapshot()).agent.model).toBeUndefined();
		send("beta");
		await vi.waitFor(async () => expect(await text()).toContain("Signed in to faux"));
		await vi.waitFor(async () =>
			expect((await app.snapshot()).agent.model).toEqual({ provider: "faux", modelId: "beta" }),
		);
		expect(JSON.parse(await readFile(join(home, "settings.json"), "utf8")).model).toEqual({
			provider: "faux",
			modelId: "beta",
		});
		expect((await models.getAvailable()).map((model) => model.id)).toEqual(["alpha", "beta"]);
		send("/model beta");
		await vi.waitFor(async () => expect(await text()).toContain("Select model"));
		expect(await text()).toContain("faux/beta");
		expect(await text()).not.toContain("hidden-model");
		send("");
		await vi.waitFor(async () => expect((await app.snapshot()).agent.model?.modelId).toBe("beta"));
		faux.setResponses([fauxAssistantMessage("Authenticated model answer")]);
		send("answer");
		await vi.waitFor(async () => expect(await text()).toContain("Authenticated model answer"));
		send("/logout");
		await vi.waitFor(async () => expect(await text()).toContain("Sign out"));
		send("");
		await vi.waitFor(async () => expect(await text()).toContain("Logged out of faux"));
		expect(await credentials.list()).toEqual([]);
		expect(await models.getAvailable()).toEqual([]);
		send("/model");
		await vi.waitFor(async () => expect(await text()).toContain("Use /login"));
		expect(writes.mock.calls.flat().join("")).not.toContain("fixture-secret-not-visible");
	} finally {
		controller.abort();
		await running;
		await app.close();
		terminal.dispose();
		writes.mockRestore();
		await rm(cwd, { recursive: true, force: true });
	}
});
