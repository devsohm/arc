import type { ModelThinkingLevel } from "@arc/ai";
import { ModelThinkingLevelSchema } from "@arc/ai/providers/model-schema";
import type { ModelRef, HarnessSettings } from "@arc/durable";
import { join, resolve } from "node:path";
import { type Static, Type } from "typebox";
import { Value } from "typebox/value";
import { readJsonFile, withFileUpdate } from "./file-storage.ts";

const nonempty = Type.String({ minLength: 1 });
const stringMap = Type.Record(Type.String(), Type.String());
const mcpServerSchema = Type.Union([
	Type.Object(
		{
			name: nonempty,
			transport: Type.Literal("stdio"),
			command: nonempty,
			args: Type.Optional(Type.Array(Type.String())),
			env: Type.Optional(stringMap),
			cwd: Type.Optional(nonempty),
		},
		{ additionalProperties: false },
	),
	Type.Object(
		{
			name: nonempty,
			transport: Type.Literal("http"),
			url: nonempty,
			headers: Type.Optional(stringMap),
			oauth: Type.Optional(
				Type.Object(
					{
						clientId: Type.Optional(nonempty),
						clientSecret: Type.Optional(nonempty),
						scope: Type.Optional(nonempty),
						redirectPort: Type.Optional(Type.Integer({ minimum: 1, maximum: 65535 })),
					},
					{ additionalProperties: false },
				),
			),
		},
		{ additionalProperties: false },
	),
]);

export type McpServerSetting = Static<typeof mcpServerSchema>;

export interface ApplicationSettings {
	readonly editorPaddingX?: number;
	readonly autocompleteMaxVisible?: number;
	readonly showHardwareCursor?: boolean;
	readonly clearOnShrink?: boolean;
	readonly showTerminalProgress?: boolean;
	readonly shellPath?: string;
	readonly shellCommandPrefix?: string;
	readonly cacheWarming?: import("../providers/cache-warmer.ts").CacheWarmingMode;
	readonly theme?: string;
	readonly treeFilterMode?: import("../sessions/navigation.ts").TreeFilter;
	readonly branchSummarySkipPrompt?: boolean;
	readonly branchSummary?: { readonly reserveTokens?: number };
	readonly retry?: import("@arc/durable").HarnessSettings["retry"];
	readonly themes?: string[];
	readonly markdown?: { readonly mermaid?: "off" | "final" | "streaming"; readonly codeBlockIndent?: string };
	readonly model?: ModelRef;
	readonly compaction?: HarnessSettings["compaction"];
	readonly steeringMode?: HarnessSettings["steeringMode"];
	readonly followUpMode?: HarnessSettings["followUpMode"];
	readonly enabledModels?: string[];
	readonly thinkingLevel?: ModelThinkingLevel;
	readonly modelThinkingLevels?: Readonly<Record<string, ModelThinkingLevel>>;
	readonly toolExecution: "parallel" | "sequential";
	readonly fullscreen: boolean;
	readonly extensionFiles: string[];
	readonly mcpServers: McpServerSetting[];
	readonly codemode: boolean;
	readonly resourcePaths: string[];
}

