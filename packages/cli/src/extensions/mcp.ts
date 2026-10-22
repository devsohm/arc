import { Type } from "@arc/ai";
import { defineTool, isJsonValue, type Extension, type JsonObject, type Registry } from "@arc/durable";
import { McpClient, StdioTransport, StreamableHttpTransport, toLlmContent } from "@arc/mcp";
import type { McpServerSetting } from "../core/configuration/settings.ts";

import type { AuthProvider } from "@arc/mcp";

type Connected = { client: McpClient; extension: Extension; stop: () => void; abort: AbortController };
export class McpServers {
	readonly #registry: Registry;
	readonly #servers = new Map<string, Connected>();
	readonly #report: (error: unknown) => void;
	readonly #connecting = new Set<string>();
	#closed = false;
	readonly #changed: () => void;
	readonly #auth?: (server: McpServerSetting, signal: AbortSignal) => Promise<AuthProvider | undefined>;
	constructor(
		registry: Registry,
		report: (error: unknown) => void,
		changed: () => void = () => {},
		auth?: (server: McpServerSetting, signal: AbortSignal) => Promise<AuthProvider | undefined>,
	) {
		this.#auth = auth;
		this.#changed = changed;
		this.#registry = registry;
		this.#report = report;
	}
	async connect(server: McpServerSetting): Promise<void> {
		if (this.#closed) throw new Error("MCP manager is closed");
		if (this.#servers.has(server.name) || this.#connecting.has(server.name))
			throw new Error(`MCP server already connected: ${server.name}`);
		if (!/^[a-zA-Z0-9_-]+$/.test(server.name))
			throw new Error("MCP server names must contain letters, digits, underscores or hyphens");
		this.#connecting.add(server.name);
		const client = new McpClient({ name: "arc", version: "0.1.0-rc.1" });
		const abort = new AbortController();
		try {
			await client.connect(
				server.transport === "stdio"
					? new StdioTransport({ command: server.command, args: server.args, cwd: server.cwd, env: server.env })
					: new StreamableHttpTransport({
							url: server.url,
							headers: server.headers,
							authProvider: await this.#auth?.(server, abort.signal),
						}),
			);
			const extension = await this.#definition(server.name, client);
			if (this.#closed) throw new Error("MCP manager is closed");
			if (this.#registry.snapshot().extension(extension.name))
				throw new Error(`Extension name is already installed: ${extension.name}`);
			this.#registry.install(extension);
			const connection: Connected = { client, extension, stop: () => {}, abort };
			connection.stop = client.onNotification("notifications/tools/list_changed", () => {
				void this.#definition(server.name, client)
					.then((next) => {
						if (this.#closed || this.#servers.get(server.name) !== connection) return;
						this.#registry.install(next);
						connection.extension = next;
						this.#changed();
					})
					.catch(this.#report);
			});
			this.#servers.set(server.name, connection);
			this.#changed();
		} catch (error) {
			abort.abort();
			await client.close().catch(() => {});
			throw error;
		} finally {
			this.#connecting.delete(server.name);
		}
	}
	async #definition(name: string, client: McpClient): Promise<Extension> {
		const tools = client.serverCapabilities?.tools ? await client.listTools() : [];
		const names = new Set<string>();
		return {
			name: `mcp:${name}`,
			tools: tools.map((tool) => {
				const toolName = `mcp_${name}_${tool.name.replace(/[^a-zA-Z0-9_-]/g, "_")}`;
				if (names.has(toolName)) throw new Error(`MCP tool names collide: ${toolName}`);
				names.add(toolName);
				return defineTool({
					name: toolName,
					description: tool.description ?? `${name}/${tool.name}`,
					parameters: Type.Unsafe<JsonObject>(tool.inputSchema),
					...(tool.outputSchema ? { structuredOutputSchema: tool.outputSchema } : {}),
					async execute(args, api, context) {
						const result = await client.callTool(tool.name, args, {
							signal: context.abortSignal,
							onProgress: (progress) => {
								if (progress.message) api.output(progress.message + "\n");
							},
						});
						if (result.structuredContent !== undefined && !isJsonValue(result.structuredContent))
							throw new Error(`MCP tool returned non-JSON structured content: ${toolName}`);
						return {
							output: toLlmContent(result),
							isError: result.isError ?? false,
							...(result.structuredContent !== undefined ? { structuredOutput: result.structuredContent } : {}),
						};
					},
				});
			}),
		};
	}
	status(): readonly { name: string; tools: number }[] {
		return [...this.#servers].map(([name, server]) => ({ name, tools: server.extension.tools?.length ?? 0 }));
	}
	async disconnect(name: string): Promise<void> {
		const server = this.#servers.get(name);
		if (!server) return;
		this.#servers.delete(name);
		server.abort.abort();
		try {
			server.stop();
			if (this.#registry.snapshot().extension(server.extension.name) === server.extension)
				this.#registry.uninstall(server.extension);
		} finally {
			try {
				await server.client.close();
			} finally {
				this.#changed();
			}
		}
	}
	async close(): Promise<void> {
		this.#closed = true;
		const outcomes = await Promise.allSettled([...this.#servers.keys()].map((name) => this.disconnect(name)));
		const errors = outcomes.flatMap((outcome) => (outcome.status === "rejected" ? [outcome.reason] : []));
		if (errors.length) throw new AggregateError(errors, "MCP cleanup failed");
	}
}
