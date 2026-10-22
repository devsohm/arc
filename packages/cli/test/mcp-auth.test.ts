import { createServer } from "node:http";
import { once } from "node:events";
import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import { createModels, fauxProvider } from "@arc/ai";
import { LATEST_PROTOCOL_VERSION } from "@arc/mcp";
import { createApplication } from "../src/sdk.ts";
import { runInteractive } from "../src/modes/interactive/interactive-mode.ts";
import { TestTerminal } from "../../tui/test/support/terminal.ts";
import * as browser from "../src/core/authentication/browser.ts";

async function fixture() {
	const home = await mkdtemp(join(tmpdir(), "arc-mcp-login-"));
	let origin = "",
		challenge = "",
		access = "access-one";
	const grants: string[] = [];
	const server = createServer(async (req, res) => {
		const url = new URL(req.url ?? "/", origin);
		const chunks: Buffer[] = [];
		for await (const chunk of req) chunks.push(Buffer.from(chunk));
		const text = Buffer.concat(chunks).toString();
		const json = (value: unknown, status = 200) => {
			res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(value));
		};
		if (url.pathname.startsWith("/.well-known/oauth-protected-resource"))
			return json({
				resource: origin + "/mcp",
				authorization_servers: [origin],
				scopes_supported: ["read", "offline_access"],
			});
		if (url.pathname === "/.well-known/oauth-authorization-server")
			return json({
				issuer: origin,
				authorization_endpoint: origin + "/authorize",
				token_endpoint: origin + "/token",
				registration_endpoint: origin + "/register",
				response_types_supported: ["code"],
				grant_types_supported: ["authorization_code", "refresh_token"],
				token_endpoint_auth_methods_supported: ["none"],
				code_challenge_methods_supported: ["S256"],
				authorization_response_iss_parameter_supported: true,
			});
		if (url.pathname === "/register") return json({ ...JSON.parse(text), client_id: "registered-client" });
		if (url.pathname === "/token") {
			const body = new URLSearchParams(text),
				grant = body.get("grant_type") ?? "";
			grants.push(grant);
			if (grant === "authorization_code") {
				if (
					body.get("code") !== "approved" ||
					createHash("sha256")
						.update(body.get("code_verifier") ?? "")
						.digest("base64url") !== challenge
				)
					return json({ error: "invalid_grant" }, 400);
			} else if (body.get("refresh_token") !== "refresh-one") return json({ error: "invalid_grant" }, 400);
			return json({ access_token: access, refresh_token: "refresh-one", token_type: "Bearer" });
		}
		if (url.pathname !== "/mcp") {
			res.writeHead(404).end();
			return;
		}
		if (req.headers.authorization !== `Bearer ${access}`) {
			res
				.writeHead(401, {
					"www-authenticate": `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp"`,
				})
				.end();
			return;
		}
		if (req.method === "DELETE") {
			res.writeHead(204).end();
			return;
		}
		if (req.method !== "POST") {
			res.writeHead(405).end();
			return;
		}
		const body: unknown = JSON.parse(text);
		if (!body || typeof body !== "object" || !("id" in body)) {
			res.writeHead(202).end();
			return;
		}
		const method = "method" in body ? body.method : undefined;
		const result =
			method === "initialize"
				? {
						protocolVersion: LATEST_PROTOCOL_VERSION,
						capabilities: { tools: {} },
						serverInfo: { name: "fixture", version: "1" },
					}
				: method === "tools/list"
					? { tools: [{ name: "echo", inputSchema: { type: "object" } }] }
					: { content: [{ type: "text", text: "authenticated" }] };
		json({ jsonrpc: "2.0", id: body.id, result });
	});
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("Missing address");
	origin = `http://127.0.0.1:${address.port}`;
	const models = createModels();
	models.setProvider(fauxProvider().provider);
	const options = {
		home,
		cwd: home,
		models,
		backend: "memory" as const,
		model: { provider: "faux", modelId: "faux-1" },
		resources: { contextFiles: [], skills: [], prompts: [], extensionFiles: [] },
		settings: { codemode: false, mcpServers: [{ name: "fixture", transport: "http" as const, url: origin + "/mcp" }] },
	};
	return {
		home,
		origin,
		options,
		grants,
		setChallenge: (value: string) => {
			challenge = value;
		},
		expire: () => {
			access = "access-two";
		},
		close: async () => {
			server.closeAllConnections();
			await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
			await rm(home, { recursive: true, force: true });
		},
	};
}