const compactionFields = {
	enabled: Type.Optional(Type.Boolean()),
	reserveTokens: Type.Optional(Type.Integer({ minimum: 0 })),
	keepRecentTokens: Type.Optional(Type.Integer({ minimum: 0 })),
	backgroundTokens: Type.Optional(Type.Integer({ minimum: 0 })),
};
const queueModeSchema = Type.Union([Type.Literal("all"), Type.Literal("one-at-a-time")]);
const settingsSchema = Type.Object(
	{
		editorPaddingX: Type.Optional(Type.Integer({ minimum: 0, maximum: 3 })),
		autocompleteMaxVisible: Type.Optional(Type.Integer({ minimum: 3, maximum: 20 })),
		showHardwareCursor: Type.Optional(Type.Boolean()),
		clearOnShrink: Type.Optional(Type.Boolean()),
		showTerminalProgress: Type.Optional(Type.Boolean()),
		shellPath: Type.Optional(nonempty),
		shellCommandPrefix: Type.Optional(Type.String()),
		cacheWarming: Type.Optional(Type.Union([Type.Literal("off"), Type.Literal("streaming"), Type.Literal("idle")])),
		theme: Type.Optional(nonempty),
		branchSummarySkipPrompt: Type.Optional(Type.Boolean()),
		branchSummary: Type.Optional(
			Type.Object({ reserveTokens: Type.Optional(Type.Integer({ minimum: 0 })) }, { additionalProperties: false }),
		),
		retry: Type.Optional(
			Type.Object(
				{
					enabled: Type.Optional(Type.Boolean()),
					maxRetries: Type.Optional(Type.Integer({ minimum: 0 })),
					baseDelayMs: Type.Optional(Type.Integer({ minimum: 0 })),
					maxAgentDelayMs: Type.Optional(Type.Integer({ minimum: 0 })),
				},
				{ additionalProperties: false },
			),
		),
		treeFilterMode: Type.Optional(
			Type.Union([
				Type.Literal("default"),
				Type.Literal("no-tools"),
				Type.Literal("user-only"),
				Type.Literal("labeled-only"),
				Type.Literal("all"),
			]),
		),
		themes: Type.Optional(Type.Array(nonempty)),
		markdown: Type.Optional(
			Type.Object(
				{
					mermaid: Type.Optional(Type.Union([Type.Literal("off"), Type.Literal("final"), Type.Literal("streaming")])),
					codeBlockIndent: Type.Optional(Type.String()),
				},
				{ additionalProperties: false },
			),
		),
		compaction: Type.Optional(
			Type.Object(
				{
					...compactionFields,
					modelOverrides: Type.Optional(
						Type.Record(Type.String(), Type.Object(compactionFields, { additionalProperties: false })),
					),
				},
				{ additionalProperties: false },
			),
		),
		steeringMode: Type.Optional(queueModeSchema),
		followUpMode: Type.Optional(queueModeSchema),
		model: Type.Optional(Type.Object({ provider: nonempty, modelId: nonempty }, { additionalProperties: false })),
		thinkingLevel: Type.Optional(ModelThinkingLevelSchema),
		modelThinkingLevels: Type.Optional(Type.Record(Type.String(), ModelThinkingLevelSchema)),
		enabledModels: Type.Optional(Type.Array(nonempty)),
		toolExecution: Type.Optional(Type.Union([Type.Literal("parallel"), Type.Literal("sequential")])),
		fullscreen: Type.Optional(Type.Boolean()),
		extensionFiles: Type.Optional(Type.Array(nonempty)),
		mcpServers: Type.Optional(Type.Array(mcpServerSchema)),
		codemode: Type.Optional(Type.Boolean()),
		resourcePaths: Type.Optional(Type.Array(nonempty)),
	},
	{ additionalProperties: false },
);

function parseSettings(data: unknown, path: string): Partial<ApplicationSettings> {
	if (!Value.Check(settingsSchema, data))
		throw new Error(`Invalid settings in ${path}: unknown keys or invalid values`);
	const names = new Set<string>();
	for (const server of data.mcpServers ?? []) {
		if (server.transport === "http" && server.oauth?.clientSecret && !server.oauth.clientId)
			throw new Error(`Invalid settings in ${path}: MCP OAuth clientSecret requires clientId`);
		if (names.has(server.name)) throw new Error(`Invalid settings in ${path}: duplicate MCP server name`);
		names.add(server.name);
		if (
			server.transport === "http" &&
			(!URL.canParse(server.url) || !["http:", "https:"].includes(new URL(server.url).protocol))
		)
			throw new Error(`Invalid settings in ${path}: MCP HTTP server requires an HTTP or HTTPS URL`);
	}
	return data;
}

async function readSettings(path: string): Promise<Partial<ApplicationSettings>> {
	const data = await readJsonFile(path);
	return data === undefined ? {} : parseSettings(data, path);
}

function resolvePaths(settings: Partial<ApplicationSettings>, base: string): Partial<ApplicationSettings> {
	return {
		...settings,
		...(settings.extensionFiles && { extensionFiles: settings.extensionFiles.map((path) => resolve(base, path)) }),
		...(settings.resourcePaths && { resourcePaths: settings.resourcePaths.map((path) => resolve(base, path)) }),
		...(settings.themes && { themes: settings.themes.map((path) => resolve(base, path)) }),
		...(settings.mcpServers && {
			mcpServers: settings.mcpServers.map((server) =>
				server.transport === "stdio" && server.cwd ? { ...server, cwd: resolve(base, server.cwd) } : server,
			),
		}),
	};
}

export async function loadSettings({
	cwd,
	home,
	projectTrusted = true,
}: {
	cwd: string;
	home: string;
	projectTrusted?: boolean;
}): Promise<ApplicationSettings> {
	const global = resolvePaths(await readSettings(join(home, "settings.json")), home);
	const project = projectTrusted ? resolvePaths(await readSettings(join(cwd, ".arc", "settings.json")), cwd) : {};
	return {
		toolExecution: "parallel",
		fullscreen: false,
		extensionFiles: [],
		mcpServers: [],
		codemode: true,
		resourcePaths: [],
		...global,
		...project,
	};
}

export async function saveSettings(home: string, change: Partial<ApplicationSettings>): Promise<void> {
	const path = resolve(home, "settings.json");
	const patch = structuredClone(parseSettings(change, path));
	await withFileUpdate(path, async () => {
		const current = await readSettings(path);
		return {
			result: undefined,
			data: parseSettings(
				{
					...current,
					...patch,
					...(patch.modelThinkingLevels
						? {
								modelThinkingLevels: { ...current.modelThinkingLevels, ...patch.modelThinkingLevels },
							}
						: {}),
				},
				path,
			),
		};
	});
}
