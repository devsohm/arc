import { linkifyUrls } from "../ui/text.ts";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { rm } from "node:fs/promises";
import { Type } from "typebox";
import { Value } from "typebox/value";
import type { AuthProvider } from "@arc/mcp";
import { Text } from "@arc/tui";
import {
	McpOAuthAuthorizationRequiredError,
	adaptOAuthProvider,
	authorizeMcp,
	McpOAuthProvider,
	OAuthCallbackServer,
	type McpOAuthState,
	type McpOAuthStateStore,
} from "@arc/mcp/oauth";
import type { McpServerSetting } from "../configuration/settings.ts";
import { readJsonFile, withFileUpdate } from "../configuration/file-storage.ts";
import type { ApplicationUI } from "../ui/ui.ts";
import { openBrowser } from "./browser.ts";

type HttpServer = Extract<McpServerSetting, { transport: "http" }>;
const string = Type.String();
const strings = Type.Array(string);
const metadata = Type.Object(
	{
		issuer: string,
		authorization_endpoint: string,
		token_endpoint: string,
		response_types_supported: strings,
		registration_endpoint: Type.Optional(string),
		scopes_supported: Type.Optional(strings),
		grant_types_supported: Type.Optional(strings),
		token_endpoint_auth_methods_supported: Type.Optional(strings),
		code_challenge_methods_supported: Type.Optional(strings),
		client_id_metadata_document_supported: Type.Optional(Type.Boolean()),
		authorization_response_iss_parameter_supported: Type.Optional(Type.Boolean()),
	},
	{ additionalProperties: true },
);
const stateSchema = Type.Object({
	serverUrl: string,
	clientInformation: Type.Optional(
		Type.Object({ client_id: string, client_secret: Type.Optional(string) }, { additionalProperties: true }),
	),
	tokens: Type.Optional(
		Type.Object({
			access_token: string,
			token_type: string,
			expires_in: Type.Optional(Type.Number()),
			scope: Type.Optional(string),
			refresh_token: Type.Optional(string),
			id_token: Type.Optional(string),
		}),
	),
	tokensExpireAt: Type.Optional(Type.Number()),
	codeVerifier: Type.Optional(string),
	oauthState: Type.Optional(string),
	discovery: Type.Optional(
		Type.Object({
			authorizationServerUrl: string,
			authorizationServerMetadata: Type.Optional(metadata),
			resourceMetadata: Type.Optional(
				Type.Object(
					{ resource: string, authorization_servers: Type.Optional(strings), scopes_supported: Type.Optional(strings) },
					{ additionalProperties: true },
				),
			),
			resourceMetadataUrl: Type.Optional(string),
		}),
	),
});
const storedSchema = Type.Object({ redirectUrl: string, state: stateSchema });
function credentialPath(home: string, server: HttpServer): string {
	return join(home, "mcp-auth", createHash("sha256").update(new URL(server.url).href).digest("hex") + ".json");
}
async function stored(home: string, server: HttpServer) {
	const value = await readJsonFile(credentialPath(home, server));
	if (value === undefined) return undefined;
	if (!Value.Check(storedSchema, value) || value.state.serverUrl !== new URL(server.url).href)
		throw new Error(`Invalid stored MCP authentication for ${server.name}`);
	const redirect = new URL(value.redirectUrl);
	if (redirect.protocol !== "http:" || redirect.hostname !== "127.0.0.1" || redirect.pathname !== "/callback")
		throw new Error(`Invalid MCP callback address for ${server.name}`);
	return value;
}
function provider(
	home: string,
	server: HttpServer,
	redirectUrl: string,
	onRedirect: (url: URL) => Promise<void>,
	signal?: AbortSignal,
) {
	const store: McpOAuthStateStore = {
		load: async () => (await stored(home, server))?.state,
		save: async (state: McpOAuthState) =>
			withFileUpdate(
				credentialPath(home, server),
				async () => ({ result: undefined, data: { redirectUrl, state } }),
				signal,
			),
	};
	return new McpOAuthProvider({
		serverUrl: server.url,
		redirectUrl,
		store,
		clientMetadata: { client_name: "Arc", ...(server.oauth?.scope ? { scope: server.oauth.scope } : {}) },
		clientId: server.oauth?.clientId,
		clientSecret: server.oauth?.clientSecret,
		onRedirect,
	});
}
export async function mcpAuthProvider(
	home: string,
	server: McpServerSetting,
	signal?: AbortSignal,
): Promise<AuthProvider | undefined> {
	if (server.transport !== "http") return undefined;
	const saved = await stored(home, server);
	if (!saved?.state.tokens) return undefined;
	const adapted = adaptOAuthProvider(
		provider(
			home,
			server,
			saved.redirectUrl,
			async () => {
				throw new McpOAuthAuthorizationRequiredError();
			},
			signal,
		),
	);
	return {
		token: async () => {
			signal?.throwIfAborted();
			return adapted.token();
		},
		onUnauthorized: async (context) => {
			signal?.throwIfAborted();
			await adapted.onUnauthorized?.({
				...context,
				fetch: (input, init) =>
					context.fetch(input, {
						...init,
						signal: signal ? (init?.signal ? AbortSignal.any([signal, init.signal]) : signal) : init?.signal,
					}),
			});
		},
	};
}
export async function logoutMcp(home: string, server: McpServerSetting): Promise<void> {
	if (server.transport !== "http")
		throw new Error("MCP OAuth applies to HTTP servers; stdio servers manage their own credentials.");
	await rm(credentialPath(home, server), { force: true });
}
export async function loginMcp(
	home: string,
	server: McpServerSetting,
	ui: ApplicationUI,
	signal: AbortSignal,
): Promise<void> {
	if (server.transport !== "http")
		throw new Error("MCP OAuth applies to HTTP servers; stdio servers manage their own credentials.");
	if (!ui.capabilities.custom) throw new Error("MCP browser login requires the interactive terminal.");
	const saved = await stored(home, server);
	const callback = await OAuthCallbackServer.listen({
		port: server.oauth?.redirectPort ?? (saved ? Number(new URL(saved.redirectUrl).port) : 0),
	});
	const controller = new AbortController();
	const cancel = () => controller.abort(signal.reason);
	signal.addEventListener("abort", cancel, { once: true });
	if (signal.aborted) cancel();
	let finish = () => {};
	const panel = new Text(`Signing in to MCP ${server.name}\nEscape cancels`, 1, 0);
	const waiting = ui.custom<void>((_tui, _theme, _keys, done) => {
		finish = done;
		return panel;
	});
	void waiting.catch((error) => controller.abort(error));
	let closing: Promise<void> | undefined;
	const closeCallback = () => {
		closing ??= callback.close();
		void closing.catch(() => {});
	};
	controller.signal.addEventListener("abort", closeCallback, { once: true });
	let response: ReturnType<OAuthCallbackServer["waitForCallback"]> | undefined;
	try {
		controller.signal.throwIfAborted();
		const auth = provider(
			home,
			server,
			callback.redirectUrl,
			async (url) => {
				const state = url.searchParams.get("state");
				if (!state) throw new Error("MCP authorization state is missing");
				response = callback.waitForCallback(state);
				void response.catch(() => {});
				panel.setText(linkifyUrls(`Authorize MCP ${server.name} in your browser\n${url.href}\nEscape cancels`));
				ui.notify(`Authorize MCP ${server.name}: ${url.href}`);
				if (!(await openBrowser(url.href)))
					ui.notify("Could not open the browser. Copy the complete URL into your browser.", "warning");
			},
			controller.signal,
		);
		if (saved && saved.redirectUrl !== callback.redirectUrl) await auth.invalidateCredentials("all");
		const result = await authorizeMcp(auth, {
			serverUrl: server.url,
			scope: server.oauth?.scope,
			signal: controller.signal,
		});
		if (result === "REDIRECT") {
			if (!response) throw new Error("MCP authorization did not provide a callback");
			const reply = await response;
			await authorizeMcp(auth, {
				serverUrl: server.url,
				authorizationCode: reply.code,
				iss: reply.iss,
				signal: controller.signal,
			});
		}
	} finally {
		controller.abort();
		closeCallback();
		try {
			await closing;
		} finally {
			finish();
			await waiting.catch(() => {});
			signal.removeEventListener("abort", cancel);
			controller.signal.removeEventListener("abort", closeCallback);
		}
	}
}