test("MCP terminal login negotiates PKCE, persists and refreshes tokens, reopens and logs out", async () => {
	const f = await fixture();
	const app = await createApplication(f.options);
	const terminal = new TestTerminal(120, 35);
	const writes = vi.spyOn(terminal, "write");
	const stop = new AbortController();
	const running = runInteractive(app, { terminal, signal: stop.signal });
	const send = (text: string) => {
		terminal.input(text);
		terminal.input("\r");
	};
	const screen = async () => (await terminal.screen()).join("\n");
	const opened = vi.spyOn(browser, "openBrowser").mockImplementation(async (value) => {
		await vi.waitFor(() => expect(writes.mock.calls.flat().join("")).toContain("\x1b]8;;" + value + "\x1b\\"));
		const url = new URL(value);
		f.setChallenge(url.searchParams.get("code_challenge") ?? "");
		const redirect = new URL(url.searchParams.get("redirect_uri") ?? "");
		redirect.searchParams.set("state", url.searchParams.get("state") ?? "");
		redirect.searchParams.set("code", "approved");
		redirect.searchParams.set("iss", f.origin);
		expect((await fetch(redirect)).status).toBe(200);
		return true;
	});
	let reopened: Awaited<ReturnType<typeof createApplication>> | undefined;
	try {
		await vi.waitFor(async () => expect(await screen()).toContain("Enter send"));
		send("/mcp");
		await vi.waitFor(async () => expect(await screen()).toContain("MCP servers"));
		send("fixture");
		await vi.waitFor(async () => expect(await screen()).toContain("Log in with OAuth"));
		send("Log in with OAuth");
		await vi.waitFor(async () => expect(await screen()).toContain("fixture · connected · 1 tools"));
		expect(opened).toHaveBeenCalledTimes(1);
		expect((await app.snapshot()).agent.tools.map((t) => t.name)).toContain("mcp_fixture_echo");
		const files = await readdir(join(f.home, "mcp-auth"));
		expect(files).toHaveLength(1);
		const path = join(f.home, "mcp-auth", files[0]);
		expect(JSON.parse(await readFile(path, "utf8")).state.tokens.access_token).toBe("access-one");
		if (process.platform !== "win32") expect((await stat(path)).mode & 0o777).toBe(0o600);
		stop.abort();
		await running;
		await app.close();
		f.expire();
		reopened = await createApplication(f.options);
		expect((await reopened.snapshot()).agent.tools.map((t) => t.name)).toContain("mcp_fixture_echo");
		expect(f.grants).toEqual(["authorization_code", "refresh_token"]);
		expect(opened).toHaveBeenCalledTimes(1);
		await reopened.command("/mcp logout fixture");
		expect((await reopened.snapshot()).agent.tools.map((t) => t.name)).not.toContain("mcp_fixture_echo");
		expect(await readdir(join(f.home, "mcp-auth"))).toEqual([]);
		expect((await reopened.command("/mcp")).message).toContain("No MCP servers connected");
	} finally {
		stop.abort();
		await running;
		await app.close();
		await reopened?.close();
		terminal.dispose();
		opened.mockRestore();
		writes.mockRestore();
		await f.close();
	}
});

test("cancelling MCP browser login dismisses the panel and closes its callback listener", async () => {
	const f = await fixture();
	const app = await createApplication(f.options);
	const terminal = new TestTerminal(120, 35);
	const stop = new AbortController();
	let callback: string | undefined;
	const opened = vi.spyOn(browser, "openBrowser").mockImplementation(async (value) => {
		callback = new URL(value).searchParams.get("redirect_uri") ?? undefined;
		return true;
	});
	const running = runInteractive(app, { terminal, signal: stop.signal });
	const screen = async () => (await terminal.screen()).join("\n");
	try {
		await vi.waitFor(async () => expect(await screen()).toContain("Enter send"));
		terminal.input("/mcp login fixture");
		terminal.input("\r");
		await vi.waitFor(async () => expect(await screen()).toContain("Authorize MCP fixture in your browser"));
		terminal.input("\x1b");
		await vi.waitFor(async () => expect(await screen()).toContain("Enter send"));
		if (!callback) throw new Error("Callback missing");
		await expect(fetch(callback)).rejects.toThrow();
		expect((await app.snapshot()).agent.tools.map((t) => t.name)).not.toContain("mcp_fixture_echo");
	} finally {
		stop.abort();
		await running;
		await app.close();
		terminal.dispose();
		opened.mockRestore();
		await f.close();
	}
});
