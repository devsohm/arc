import { SessionInfo } from "./sessions/info.ts";
import { savedSessions, removeSavedSession, renameSavedSession } from "./sessions/session-actions.ts";
import { VirtualModels } from "./providers/virtual-models.ts";
import { CacheWarmer } from "./providers/cache-warmer.ts";
import { observeProviders } from "./providers/provider-events.ts";
import { estimateContextTokens, calculateContextTokens } from "@arc/ai/utils/estimate";
import { parseCustomMessage, sendCustomMessage, flushCustomMessages, ENTRY_KIND } from "./sessions/custom-entries.ts";
import { parseArgs } from "node:util";
import { BUILTIN_FLAGS } from "../cli/args.ts";
import { EventEmitter } from "node:events";
import { setProviderContribution, removeProviderContribution } from "./providers/providers.ts";
import { createUnavailableUI, type ApplicationUI } from "./ui/ui.ts";
import { ThemeCatalog } from "./ui/theme.ts";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { writeFile, readFile } from "node:fs/promises";
import { CodemodeSandbox } from "@arc/codemode";
import { createCodemodeExtension } from "@arc/durable/codemode";
import { mcpAuthProvider, loginMcp, logoutMcp } from "./authentication/mcp-auth.ts";
import { McpAuthRequiredError } from "@arc/mcp";
import { McpOAuthAuthorizationRequiredError } from "@arc/mcp/oauth";
import { McpServers } from "../extensions/mcp.ts";
import { exportTranscript, importTranscript } from "./sessions/transcript.ts";
import {
	cleanupSessionResources,
	getSupportedThinkingLevels,
	clampThinkingLevel,
	type Models,
	type MutableModels,
	type Provider,
	type ModelThinkingLevel,
	type ImageContent,
} from "@arc/ai";
import {
	AgentDoc,
	DEFAULT_RETRY_POLICY,
	AssistantEntry,
	Harness,
	InboxDoc,
	LiveDoc,
	MemoryStorage,
	ProviderDoc,
	UsageDoc,
	recordUsage,
	copyJson,
	isJsonValue,
	renderSections,
	replaySections,
	watchEvents,
	type AgentEvent,
	type AgentEventStream,
	type AgentChange,
	type WatchHandle,
	type Context,
	type Conversation,
	type ConversationView,
	type TaskGraph,
	type Cursor,
	type HarnessOptions,
	type ModelRef,
	type Storage,
	type Submission,
	type EntryRecord,
	type EnvTarget,
	type UserInput,
} from "@arc/durable";
import { ApplicationRegistry } from "../extensions/extension-registry.ts";
import { BACKGROUND_CONTEXT, withAbortSignal } from "@arc/durable/context";
import { OutputBuffer } from "@arc/durable/output";
import { randomUUID } from "node:crypto";
import {
	BASH_ENTRY,
	bashContext,
	parseBashResult,
	type UserBashEntry,
	type UserBashProgress,
	type UserBashResult,
} from "./tools/user-bash.ts";
import { NodeExecutionEnv } from "@arc/durable/env/node";
import { ExtensionLoader } from "@arc/durable/extensions/node";
import { openNodeSqliteStorage } from "@arc/durable/storage/sqlite/node";
import { openNodeJsonlStorage } from "@arc/durable/storage/jsonl/node";
import { createCodingTools, createBashTool, previewEdit, type EditToolInput } from "@arc/durable/tools";
import { createNodePhotonImages } from "@arc/durable/images/node";
import { parseInput, prepareInput } from "./input.ts";
import { exportHtml } from "./sessions/export-html.ts";
import { shareHtml } from "./sessions/share.ts";
import { sessionTree, NavigationDoc } from "./sessions/navigation.ts";
import { abandonedBranch, summarizeBranch } from "./sessions/branch-summary.ts";
import { resolveModelScope } from "./providers/model-scope.ts";
import { projectTrust, saveProjectTrust } from "./configuration/trust.ts";
import { dirname } from "node:path";
import { loginWithUI } from "./authentication/ui-auth.ts";
import { createApplicationModels, logoutProvider, FileCredentialStore } from "./authentication/auth.ts";
import { createPromptExtension } from "./resources/prompt.ts";
import {
	expandPrompt,
	loadResources,
	loadResourcePaths,
	promptForSkill,
	type Resources,
} from "./resources/resources.ts";
import { loadSettings, saveSettings, type ApplicationSettings } from "./configuration/settings.ts";
import { listSessions, lockSession, newSessionFile, copySession, type SessionBackend } from "./sessions/sessions.ts";
import type {
	Application,
	ApplicationState,
	CommandInfo,
	CommandResult,
	RunResult,
	ApplicationExtension,
	ExtensionContext,
	ExtensionCommandContext,
	ExtensionCleanup,
	SessionReason,
	ApplicationMode,
	InputEvent,
	SessionDecision,
	NewSessionOptions,
	ForkOptions,
	NavigateTreeOptions,
	SessionReplacementOptions,
} from "./types.ts";

type SessionControl =
	| { readonly kind: "new"; readonly options?: NewSessionOptions }
	| { readonly kind: "fork"; readonly options?: ForkOptions }
	| { readonly kind: "tree"; readonly options?: NavigateTreeOptions }
	| { readonly kind: "resume"; readonly options?: SessionReplacementOptions };

function matchesRuntimeEvent<T extends AgentEvent["type"]>(
	event: AgentEvent,
	type: T,
): event is Extract<AgentEvent, { type: T }> {
	return event.type === type;
}

const applicationHooks = [
	"activate",
	"onSessionStart",
	"onSessionShutdown",
	"onUIAttached",
	"onUIDetached",
	"beforeCommand",
	"onInput",
	"onUserBash",
	"onResourcesDiscover",
	"onProjectTrust",
	"onCacheWarmingDecision",
	"beforeProviderRequest",
	"beforeProviderHeaders",
	"afterProviderResponse",
	"onProviderStreamEvent",
	"beforeSessionSwitch",
	"beforeFork",
	"beforeTree",
	"onTree",
	"onSessionInfoChanged",
	"onMcpServersChange",
] as const;

function mutableModels(models: Models): models is MutableModels {
	return (
		"setProvider" in models &&
		typeof models.setProvider === "function" &&
		"deleteProvider" in models &&
		typeof models.deleteProvider === "function" &&
		"clearProviders" in models &&
		typeof models.clearProviders === "function"
	);
}
export interface ApplicationOptions {
	readonly extensionArgs?: readonly string[];
	readonly mode?: ApplicationMode;
	readonly cwd?: string;
	readonly home?: string;
	readonly models?: Models;
	readonly storage?: Storage;
	readonly sessionFile?: string;
	readonly backend?: SessionBackend;
	readonly continueSession?: boolean;
	readonly context?: Context;
	readonly settings?: Partial<ApplicationSettings>;
	readonly resources?: Resources;
	readonly extensions?: readonly ApplicationExtension[];
	readonly extensionFiles?: readonly string[];
	readonly disableDiscoveredExtensions?: boolean;
	readonly provider?: string;
	readonly model?: ModelRef;
	readonly thinkingLevel?: ModelThinkingLevel;
	readonly env?: HarnessOptions["env"];
	readonly onReport?: HarnessOptions["onReport"];
	readonly projectTrusted?: boolean;
	readonly trustUI?: import("./types.ts").ProjectTrustContext["ui"];
	readonly resolveProjectTrust?: (
		context: import("./types.ts").ProjectTrustContext,
	) => import("./types.ts").ProjectTrustDecision | Promise<import("./types.ts").ProjectTrustDecision>;
	readonly systemPrompt?: string;
	readonly appendSystemPrompt?: string;
}
type Runtime = {
	harness: Harness;
	conversation: Conversation;
	file: string | undefined;
	sessions: Set<string>;
	release: () => Promise<void>;
};
const commands: readonly CommandInfo[] = [
	{ name: "help", description: "List commands" },
	{ name: "copy", description: "Copy the last assistant reply" },
	{ name: "model", description: "Select provider/model" },
	{ name: "scoped-models", description: "Choose and order models for cycling" },
	{ name: "thinking", description: "Set thinking level" },
	{ name: "tools", description: "List or select active tools" },
	{ name: "trust", description: "Save whether project resources may load on next startup" },
	{ name: "new", description: "Start a new session" },
	{ name: "resume", description: "List or open saved sessions" },
	{ name: "session", description: "Show current session" },
	{ name: "tree", description: "List or select conversations" },
	{ name: "tasks", description: "Toggle the live task panel" },
	{ name: "fork", description: "Fork at an entry" },
	{ name: "clone", description: "Fork at the current head" },
	{ name: "name", description: "Set session name" },
	{ name: "compact", description: "Compact conversation context" },
	{ name: "abort", description: "Cancel current work" },
	{ name: "reload", description: "Reload resources and extension files" },
	{ name: "export", description: "Export a readable conversation transcript or HTML file" },
	{ name: "share", description: "Share HTML through a secret GitHub gist using gh" },
	{ name: "import", description: "Import an Arc conversation transcript" },
	{ name: "settings", description: "Show or change application settings" },
	{ name: "mcp", description: "Show connected MCP servers" },
	{ name: "login", description: "Sign in to a provider" },
	{ name: "logout", description: "Remove a stored provider credential" },
	{ name: "hotkeys", description: "Show keyboard shortcuts" },
	{ name: "quit", description: "Exit the application" },
];
export function assistantText(entries: readonly EntryRecord[]): string {
	const last = entries.findLast((entry) => AssistantEntry.is(entry));
	return (
		last?.model
			?.flatMap((message) =>
				message.role === "assistant"
					? message.content.flatMap((block) => (block.type === "text" ? [block.text] : []))
					: [],
			)
			.join("\n") ?? ""
	);
}
export async function createApplication(options: ApplicationOptions = {}): Promise<Application> {
	return ApplicationRuntime.open(options);
}
class ApplicationRuntime implements Application {
	readonly #images = createNodePhotonImages();
	readonly cwd: string;
	readonly context: Context;
	readonly models: Models;
	readonly themes = new ThemeCatalog();
	readonly #options: ApplicationOptions;
	readonly #home: string;
	get home(): string {
		return this.#home;
	}
	readonly #registry = new ApplicationRegistry();
	readonly #loader = new ExtensionLoader(this.#registry.source, (extension) => this.#validateExtension(extension));
	readonly #environments = new Map<string, NodeExecutionEnv>();
	readonly #listeners = new Set<(state: ApplicationState) => void>();
	readonly #files = new Set<string>();
	readonly #providers = new Map<string, Provider>();
	readonly #baseModels: Models;
	readonly #providerOwners = new Map<ApplicationExtension, Set<string>>();
	#ui: ApplicationUI = createUnavailableUI();
	get ui(): ApplicationUI {
		return this.#ui;
	}
	get mode(): ApplicationMode {
		return this.#ui.capabilities.editor ? "interactive" : (this.#options.mode ?? "sdk");
	}
	attachUI(ui: ApplicationUI): () => Promise<void> {
		this.#assertOpen();
		const previous = this.#ui;
		this.#ui = ui;
		void this.#event("onUIAttached", "startup");
		return async () => {
			if (this.#ui !== ui) return;
			await this.#event("onUIDetached", "quit");
			if (this.#ui === ui) this.#ui = previous;
		};
	}
	readonly #mcp = new McpServers(
		this.#registry,
		(error) => this.#report(error, { type: "listener_error" }),
		() => {
			if (this.#state && !this.#closed)
				void this.#queueExtensionWork(() => this.#mcpChanged()).catch((error) =>
					this.#report(error, { type: "listener_error" }),
				);
		},
		(server, signal) => mcpAuthProvider(this.#home, server, signal),
	);
	#flagValues: Readonly<Record<string, string | boolean | undefined>> = {};
	readonly #extensionBus = new EventEmitter();
	readonly #extensionSubscriptions = new Map<ApplicationExtension, Set<() => void>>();
	readonly #mcpOwners = new Map<string, ApplicationExtension>();
	#sandbox: CodemodeSandbox | undefined;
	#codemode: ReturnType<typeof createCodemodeExtension> | undefined;
	#commandAbort: AbortController | undefined;
	readonly #userBash = new Map<
		string,
		{ progress: UserBashProgress; controller: AbortController; work: Promise<UserBashResult> }
	>();
	#enabledModels: string[] | undefined;
	#summarizing = false;
	#projectTrusted: boolean;
	#admissions: Promise<unknown> = Promise.resolve();
	#admit<T>(operation: () => Promise<T>): Promise<T> {
		const result = this.#admissions.then(operation);
		this.#admissions = result.catch(() => {});
		return result;
	}
	#settings: ApplicationSettings;
	#fullscreenRevision = 0;
	#resources: Resources;
	#discoveredThemePaths: readonly string[] = [];
	#opened: Runtime | undefined;
	get #runtime(): Runtime {
		if (!this.#opened) throw new Error("Session is not open");
		return this.#opened;
	}
	set #runtime(value: Runtime) {
		this.#opened = value;
	}
	#view: WatchHandle<ConversationView> | undefined;
	#runtimeEvents: AgentEventStream | undefined;
	#taskGraph: WatchHandle<TaskGraph> | undefined;
	#taskOwner: Harness | undefined;
	#showTasks = false;
	#unsubscribeUsage: (() => void) | undefined;
	#usageOwner: Harness | undefined;
	#usageTotals: Promise<import("@arc/durable").UsageState> | undefined;
	#refresh: Promise<void> = Promise.resolve();
	#refreshScheduled = false;
	#epoch = 0;
	#commandEpoch = 0;
	#presentationRevision = 0;
	readonly #cacheWarmer: CacheWarmer;
	readonly #virtualModels: VirtualModels;
	readonly #lifetimes = new Map<string, { extension: ApplicationExtension; cleanup?: ExtensionCleanup }>();
	#extensionEvents: Promise<void> = Promise.resolve();
	#activeRuns = 0;
	#closed: Promise<void> | undefined;
	#transition: Promise<void> | undefined;
	#state: ApplicationState | undefined;
	private constructor(
		options: ApplicationOptions,
		models: Models,
		settings: ApplicationSettings,
		resources: Resources,
	) {
		this.#options = options;
		this.#projectTrusted = options.projectTrusted ?? false;
		this.cwd = resolve(options.cwd ?? process.cwd());
		this.context = options.context ?? BACKGROUND_CONTEXT;
		this.#home = resolve(options.home ?? join(homedir(), ".arc"));
		this.#baseModels = models;
		const providerEnvironment = {
			cwd: this.cwd,
			mode: () => this.mode,
			listeners: () =>
				this.#registry
					.snapshot()
					.installed()
					.flatMap((extension) => {
						const callbacks: ApplicationExtension = extension;
						return callbacks.beforeProviderRequest ||
							callbacks.beforeProviderHeaders ||
							callbacks.afterProviderResponse ||
							callbacks.onProviderStreamEvent
							? [
									{
										callbacks,
										active: () => !this.#closed && this.#registry.owns(extension),
										report: (error: unknown) =>
											this.#report(error, { type: "extension_error", extension: extension.name }),
									},
								]
							: [];
					}),
		};
		this.#virtualModels = new VirtualModels(observeProviders(models, providerEnvironment), this.cwd);
		this.#cacheWarmer = new CacheWarmer({
			models: this.#virtualModels.models,
			mode: () => this.#settings.cacheWarming ?? "streaming",
			tokens: () => {
				const messages = this.#state?.view.entries.flatMap((entry) => entry.model ?? []) ?? [];
				for (let i = messages.length - 1; i >= 0; i--) {
					const message = messages[i];
					if (message?.role === "assistant")
						return message.usage.input + message.usage.cacheRead + message.usage.cacheWrite;
				}
				return 0;
			},
			decide: async (decision) => {
				let action = decision.action;
				for (const { extension } of [...this.#lifetimes.values()]) {
					try {
						const result = await extension.onCacheWarmingDecision?.(this.#extensionContext(extension), {
							...decision,
							action,
						});
						if (result?.action !== undefined) {
							if (result.action !== "warm" && result.action !== "stop")
								throw new Error("Invalid cache warming decision");
							action = result.action;
						}
					} catch (error) {
						this.#report(error, { type: "extension_error", extension: extension.name });
					}
				}
				return action;
			},
			record: async (request, usage, override) => {
				const conversation = this.conversation;
				await conversation.commit(async (tx) => {
					await recordUsage(tx, conversation.id, "tools", "cache_warm", usage);
					await tx.appendEntry(conversation.id, {
						kind: "application.cache-warm",
						data: {
							provider: request.model.provider,
							model: request.model.id,
							usage: copyJson(usage, { omitUndefinedProperties: true }),
							override,
						},
					});
				}, this.context);
			},
			report: (error) => this.#report(error, { type: "listener_error" }),
		});
		this.models = observeProviders(this.#virtualModels.models, {
			...providerEnvironment,
			listeners: () => [],
			onSession: (sessionId) => this.#opened?.sessions.add(sessionId),
			onRequest: (model, context, options) => {
				if (this.#closed || !this.#opened || !options?.sessionId) return;
				const conversation = this.conversation,
					epoch = this.#epoch,
					selection = this.#state?.agent.model;
				const boundary = () =>
					this.#view?.value.entries.findLast(
						(entry) =>
							entry.head !== undefined ||
							entry.model?.some((message) => message.role === "user" || message.role === "system"),
					)?.id;
				const inputBoundary = boundary();
				this.#cacheWarmer.start(
					{ model, context, options },
					() =>
						!this.#closed &&
						this.#epoch === epoch &&
						this.#opened?.conversation === conversation &&
						this.#state?.agent.model?.provider === selection?.provider &&
						this.#state?.agent.model?.modelId === selection?.modelId &&
						boundary() === inputBoundary,
				);
			},
		});

		this.#settings = settings;
		this.#enabledModels = settings.enabledModels;
		this.#resources = resources;
	}
	static async open(options: ApplicationOptions): Promise<ApplicationRuntime> {
		if (options.model && (!options.model.provider || !options.model.modelId))
			throw new Error("A model needs a provider and modelId");
		const cwd = resolve(options.cwd ?? process.cwd()),
			home = resolve(options.home ?? join(homedir(), ".arc"));
		const trustDecision = options.projectTrusted ?? (await projectTrust(home, cwd));
		const trusted = trustDecision ?? false;
		options = { ...options, projectTrusted: trusted };
		let settings = { ...(await loadSettings({ cwd, home, projectTrusted: trusted })), ...options.settings };
		let resources =
			options.resources ?? (await loadResources({ cwd, home, paths: settings.resourcePaths, projectTrusted: trusted }));
		const models = options.models ?? createApplicationModels({ home });
		const app = new ApplicationRuntime(options, models, settings, resources);
		try {
			await app.themes.reload(app.#themePaths());
			const defaults = createCodingTools({ images: await app.#images });
			app.#registry.install({
				...defaults,
				tools: [
					...(defaults.tools ?? []).filter((tool) => tool.name !== "bash"),
					createBashTool({
						prepare(execution) {
							if (app.#settings.shellCommandPrefix)
								execution.command = `${app.#settings.shellCommandPrefix}\n${execution.command}`;
						},
					}),
				],
			});
			app.#registry.install(createPromptExtension(resources, cwd, options));
			app.#registry.install(app.#virtualModels.extension());
			for (const extension of options.extensions ?? []) {
				app.#validateExtension(extension);
				app.#registry.install(extension);
			}
			await app.#loadFiles(resources);
			if (trustDecision === undefined) {
				const decision = await app.#resolveTrust();
				if (decision.trusted !== "undecided" && decision.remember)
					await saveProjectTrust(home, cwd, decision.trusted === "yes");
				if (decision.trusted === "yes") {
					app.#projectTrusted = true;
					settings = { ...(await loadSettings({ cwd, home, projectTrusted: true })), ...options.settings };
					resources =
						options.resources ??
						(await loadResources({ cwd, home, paths: settings.resourcePaths, projectTrusted: true }));
					app.#settings = settings;
					app.#enabledModels = settings.enabledModels;
					app.#resources = resources;
					app.#registry.install(createPromptExtension(resources, cwd, options));
					await app.themes.reload(app.#themePaths());
					await app.#loadFiles(resources, true);
				}
			}
			app.#refreshFlagValues();
			app.#syncProviders();
			if (options.provider && !app.models.getProvider(options.provider))
				throw new Error(`Unknown provider: ${options.provider}`);
			if (options.model && !app.models.getModel(options.model.provider, options.model.modelId))
				throw new Error(`Unknown model: ${options.model.provider}/${options.model.modelId}`);
			for (const server of settings.mcpServers) {
				try {
					await app.#mcp.connect(server.transport === "stdio" ? { ...server, cwd: server.cwd ?? cwd } : server);
				} catch (error) {
					if (!(error instanceof McpAuthRequiredError) && !(error instanceof McpOAuthAuthorizationRequiredError))
						throw error;
					app.#report(new Error(`MCP ${server.name} needs authorization. Use /mcp login ${server.name}`), {
						type: "listener_error",
					});
				}
			}
			if (settings.codemode) {
				app.#sandbox = new CodemodeSandbox();
				app.#codemode = createCodemodeExtension({ sandbox: app.#sandbox, models: true });
				app.#registry.install(app.#codemode);
			}
			let file = options.sessionFile;
			const backend = options.backend ?? "sqlite";
			if (!options.storage && backend !== "memory" && !file)
				file = options.continueSession ? (await listSessions(home, cwd))[0]?.path : undefined;
			if (!options.storage && backend !== "memory" && !file) file = await newSessionFile(home, cwd, backend);
			app.#runtime = await app.#openRuntime(file, options.storage);
			await app.#attach();
			await app.#syncLifetimes();
			app.#refreshFlagValues(true);
			await app.#event("onSessionStart", "startup");
			await app.#discoverResources(resources, "startup");
			app.harness.resume();
			return app;
		} catch (error) {
			await app.#dispose().catch(() => {});
			throw error;
		}
	}
	get harness(): Harness {
		return this.#runtime.harness;
	}
	get conversation(): Conversation {
		return this.#runtime.conversation;
	}
	#buildEnv(target: EnvTarget, context: Context) {
		if (this.#options.env) return this.#options.env(target, context);
		const cwd = target.cwd ?? this.cwd;
		const key = JSON.stringify([cwd, this.#settings.shellPath]);
		let env = this.#environments.get(key);
		if (!env) {
			env = new NodeExecutionEnv({ cwd, shellPath: this.#settings.shellPath });
			this.#environments.set(key, env);
		}
		return env;
	}
	async #openRuntime(file?: string, injected?: Storage, mode: "startup" | "clone" = "startup"): Promise<Runtime> {
		const release = file ? await lockSession(resolve(file)) : async () => {};
		let storage: Storage | undefined = injected;
		let harness: Harness | undefined;
		try {
			storage ??= file
				? file.endsWith(".jsonl")
					? await openNodeJsonlStorage(resolve(file), this.context)
					: await openNodeSqliteStorage(resolve(file))
				: new MemoryStorage();
			harness = await Harness.open(
				storage,
				{
					models: this.models,
					registry: this.#registry,
					settings: () => this.#settings,
					env: (target, context) => this.#buildEnv(target, context),
					onReport: (error, from) => this.#report(error, from),
				},
				this.context,
			);
			const root = await harness.root(this.context);
			const info = await harness.snapshot(SessionInfo, this.context);
			const conversation = info?.conversationId
				? ((await harness.conversation(info.conversationId, this.context)) ?? root)
				: root;
			const existing = await harness.snapshot(AgentDoc, conversation.id, this.context);
			const providerModel =
				mode === "startup" && this.#options.provider && !this.#options.model
					? this.models.getModels(this.#options.provider)[0]
					: undefined;
			if (mode === "startup" && this.#options.provider && !this.#options.model && !providerModel)
				throw new Error(`Provider has no models: ${this.#options.provider}`);
			const scoped =
				!existing?.model && !this.#options.model && !providerModel && this.#enabledModels?.length
					? resolveModelScope(this.#enabledModels, await this.models.getAvailable()).models[0]
					: undefined;
			let chosenModel =
				(mode === "startup" ? this.#options.model : undefined) ??
				(providerModel ? { provider: providerModel.provider, modelId: providerModel.id } : undefined) ??
				(scoped ? { provider: scoped.model.provider, modelId: scoped.model.id } : undefined) ??
				(!existing?.model ? this.#settings.model : undefined);
			if (!chosenModel && existing?.model && !this.models.getModel(existing.model.provider, existing.model.modelId)) {
				const messages = (await conversation.context(this.context)).messages;
				for (let index = messages.length - 1; index >= 0; index--) {
					const message = messages[index];
					if (message?.role !== "assistant" || message.stopReason === "error" || message.stopReason === "aborted")
						continue;
					if (this.models.getModel(message.provider, message.model)) {
						chosenModel = { provider: message.provider, modelId: message.model };
						break;
					}
				}
			}
			const requestedThinking = mode === "startup" ? this.#options.thinkingLevel : undefined;
			const initialModel = chosenModel ? this.models.getModel(chosenModel.provider, chosenModel.modelId) : undefined;
			const thinking =
				requestedThinking ??
				(existing?.thinkingLevel === undefined
					? (scoped?.thinkingLevel ??
						(chosenModel
							? this.#settings.modelThinkingLevels?.[`${chosenModel.provider}/${chosenModel.modelId}`]
							: undefined) ??
						this.#settings.thinkingLevel)
					: undefined);
			const initial: AgentChange = {
				cwd: this.cwd,
				...(chosenModel ? { model: chosenModel } : {}),
				...(thinking === undefined
					? {}
					: { thinkingLevel: initialModel ? clampThinkingLevel(initialModel, thinking) : thinking }),
			};

			await conversation.configure(initial, this.context);
			if (!(await conversation.agent(this.context)).model) {
				for (const model of this.models.getModels()) {
					if (await this.models.checkAuth(model.provider)) {
						await conversation.configure(
							{
								model: { provider: model.provider, modelId: model.id },
								thinkingLevel: clampThinkingLevel(
									model,
									requestedThinking ??
										this.#settings.modelThinkingLevels?.[`${model.provider}/${model.id}`] ??
										this.#settings.thinkingLevel ??
										existing?.thinkingLevel ??
										"off",
								),
							},
							this.context,
						);
						break;
					}
				}
			}
			const sessions = new Set<string>();
			return {
				harness,
				conversation,
				file: file ? resolve(file) : undefined,
				sessions,
				release: async () => {
					const errors: unknown[] = [];
					for (const sessionId of sessions) {
						try {
							cleanupSessionResources(sessionId);
						} catch (error) {
							errors.push(error);
						}
					}
					sessions.clear();
					try {
						await release();
					} catch (error) {
						errors.push(error);
					}
					if (errors.length) throw new AggregateError(errors, "Session cleanup failed");
				},
			};
		} catch (error) {
			await harness?.close(this.context).catch(() => {});
			if (!harness) await storage?.close(this.context).catch(() => {});
			await release();
			throw error;
		}
	}
	#detachTasks(): void {
		void this.#taskGraph?.stop();
		this.#taskGraph = undefined;
		this.#taskOwner = undefined;
	}
	async #attachTasks(): Promise<void> {
		this.#detachTasks();
		if (!this.#showTasks) return;
		this.#taskGraph = await this.harness.watchTaskGraph(this.context);
		this.#taskOwner = this.harness;
		this.#taskGraph.start(async () => this.#scheduleRefresh());
	}

	async #attach(): Promise<void> {
		this.#cacheWarmer.cancel("conversation changed");
		this.#epoch++;
		await this.#runtimeEvents?.stop();
		this.#runtimeEvents = undefined;
		await this.#view?.stop();
		this.#view = undefined;
		this.#view = await this.conversation.watch(this.context);
		this.#view.start(async () => this.#scheduleRefresh());
		if (this.#usageOwner !== this.harness) {
			this.#unsubscribeUsage?.();
			this.#usageOwner = this.harness;
			this.#usageTotals = undefined;
			this.#unsubscribeUsage = this.harness.subscribeCommits((publication) => {
				if (
					publication.changes.some(
						(change) =>
							(change.type === "document" || change.type === "document.copy") &&
							change.record.kind === UsageDoc.definition.kind,
					)
				) {
					this.#usageTotals = undefined;
					this.#scheduleRefresh();
				}
			});
		}
		if (this.#taskOwner !== this.harness) await this.#attachTasks();
		await this.#readState();
		const epoch = this.#epoch;
		this.#runtimeEvents = await watchEvents(this.harness, this.conversation.id, this.context);
		this.#runtimeEvents.start(async (events) => {
			for (const event of events) {
				if (this.#closed || epoch !== this.#epoch) return;
				for (const { extension } of [...this.#lifetimes.values()]) {
					for (const listener of this.#registry.effective(extension).runtimeEvents ?? []) {
						if (!this.#registry.owns(extension) || epoch !== this.#epoch) break;
						try {
							await listener(this.#extensionContext(extension), event);
						} catch (error) {
							this.#report(error, { type: "extension_error", extension: extension.name });
						}
					}
				}
			}
		});
	}
	#scheduleRefresh(): void {
		if (this.#refreshScheduled || this.#closed) return;
		this.#refreshScheduled = true;
		setImmediate(() => {
			this.#refreshScheduled = false;
			if (this.#closed) return;
			this.#refresh = this.#refresh
				.then(() => this.#readState())
				.catch((error) => this.#report(error, { type: "listener_error" }));
		});
	}
	async #readState(): Promise<void> {
		const epoch = this.#epoch,
			conversation = this.conversation,
			harness = this.harness;
		while (true) {
			const view = this.#view?.value;
			if (!view) return;
			const [agent, live, inbox, usage, info] = await Promise.all([
				conversation.agent(this.context),
				harness.snapshot(LiveDoc, conversation.id, this.context),
				harness.snapshot(InboxDoc, conversation.id, this.context),
				(this.#usageTotals ??= harness.usage(this.context)),
				harness.snapshot(SessionInfo, this.context),
			]);
			if (epoch !== this.#epoch || !this.#view) return;
			if (view !== this.#view.value) continue;
			const latest = view.entries
				.flatMap((entry) => entry.model ?? [])
				.findLast(
					(message) =>
						message.role === "assistant" && message.stopReason !== "error" && message.stopReason !== "aborted",
				);
			this.#state = {
				userBash: [...this.#userBash.values()].map(({ progress }) => progress),
				cwd: this.cwd,
				enabledModels: this.#enabledModels ? [...this.#enabledModels] : undefined,
				sessionFile: this.#runtime.file,
				sessionName: info?.name,
				parentSession: info?.parentSession,
				presentationRevision: this.#presentationRevision,
				fullscreenRevision: this.#fullscreenRevision,
				settings: {
					editorPaddingX: this.#settings.editorPaddingX,
					autocompleteMaxVisible: this.#settings.autocompleteMaxVisible,
					showHardwareCursor: this.#settings.showHardwareCursor,
					clearOnShrink: this.#settings.clearOnShrink,
					showTerminalProgress: this.#settings.showTerminalProgress,
					codemode: this.#settings.codemode,
					retry: this.#settings.retry,
					treeFilterMode: this.#settings.treeFilterMode,
					branchSummarySkipPrompt: this.#settings.branchSummarySkipPrompt,
					cacheWarming: this.#settings.cacheWarming ?? "streaming",
					theme: this.#settings.theme,
					markdown: this.#settings.markdown,
					toolExecution: this.#settings.toolExecution,
					fullscreen: this.#settings.fullscreen,
					compaction: this.#settings.compaction,
					steeringMode: this.#settings.steeringMode,
					followUpMode: this.#settings.followUpMode,
				},
				cacheWarming: this.#cacheWarmer.status,
				routedModel:
					agent.model &&
					this.#virtualModels.has(agent.model.provider, agent.model.modelId) &&
					latest?.role === "assistant"
						? {
								provider: latest.provider,
								modelId: latest.model,
								thinkingLevel: latest.thinkingLevel,
								contextWindow: this.models.getModel(latest.provider, latest.model)?.contextWindow,
							}
						: undefined,
				tasks: this.#taskGraph?.value,
				view,
				agent,
				live: live ?? {},
				inbox: inbox ?? InboxDoc.definition.initial(),
				usage: usage ?? UsageDoc.definition.initial(),
				busy:
					this.#userBash.size > 0 ||
					this.#summarizing ||
					this.#activeRuns > 0 ||
					live?.run !== undefined ||
					live?.compactions?.some((item) => item.blocking) === true,
			};
			if (!this.#state.busy) this.#cacheWarmer.settled();
			this.#cacheWarmer.modeChanged();
			this.#state = { ...this.#state, cacheWarming: this.#cacheWarmer.status };
			for (const listener of this.#listeners) {
				try {
					listener(this.#state);
				} catch (error) {
					this.#report(error, { type: "listener_error" });
				}
			}
			return;
		}
	}
	async snapshot(): Promise<ApplicationState> {
		await this.#transition;
		this.#assertOpen();
		await this.#readState();
		if (!this.#state) throw new Error("Application state is unavailable");
		return this.#state;
	}
	subscribe(listener: (state: ApplicationState) => void): () => void {
		this.#assertOpen();
		this.#listeners.add(listener);
		if (this.#state) {
			try {
				listener(this.#state);
			} catch (error) {
				this.#report(error, { type: "listener_error" });
			}
		}
		return () => {
			this.#listeners.delete(listener);
		};
	}
	#report(error: unknown, from: Parameters<NonNullable<HarnessOptions["onReport"]>>[1]): void {
		try {
			this.#options.onReport?.(error, from);
		} catch {}
	}
	#assertOpen(): void {
		if (this.#closed) throw new Error("Application is closed");
	}

	async submit(
		input: UserInput,
		options?: { readonly whenBusy?: "steer" | "followUp" | "reject" },
	): Promise<Submission | undefined> {
		this.#cacheWarmer.cancel("new input");
		let source = structuredClone(parseInput(input));
		return this.#admit(async () => {
			await this.#transition;
			this.#assertOpen();
			const blocks = typeof source === "string" ? undefined : source;
			let text =
				typeof source === "string"
					? source
					: source.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("");
			let images: readonly ImageContent[] | undefined = blocks?.filter((part) => part.type === "image");
			let transformed = false;
			for (const { extension } of [...this.#lifetimes.values()]) {
				const event: InputEvent = {
					text,
					images,
					source: this.mode === "rpc" ? "rpc" : this.mode === "sdk" ? "extension" : "interactive",
					streamingBehavior: options?.whenBusy === "reject" ? undefined : options?.whenBusy,
				};
				try {
					const result: unknown = await extension.onInput?.(this.#extensionContext(extension), event);
					if (result === undefined) continue;
					if (!result || typeof result !== "object" || !("action" in result))
						throw new Error("Invalid input hook result");
					if (result.action === "handled") return undefined;
					if (result.action === "continue") continue;
					if (result.action !== "transform" || !("text" in result) || typeof result.text !== "string")
						throw new Error("Invalid input transformation");
					const candidate = parseInput([
						{ type: "text", text: result.text },
						...("images" in result && result.images !== undefined
							? Array.isArray(result.images)
								? result.images
								: [result.images]
							: (images ?? [])),
					]);
					if (typeof candidate === "string") throw new Error("Invalid input transformation");
					text = result.text;
					images = candidate.filter((part) => part.type === "image");
					transformed = true;
				} catch (error) {
					this.#report(error, { type: "extension_error", extension: extension.name });
				}
			}
			if (transformed) source = images?.length ? [{ type: "text", text }, ...images] : text;
			const conversation = this.conversation;
			const ref = (await conversation.agent(this.context)).model;
			if (!ref) throw new Error("Select a model with /model provider/model before sending input");
			const content = await prepareInput(source, this.models.getModel(ref.provider, ref.modelId), await this.#images);
			this.#assertOpen();
			await flushCustomMessages(conversation, this.harness, this.context);
			return conversation.submit({ type: "input", content, whenBusy: options?.whenBusy ?? "followUp" }, this.context);
		});
	}

	async run(input: UserInput): Promise<RunResult> {
		this.#activeRuns++;
		try {
			const submission = await this.submit(input);
			if (!submission) return { status: "done", text: "" };
			const harness = this.harness;
			const settled = await submission.wait(this.context);
			const answerId = settled.status === "done" ? settled.answer : undefined;
			const answer =
				answerId === undefined ? undefined : await harness.commit((tx) => tx.entry(answerId), this.context);
			await this.snapshot();
			return { status: settled.status, text: answer ? assistantText([answer]) : "" };
		} finally {
			this.#activeRuns--;
			if (!this.#closed) await this.#readState().catch((error) => this.#report(error, { type: "listener_error" }));
		}
	}

	async cycleModel(direction: "forward" | "backward" = "forward"): Promise<CommandResult> {
		return this.#admit(async () => {
			this.#assertOpen();
			const all = await this.models.getAvailable();
			const scoped = resolveModelScope(this.#enabledModels ?? [], all).models;
			const models = scoped.length ? scoped : all.map((model) => ({ model, thinkingLevel: undefined }));
			if (!models.length) throw new Error("No authenticated models available");
			const current = await this.conversation.agent(this.context);
			const index = models.findIndex(
				({ model }) => model.provider === current.model?.provider && model.id === current.model.modelId,
			);
			const next =
				models[
					(index < 0
						? direction === "forward"
							? 0
							: models.length - 1
						: index + (direction === "forward" ? 1 : models.length - 1)) % models.length
				];
			if (!next) throw new Error("No model available");
			await this.conversation.configure(
				{
					model: { provider: next.model.provider, modelId: next.model.id },
					thinkingLevel: clampThinkingLevel(
						next.model,
						next.thinkingLevel ??
							this.#settings.modelThinkingLevels?.[`${next.model.provider}/${next.model.id}`] ??
							this.#settings.thinkingLevel ??
							current.thinkingLevel ??
							"off",
					),
				},
				this.context,
			);
			await this.#readState();
			return { message: `Model: ${next.model.provider}/${next.model.id}` };
		});
	}
	async previewEdit(input: EditToolInput): ReturnType<typeof previewEdit> {
		this.#assertOpen();
		const harness = this.harness;
		const conversationId = this.conversation.id;
		const cwd = (await harness.snapshot(AgentDoc, conversationId, this.context))?.cwd ?? this.cwd;
		const env = await this.#buildEnv({ conversationId, cwd, read: harness }, this.context);
		if (!env) throw new Error("No execution environment is configured");
		return previewEdit(env, input, this.context);
	}
	async getLabel(id: import("@arc/durable").EntryId): Promise<string | undefined> {
		return (await this.harness.snapshot(NavigationDoc, this.context))?.labels[String(id)]?.text;
	}
	async setLabel(id: import("@arc/durable").EntryId, label: string | undefined): Promise<void> {
		const text = label?.trim();
		await this.harness.commit(async (tx) => {
			if (!(await tx.entry(id))) throw new Error(`Unknown entry: ${id}`);
			const doc = await tx.doc(NavigationDoc);
			if (text) doc.labels[String(id)] = { text, updated: Date.now() };
			else delete doc.labels[String(id)];
		}, this.context);
	}

	async executeBash(
		command: string,
		options?: {
			readonly excludeFromContext?: boolean;
			readonly onChunk?: (chunk: string) => void;
			readonly signal?: AbortSignal;
		},
	): Promise<UserBashResult> {
		if (typeof command !== "string" || !command.trim()) throw new Error("Shell command is empty");
		const { work } = await this.#admit(async () => {
			await this.#transition;
			this.#assertOpen();
			const conversation = this.conversation,
				harness = this.harness;
			const agent = await conversation.agent(this.context);
			this.#assertOpen();
			const controller = new AbortController();
			const signal = AbortSignal.any([
				controller.signal,
				...(this.context.abortSignal ? [this.context.abortSignal] : []),
				...(options?.signal ? [options.signal] : []),
			]);
			const progress: UserBashProgress = {
				id: randomUUID(),
				command,
				output: "",
				timestamp: Date.now(),
				excludeFromContext: options?.excludeFromContext ?? false,
			};
			const work = this.#runBash(
				progress,
				conversation,
				harness,
				agent.cwd ?? this.cwd,
				signal,
				options?.onChunk,
			).finally(() => {
				this.#userBash.delete(progress.id);
				this.#scheduleRefresh();
			});
			this.#userBash.set(progress.id, { progress, controller, work });
			void work.catch(() => {});
			await this.#readState();
			return { work };
		});
		return work;
	}
	async #runBash(
		progress: UserBashProgress,
		conversation: Conversation,
		harness: Harness,
		cwd: string,
		signal: AbortSignal,
		onChunk?: (chunk: string) => void,
	): Promise<UserBashResult> {
		const context = withAbortSignal(signal, this.context);
		let supplied: Awaited<ReturnType<NonNullable<ApplicationExtension["onUserBash"]>>> = undefined;
		for (const { extension } of [...this.#lifetimes.values()]) {
			signal.throwIfAborted();
			supplied = await extension.onUserBash?.(this.#extensionContext(extension), {
				command: progress.command,
				cwd,
				excludeFromContext: progress.excludeFromContext,
				signal,
			});
			if (supplied) break;
		}
		let result: UserBashResult;
		if (supplied?.result) result = parseBashResult(supplied.result);
		else {
			const env =
				supplied?.operations ??
				(await this.#buildEnv({ conversationId: conversation.id, cwd, read: harness }, context));
			if (!env) throw new Error("No shell execution environment is available");
			const output = new OutputBuffer({ maxBytes: 50 * 1024, maxLines: 2000, retain: "tail" });
			const command = this.#settings.shellCommandPrefix
				? `${this.#settings.shellCommandPrefix}\n${progress.command}`
				: progress.command;
			const executed = await env.exec(
				command,
				{
					cwd,
					spill: { afterBytes: 50 * 1024, afterLines: 2000 },
					window: { maxBytes: 50 * 1024, maxLines: 2000, minIntervalMs: 100, bytesPerSecond: 64 * 1024 },
					onOutput: (chunk, _context, info) => {
						output.push(chunk, info.skipped);
						const active = this.#userBash.get(progress.id);
						if (active) active.progress = { ...progress, output: output.snapshot().text };
						onChunk?.(chunk);
						this.#scheduleRefresh();
					},
				},
				context,
			);
			if (!executed.ok && executed.error.code !== "aborted") throw executed.error;
			output.end();
			const retained = output.snapshot();
			const spill = executed.ok ? executed.value.spillPath : executed.error.spillPath;
			result = {
				output: retained.text,
				cancelled: !executed.ok,
				truncated: retained.droppedBytes > 0,
				...(executed.ok ? { exitCode: executed.value.exitCode } : {}),
				...(spill ? { fullOutputPath: spill } : {}),
			};
		}
		const data: UserBashEntry = {
			id: progress.id,
			command: progress.command,
			timestamp: progress.timestamp,
			excludeFromContext: progress.excludeFromContext,
			result,
		};
		await conversation.submit(
			{
				type: "write",
				requestId: `shell:${progress.id}`,
				entry: {
					kind: BASH_ENTRY,
					data,
					...(progress.excludeFromContext
						? {}
						: {
								model: [
									{ role: "user", content: bashContext(progress.command, result), timestamp: progress.timestamp },
								],
							}),
				},
			},
			this.context,
		);
		await this.#readState();
		return result;
	}
	async abort(): Promise<void> {
		this.#assertOpen();
		for (const { controller } of this.#userBash.values()) controller.abort(new Error("Shell command cancelled"));
		this.#commandAbort?.abort(new Error("Operation cancelled"));
		await this.conversation.abort(this.context);
	}
	#extensionCommands() {
		const items = this.#registry
			.snapshot()
			.installed()
			.flatMap((extension) => this.#commandsOf(extension).map((command) => ({ extension, command })));
		const totals = new Map<string, number>();
		for (const { command } of items) totals.set(command.name, (totals.get(command.name) ?? 0) + 1);
		const seen = new Map<string, number>(),
			used = new Set<string>();
		return items.map((item) => {
			const base = item.command.name,
				ordinal = (seen.get(base) ?? 0) + 1;
			seen.set(base, ordinal);
			let suffix = ordinal;
			let name = (totals.get(base) ?? 0) > 1 ? `${base}:${ordinal}` : base;
			while (used.has(name)) name = `${base}:${++suffix}`;
			used.add(name);
			return { ...item, name };
		});
	}
	hasCommandOverride(name: string): boolean {
		return this.#extensionCommands().some((item) => item.name === name);
	}
	commands(): readonly CommandInfo[] {
		const catalog = new Map(commands.map((command) => [command.name, command]));
		for (const prompt of this.#resources.prompts)
			if (!catalog.has(prompt.name)) catalog.set(prompt.name, { name: prompt.name, description: prompt.description });
		for (const skill of this.#resources.skills)
			catalog.set(`skill:${skill.name}`, { name: `skill:${skill.name}`, description: skill.description });
		for (const { name, command } of this.#extensionCommands())
			catalog.set(name, {
				name,
				description: command.description,
				...(command.getArgumentCompletions ? { getArgumentCompletions: command.getArgumentCompletions } : {}),
			});
		return [...catalog.values()];
	}

	async #setSessionName(name: string): Promise<void> {
		await this.harness.commit(async (tx) => {
			(await tx.doc(SessionInfo)).name = name;
		}, this.context);
		await this.#readState();
		for (const { extension } of [...this.#lifetimes.values()]) {
			try {
				await extension.onSessionInfoChanged?.(this.#extensionContext(extension), { name });
			} catch (error) {
				this.#report(error, { type: "extension_error", extension: extension.name });
			}
		}
	}
	#commandContext(owner: ApplicationExtension): ExtensionCommandContext {
		const epoch = this.#epoch,
			revision = this.#commandEpoch;
		const context: ExtensionCommandContext = Object.assign(this.#extensionContext(owner), {
			getSystemPromptOptions: () => ({
				systemPrompt: this.#options.systemPrompt,
				appendSystemPrompt: this.#options.appendSystemPrompt,
			}),
			waitForIdle: () => this.conversation.waitForIdle(this.context),
			newSession: (options?: NewSessionOptions) => this.#sessionControl(owner, "/new", { kind: "new", options }),
			fork: (id: import("@arc/durable").EntryId, options?: ForkOptions) =>
				this.#sessionControl(owner, `/fork ${id}`, { kind: "fork", options }),
			navigateTree: (id: import("@arc/durable").EntryId, options?: NavigateTreeOptions) =>
				this.#sessionControl(owner, `/tree entry:${id}`, { kind: "tree", options }),
			switchSession: (path: string, options?: SessionReplacementOptions) =>
				this.#sessionControl(owner, `/resume ${path}`, { kind: "resume", options }),
			reload: () => this.reload(),
		});
		const assertCurrent = () => {
			this.#assertOpen();
			if (epoch !== this.#epoch || revision !== this.#commandEpoch || !this.#registry.owns(owner))
				throw new Error("Extension command context is stale; use the replacement context supplied to withSession");
		};
		return new Proxy(context, {
			get(target, key, receiver) {
				assertCurrent();
				const value: unknown = Reflect.get(target, key, receiver);
				return typeof value === "function"
					? (...args: unknown[]) => {
							assertCurrent();
							return Reflect.apply(value, target, args);
						}
					: value;
			},
		});
	}
	async #sessionControl(owner: ApplicationExtension, input: string, control: SessionControl): Promise<CommandResult> {
		const result = await this.#admit(() => this.#command(input, control));
		if (!result.cancelled && control.kind !== "tree") await control.options?.withSession?.(this.#commandContext(owner));
		return result;
	}
	async #releaseExtensionResources(owner: ApplicationExtension): Promise<void> {
		owner = this.#registry.owner(owner);
		this.#registry.clear(owner);
		this.#virtualModels.remove(owner);
		const providerErrors: unknown[] = [];
		if (mutableModels(this.#baseModels))
			for (const id of this.#providerOwners.get(owner) ?? []) {
				try {
					removeProviderContribution(this.#baseModels, owner, id);
				} catch (error) {
					providerErrors.push(error);
				}
			}
		this.#providerOwners.delete(owner);
		for (const stop of this.#extensionSubscriptions.get(owner) ?? []) stop();
		this.#extensionSubscriptions.delete(owner);
		const names = [...this.#mcpOwners].filter(([, extension]) => extension === owner).map(([name]) => name);
		const outcomes = await Promise.allSettled(
			names.map(async (name) => {
				this.#mcpOwners.delete(name);
				await this.#mcp.disconnect(name);
			}),
		);
		const errors = [...providerErrors, ...outcomes.flatMap((r) => (r.status === "rejected" ? [r.reason] : []))];
		if (errors.length) throw new AggregateError(errors, "Extension resource cleanup failed");
	}
	#amendExtension(owner: ApplicationExtension, change: (current: ApplicationExtension) => ApplicationExtension): void {
		this.#assertOpen();
		this.#registry.amend(owner, (current) => {
			const next = change(current);
			this.#validateExtension(next);
			return next;
		});
		this.#presentationRevision++;
		this.#scheduleRefresh();
	}

	async #mcpChanged(): Promise<void> {
		await this.#readState();
		const servers = this.#mcp.status();
		for (const { extension } of [...this.#lifetimes.values()]) {
			try {
				await extension.onMcpServersChange?.(this.#extensionContext(extension), { servers });
			} catch (error) {
				this.#report(error, { type: "extension_error", extension: extension.name });
			}
		}
	}

	#extensionContext(owner: ApplicationExtension): ExtensionContext {
		owner = this.#registry.owner(owner);
		const app = this;
		if (!this.#state) throw new Error("Application state is unavailable");
		return {
			on: (type, listener) => {
				const receive = async (context: ExtensionContext, event: AgentEvent) => {
					if (matchesRuntimeEvent(event, type)) await listener(context, event);
				};
				this.#amendExtension(owner, (current) => ({
					...current,
					runtimeEvents: [...(current.runtimeEvents ?? []), receive],
				}));
				return () => {
					if (!this.#closed && this.#registry.owns(owner))
						this.#amendExtension(owner, (current) => ({
							...current,
							runtimeEvents: current.runtimeEvents?.filter((value) => value !== receive),
						}));
				};
			},
			registerHook: (registration) => {
				this.#amendExtension(owner, (current) => ({ ...current, hooks: [...(current.hooks ?? []), registration] }));
				return () => {
					if (!this.#closed && this.#registry.owns(owner))
						this.#amendExtension(owner, (current) => ({
							...current,
							hooks: current.hooks?.filter((value) => value !== registration),
						}));
				};
			},
			registerTool: (tool) =>
				this.#amendExtension(owner, (current) => ({
					...current,
					tools: [...(current.tools ?? []).filter((value) => value.name !== tool.name), tool],
				})),
			registerCommand: (command) =>
				this.#amendExtension(owner, (current) => ({
					...current,
					commands: [...(current.commands ?? []).filter((value) => value.name !== command.name), command],
				})),
			registerFlag: (name, flag) => {
				this.#amendExtension(owner, (current) => {
					this.#parseFlags({ ...this.flags(), [name]: flag });
					return { ...current, flags: { ...current.flags, [name]: flag } };
				});
				this.#refreshFlagValues();
			},
			registerShortcut: (shortcut) =>
				this.#amendExtension(owner, (current) => ({
					...current,
					shortcuts: [...(current.shortcuts ?? []).filter((value) => value.key !== shortcut.key), shortcut],
				})),
			registerMessageRenderer: (name, renderer) =>
				this.#amendExtension(owner, (current) => ({
					...current,
					messageRenderers: { ...current.messageRenderers, [name]: renderer },
				})),
			registerEntryRenderer: (name, renderer) =>
				this.#amendExtension(owner, (current) => ({
					...current,
					entryRenderers: { ...current.entryRenderers, [name]: renderer },
				})),
			registerToolRenderer: (name, renderer) =>
				this.#amendExtension(owner, (current) => ({
					...current,
					toolRenderers: { ...current.toolRenderers, [name]: renderer },
				})),
			events: {
				emit: (channel, data) => {
					this.#extensionBus.emit(channel, data);
				},
				on: (channel, listener) => {
					this.#assertOpen();
					if (!this.#registry.owns(owner)) throw new Error("Extension is no longer loaded");
					const receive = async (data: unknown) => {
						try {
							await listener(data);
						} catch (error) {
							this.#report(error, { type: "extension_error", extension: owner.name });
						}
					};
					this.#extensionBus.on(channel, receive);
					let subscriptions = this.#extensionSubscriptions.get(owner);
					if (!subscriptions) {
						subscriptions = new Set();
						this.#extensionSubscriptions.set(owner, subscriptions);
					}
					const stop = () => {
						this.#extensionBus.off(channel, receive);
						subscriptions.delete(stop);
					};
					subscriptions.add(stop);
					return stop;
				},
			},

			getSystemPrompt: async () => {
				const conversation = app.conversation,
					harness = app.harness;
				const agent = await conversation.agent(app.context),
					view = await conversation.context(app.context);
				const shown = replaySections(view.messages);
				let env: import("@arc/durable/env").ExecutionEnv | undefined;
				try {
					env = await app.#buildEnv(
						{ conversationId: conversation.id, cwd: agent.cwd ?? app.cwd, read: harness },
						app.context,
					);
				} catch (error) {
					if (app.context.abortSignal?.aborted) throw error;
					app.#report(error, { type: "listener_error" });
				}
				const sections = await renderSections(
					agent.sections,
					{ conversationId: conversation.id, agent, env, shown: Object.fromEntries(shown), read: harness },
					shown,
					(error) => app.#report(error, { type: "extension_error", extension: owner.name }),
					app.context,
				);
				return [...sections.values()].join("\n\n");
			},
			getContextUsage: async () => {
				const conversation = app.conversation,
					agent = await conversation.agent(app.context),
					ref = agent.model;
				let model = ref ? app.models.getModel(ref.provider, ref.modelId) : undefined;
				if (ref && app.#virtualModels.has(ref.provider, ref.modelId)) {
					const messages = (await conversation.context(app.context)).messages;
					for (let index = messages.length - 1; index >= 0; index--) {
						const message = messages[index];
						if (message?.role === "assistant" && message.stopReason !== "error" && message.stopReason !== "aborted") {
							model = app.models.getModel(message.provider, message.model) ?? model;
							break;
						}
					}
				}
				if (!model?.contextWindow || model.contextWindow <= 0) return;
				const view = await conversation.context(app.context);
				const head = view.head;
				if (
					head &&
					!view.entries.some(
						(entry) =>
							entry.id > head.id &&
							entry.model?.some(
								(message) =>
									message.role === "assistant" &&
									message.stopReason !== "error" &&
									message.stopReason !== "aborted" &&
									calculateContextTokens(message.usage) > 0,
							),
					)
				)
					return { tokens: null, contextWindow: model.contextWindow, percent: null };
				const tokens = estimateContextTokens(view.messages).tokens;
				return { tokens, contextWindow: model.contextWindow, percent: (tokens / model.contextWindow) * 100 };
			},
			getFlag: (name) => (Object.hasOwn(app.#flagValues, name) ? app.#flagValues[name] : undefined),
			cwd: this.cwd,
			get hasUI() {
				return app.ui.supported;
			},
			get model() {
				const ref = app.#state?.agent.model;
				return ref ? app.models.getModel(ref.provider, ref.modelId) : undefined;
			},
			get scopedModels() {
				return app.#enabledModels?.length ? resolveModelScope(app.#enabledModels, app.models.getModels()).models : [];
			},
			get thinkingLevel() {
				return app.#state?.agent.thinkingLevel ?? "off";
			},
			isIdle: () => !app.#state?.busy,
			isProjectTrusted: () => app.#projectTrusted,
			hasPendingMessages: () => Boolean(app.#state?.inbox.items.length),
			abort: () => app.abort(),
			compact: (instructions) => app.conversation.compact(instructions, app.context),
			getSessionName: () => app.#state?.sessionName || undefined,
			setSessionName: (name) => app.#setSessionName(name),
			getActiveTools: () => app.#state?.agent.tools.map((t) => t.name) ?? [],
			getAllTools: () =>
				app.#registry
					.snapshot()
					.tools()
					.map(({ tool }) => tool),
			setActiveTools: async (names) => {
				const available = app.#registry
					.snapshot()
					.tools()
					.map(({ tool }) => tool);
				await app.conversation.configure(
					{
						modelTools: available.filter((t) => names.includes(t.name) && (!t.callers || t.callers.includes("model"))),
					},
					app.context,
				);
				await app.#readState();
			},
			getCommands: () => app.commands(),
			getSettings: () => structuredClone(app.#settings),
			setModel: async (model) => {
				if (!app.models.getModel(model.provider, model.id)) return false;
				const auth = await app.models.checkAuth(model.provider);
				if (!auth) return false;
				await app.conversation.configure(
					{
						model: { provider: model.provider, modelId: model.id },
						thinkingLevel: clampThinkingLevel(model, app.#state?.agent.thinkingLevel ?? "off"),
					},
					app.context,
				);
				await app.#readState();
				return true;
			},
			getThinkingLevel: () => app.#state?.agent.thinkingLevel ?? "off",
			setThinkingLevel: async (level) => {
				const agent = await app.conversation.agent(app.context),
					ref = agent.model;
				const model = ref ? app.models.getModel(ref.provider, ref.modelId) : undefined;
				await app.conversation.configure(
					{ thinkingLevel: model ? clampThinkingLevel(model, level) : level },
					app.context,
				);
				await app.#readState();
			},

			sendMessage: async (message, options) => {
				const value = structuredClone(parseCustomMessage(message));
				const busy = Boolean((await app.harness.snapshot(LiveDoc, app.conversation.id, app.context))?.run);
				return sendCustomMessage(app.conversation, value, options, busy, app.harness, app.context);
			},
			appendEntry: (customType, data) => {
				if (typeof customType !== "string" || !customType) throw new Error("Custom entry type is required");
				if (data !== undefined && !isJsonValue(data)) throw new Error("Custom entry data must be JSON");
				return app.conversation.submit(
					{ type: "write", entry: { kind: ENTRY_KIND, data: { customType, ...(data === undefined ? {} : { data }) } } },
					app.context,
				);
			},
			sendUserMessage: async (input, options) => {
				const agent = await app.conversation.agent(app.context),
					ref = agent.model;
				const content = await prepareInput(
					parseInput(input),
					ref ? app.models.getModel(ref.provider, ref.modelId) : undefined,
					await app.#images,
				);
				await flushCustomMessages(app.conversation, app.harness, app.context);
				return app.conversation.submit(
					{ type: "input", content, whenBusy: options?.deliverAs ?? "followUp" },
					app.context,
				);
			},

			registerVirtualModel: (definition) => {
				app.#assertOpen();
				if (!app.#registry.owns(owner)) throw new Error("Extension is no longer loaded");
				app.#virtualModels.set(owner, definition);
			},
			unregisterVirtualModel: (provider, id) => app.#virtualModels.remove(owner, provider, id),
			registerProvider: (provider) => {
				app.#assertOpen();
				if (!app.#registry.owns(owner)) throw new Error("Extension is no longer loaded");
				if (!mutableModels(app.#baseModels)) throw new Error("Provider registration requires a mutable model registry");
				app.#validateExtension({ name: owner.name, providers: [provider] });
				setProviderContribution(app.#baseModels, owner, provider);
				let ids = app.#providerOwners.get(owner);
				if (!ids) {
					ids = new Set();
					app.#providerOwners.set(owner, ids);
				}
				ids.add(provider.id);
			},
			unregisterProvider: (id) => {
				if (!app.#providerOwners.get(owner)?.delete(id)) return;
				if (mutableModels(app.#baseModels)) removeProviderContribution(app.#baseModels, owner, id);
			},
			registerMcpServer: async (server) => {
				await app.#mcp.connect(server.transport === "stdio" ? { ...server, cwd: server.cwd ?? app.cwd } : server);
				if (!app.#registry.owns(owner)) {
					await app.#mcp.disconnect(server.name);
					throw new Error("Extension was unloaded while connecting MCP server");
				}
				app.#mcpOwners.set(server.name, owner);
			},
			unregisterMcpServer: async (name) => {
				if (app.#mcpOwners.get(name) !== owner) return;
				app.#mcpOwners.delete(name);
				await app.#mcp.disconnect(name);
			},
			getMcpServers: () => app.#mcp.status(),
			getLabel: (id) => app.getLabel(id),
			setLabel: (id, label) => app.setLabel(id, label),
			get mode() {
				return app.mode;
			},
			get state() {
				if (!app.#state) throw new Error("Application state is unavailable");
				return app.#state;
			},
			models: this.models,
			get harness() {
				return app.harness;
			},
			get conversation() {
				return app.conversation;
			},
			get ui() {
				return app.ui;
			},
		};
	}
	#queueExtensionWork(operation: () => Promise<void>): Promise<void> {
		const run = this.#extensionEvents.then(operation);
		this.#extensionEvents = run.catch(() => {});
		return run;
	}

	#event(
		kind: "onSessionStart" | "onSessionShutdown" | "onUIAttached" | "onUIDetached",
		reason: SessionReason,
	): Promise<void> {
		return this.#queueExtensionWork(async () => {
			for (const { extension } of this.#lifetimes.values()) {
				try {
					await extension[kind]?.(this.#extensionContext(extension), { reason });
				} catch (error) {
					this.#report(error, { type: "listener_error" });
					if (this.ui.supported)
						try {
							this.ui.notify(
								`Extension ${extension.name}: ${error instanceof Error ? error.message : String(error)}`,
								"error",
							);
						} catch {}
				}
			}
		});
	}
	async #syncLifetimes(): Promise<void> {
		return this.#queueExtensionWork(async () => {
			const desired = new Map(
				this.#registry.source
					.snapshot()
					.installed()
					.map((extension) => [extension.name, extension]),
			);
			const errors: unknown[] = [];
			for (const [name, lifetime] of [...this.#lifetimes].reverse())
				if (desired.get(name) !== lifetime.extension) {
					this.#lifetimes.delete(name);
					try {
						try {
							await lifetime.cleanup?.();
						} finally {
							await this.#releaseExtensionResources(lifetime.extension);
						}
					} catch (error) {
						errors.push(error);
					}
				}
			for (const [name, extension] of desired) {
				const definition: ApplicationExtension = extension;
				if (this.#lifetimes.has(name)) continue;
				try {
					const cleanup = await definition.activate?.(this.#extensionContext(definition));
					if (cleanup !== undefined && typeof cleanup !== "function") throw new Error(`Invalid cleanup from ${name}`);
					this.#lifetimes.set(name, { extension: definition, ...(cleanup ? { cleanup } : {}) });
				} catch (error) {
					errors.push(error);
					try {
						await this.#releaseExtensionResources(definition);
					} catch (cleanupError) {
						errors.push(cleanupError);
					}
				}
			}
			if (errors.length) throw new AggregateError(errors, "Extension activation or cleanup failed");
		});
	}
	async #closeLifetimes(): Promise<void> {
		return this.#queueExtensionWork(async () => {
			const errors: unknown[] = [];
			for (const [name, lifetime] of [...this.#lifetimes].reverse()) {
				this.#lifetimes.delete(name);
				try {
					try {
						await lifetime.cleanup?.();
					} finally {
						await this.#releaseExtensionResources(lifetime.extension);
					}
				} catch (error) {
					errors.push(error);
				}
			}
			if (errors.length) throw new AggregateError(errors, "Extension cleanup failed");
		});
	}

	flags(): Readonly<Record<string, import("./types.ts").ExtensionFlag>> {
		return Object.fromEntries(
			this.#registry
				.snapshot()
				.installed()
				.flatMap((extension: ApplicationExtension) => Object.entries(extension.flags ?? {})),
		);
	}
	#refreshFlagValues(strict = false): void {
		this.#flagValues = this.#parseFlags(this.flags(), strict);
	}
	#parseFlags(flags: Readonly<Record<string, import("./types.ts").ExtensionFlag>>, strict = false) {
		const values = parseArgs({
			args: [...(this.#options.extensionArgs ?? [])],
			strict,
			allowPositionals: true,
			options: { ...BUILTIN_FLAGS, ...flags },
		}).values;
		const supplied = new Map(Object.entries(values));
		return Object.fromEntries(
			Object.keys(flags).map((name) => {
				const value = supplied.get(name);
				return [name, typeof value === "string" || typeof value === "boolean" ? value : undefined];
			}),
		);
	}

	shortcuts(): readonly {
		readonly key: import("@arc/tui").KeyId;
		readonly description?: string;
		execute(): Promise<void>;
	}[] {
		const result = new Map<
			import("@arc/tui").KeyId,
			{ key: import("@arc/tui").KeyId; description?: string; execute(): Promise<void> }
		>();
		for (const extension of this.#registry.snapshot().installed()) {
			const definition: ApplicationExtension = extension;
			for (const shortcut of definition.shortcuts ?? [])
				result.set(shortcut.key, {
					key: shortcut.key,
					description: shortcut.description,
					execute: async () => {
						this.#assertOpen();
						await shortcut.execute(this.#extensionContext(extension));
					},
				});
		}
		return [...result.values()];
	}
	messageRenderer(name: string): import("./ui/tool-renderers.ts").MessageRenderer | undefined {
		for (const extension of this.#registry.snapshot().installed()) {
			const definition: ApplicationExtension = extension;
			const renderers = definition.messageRenderers;
			if (renderers && Object.hasOwn(renderers, name)) return renderers[name];
		}
	}
	entryRenderer(name: string): import("./ui/tool-renderers.ts").EntryRenderer | undefined {
		for (const extension of this.#registry.snapshot().installed()) {
			const definition: ApplicationExtension = extension;
			const renderers = definition.entryRenderers;
			if (renderers && Object.hasOwn(renderers, name)) return renderers[name];
		}
	}

	markdownTransformers(): readonly import("./ui/tool-renderers.ts").MarkdownTransformer[] {
		return this.#registry
			.snapshot()
			.installed()
			.flatMap((extension: ApplicationExtension) =>
				extension.markdownTransformer ? [extension.markdownTransformer] : [],
			);
	}
	toolRenderers(
		name: string,
		base: () => import("./ui/tool-renderers.ts").ToolRenderers | undefined = () => undefined,
	): import("./ui/tool-renderers.ts").ToolRenderers | undefined {
		const extensions: readonly ApplicationExtension[] = this.#registry.snapshot().installed();
		const resolvers = extensions.flatMap((e) => e.toolRendererResolvers ?? []);
		const registered = () => {
			for (let i = extensions.length - 1; i >= 0; i--) {
				const renderers = extensions[i]?.toolRenderers;
				if (renderers && Object.hasOwn(renderers, name)) {
					const fallback = base();
					return fallback ? { ...fallback, ...renderers[name] } : renderers[name];
				}
			}
			return base();
		};
		const resolve = (i: number): import("./ui/tool-renderers.ts").ToolRenderers | undefined => {
			const resolver = resolvers[i];
			return resolver ? resolver(name, () => resolve(i + 1)) : registered();
		};
		return resolve(0);
	}

	#validateExtension(extension: ApplicationExtension): void {
		if (
			extension.runtimeEvents !== undefined &&
			(!Array.isArray(extension.runtimeEvents) ||
				extension.runtimeEvents.some((listener) => typeof listener !== "function"))
		)
			throw new Error("Invalid runtime event listeners");
		if (extension.virtualModels !== undefined && !Array.isArray(extension.virtualModels))
			throw new Error("Invalid virtual model definitions");
		for (const model of extension.virtualModels ?? []) {
			this.#virtualModels.validate(model);
			if (
				extension.providers?.some(
					(provider) =>
						provider.id === model.provider && provider.getModels().some((physical) => physical.id === model.id),
				)
			)
				throw new Error("Virtual model conflicts with a physical model");
		}
		for (const renderers of [extension.messageRenderers, extension.entryRenderers])
			if (
				renderers !== undefined &&
				(!renderers ||
					typeof renderers !== "object" ||
					Array.isArray(renderers) ||
					Object.values(renderers).some((r) => typeof r !== "function"))
			)
				throw new Error("Invalid custom renderers");
		if (extension.flags !== undefined) {
			if (!extension.flags || typeof extension.flags !== "object" || Array.isArray(extension.flags))
				throw new Error("Invalid extension flags");
			for (const [name, flag] of Object.entries(extension.flags)) {
				if (!/^[a-z][a-z0-9-]*$/.test(name) || Object.hasOwn(BUILTIN_FLAGS, name))
					throw new Error(`Reserved or invalid extension flag: ${name}`);
				if (
					!flag ||
					(flag.type !== "string" && flag.type !== "boolean") ||
					(flag.default !== undefined && typeof flag.default !== flag.type)
				)
					throw new Error(`Invalid extension flag: ${name}`);
			}
		}
		if (extension.markdownTransformer !== undefined && typeof extension.markdownTransformer !== "function")
			throw new Error("Invalid Markdown transformer");
		if (
			extension.toolRendererResolvers !== undefined &&
			(!Array.isArray(extension.toolRendererResolvers) ||
				extension.toolRendererResolvers.some((r) => typeof r !== "function"))
		)
			throw new Error("Invalid tool renderer resolvers");
		if (
			extension.shortcuts !== undefined &&
			(!Array.isArray(extension.shortcuts) ||
				extension.shortcuts.some((s) => !s || typeof s.key !== "string" || typeof s.execute !== "function"))
		)
			throw new Error("Invalid extension shortcuts");
		for (const method of applicationHooks)
			if (extension[method] !== undefined && typeof extension[method] !== "function")
				throw new Error(`Invalid extension ${method}`);
		if (extension.toolRenderers !== undefined) {
			if (
				typeof extension.toolRenderers !== "object" ||
				extension.toolRenderers === null ||
				Array.isArray(extension.toolRenderers)
			)
				throw new Error("Invalid tool renderers");
			for (const renderer of Object.values(extension.toolRenderers)) {
				if (
					!renderer ||
					typeof renderer !== "object" ||
					(renderer.renderShell !== undefined &&
						renderer.renderShell !== "default" &&
						renderer.renderShell !== "self") ||
					(renderer.renderCall !== undefined && typeof renderer.renderCall !== "function") ||
					(renderer.renderResult !== undefined && typeof renderer.renderResult !== "function")
				)
					throw new Error("Invalid tool renderer");
			}
		}
		if (extension.providers !== undefined) {
			if (!Array.isArray(extension.providers) || !mutableModels(this.#baseModels))
				throw new Error("Provider extensions require a mutable model registry");
			const names = new Set<string>();
			for (const provider of extension.providers) {
				if (
					!provider ||
					typeof provider.id !== "string" ||
					!provider.id ||
					typeof provider.name !== "string" ||
					typeof provider.getModels !== "function" ||
					typeof provider.stream !== "function" ||
					typeof provider.streamSimple !== "function" ||
					typeof provider.auth !== "object"
				)
					throw new Error("Invalid extension provider");
				if (names.has(provider.id)) throw new Error(`Duplicate provider: ${provider.id}`);
				names.add(provider.id);
				for (const other of this.#registry.snapshot().installed())
					if (other.name !== extension.name && this.#providersOf(other).some((p) => p.id === provider.id))
						throw new Error(`Provider already registered: ${provider.id}`);
			}
		}
		if (extension.commands !== undefined) {
			if (!Array.isArray(extension.commands)) throw new Error("Extension commands must be an array");
			const names = new Set<string>();
			for (const command of extension.commands) {
				if (
					!command ||
					typeof command.name !== "string" ||
					!/^[-a-zA-Z0-9_:]+$/.test(command.name) ||
					typeof command.description !== "string" ||
					typeof command.execute !== "function"
				)
					throw new Error("Invalid extension command");
				if (["abort", "quit"].includes(command.name) || names.has(command.name))
					throw new Error(`Command name is reserved or duplicated: ${command.name}`);

				names.add(command.name);
			}
		}
	}
	#providersOf(extension: ApplicationExtension) {
		return extension.providers ?? [];
	}

	#syncProviders(): void {
		const installed = this.#registry.source.snapshot().installed();
		this.#virtualModels.retain(new Set(installed));
		for (const extension of installed) {
			const definition: ApplicationExtension = extension;
			for (const model of definition.virtualModels ?? []) this.#virtualModels.set(extension, model);
		}
		const desired = new Map(
			this.#registry.source
				.snapshot()
				.installed()
				.flatMap((extension) => this.#providersOf(extension))
				.map((provider) => [provider.id, provider]),
		);
		if (!desired.size && !this.#providers.size) return;
		if (!mutableModels(this.#baseModels)) throw new Error("Provider extensions require a mutable model registry");
		for (const id of this.#providers.keys())
			if (!desired.has(id)) {
				removeProviderContribution(this.#baseModels, this, id);
				this.#providers.delete(id);
			}
		for (const [id, provider] of desired) {
			if (this.#providers.get(id) === provider) continue;
			setProviderContribution(this.#baseModels, this, provider);
			this.#providers.set(id, provider);
		}
	}
	#restoreProviders(): void {
		if (!mutableModels(this.#baseModels)) return;
		for (const id of this.#providers.keys()) removeProviderContribution(this.#baseModels, this, id);
		this.#providers.clear();
	}

	#commandsOf(extension: ApplicationExtension) {
		return extension.commands ?? [];
	}
	async #resolveTrust(): Promise<import("./types.ts").ProjectTrustDecision> {
		const context: import("./types.ts").ProjectTrustContext = {
			cwd: this.cwd,
			mode: this.mode,
			hasUI: this.#options.trustUI !== undefined,
			ui: this.#options.trustUI ?? createUnavailableUI(),
		};
		const validate = (value: unknown): import("./types.ts").ProjectTrustDecision => {
			if (
				!value ||
				typeof value !== "object" ||
				!("trusted" in value) ||
				(value.trusted !== "yes" && value.trusted !== "no" && value.trusted !== "undecided") ||
				("remember" in value && value.remember !== undefined && typeof value.remember !== "boolean")
			)
				throw new Error("Invalid project trust decision");
			return {
				trusted: value.trusted,
				...("remember" in value && typeof value.remember === "boolean" ? { remember: value.remember } : {}),
			};
		};
		for (const extension of this.#registry.snapshot().installed()) {
			const definition: ApplicationExtension = extension;
			try {
				const result = await definition.onProjectTrust?.(context);
				if (result === undefined) continue;
				const decision = validate(result);
				if (decision.trusted !== "undecided") return decision;
			} catch (error) {
				this.#report(error, { type: "extension_error", extension: extension.name });
			}
		}
		return this.#options.resolveProjectTrust
			? validate(await this.#options.resolveProjectTrust(context))
			: { trusted: "undecided" };
	}

	async #loadFiles(resources: Resources, skipLoaded = false): Promise<void> {
		const files = new Set(
			[
				...(this.#options.disableDiscoveredExtensions ? [] : resources.extensionFiles),
				...this.#settings.extensionFiles,
				...(this.#options.extensionFiles ?? []),
			].map((file) => resolve(this.cwd, file)),
		);
		for (const file of files) {
			if (skipLoaded && this.#files.has(file)) continue;
			await this.#loader.load(file);
			this.#files.add(file);
			this.#syncProviders();
		}
		for (const file of this.#files)
			if (!files.has(file)) {
				await this.#loader.unload(file);
				this.#files.delete(file);
				this.#syncProviders();
			}
	}
	async #discoverResources(base: Resources, reason: "startup" | "reload"): Promise<void> {
		const skillPaths: string[] = [],
			promptPaths: string[] = [],
			themePaths: string[] = [];
		for (const { extension } of [...this.#lifetimes.values()]) {
			try {
				const result = await extension.onResourcesDiscover?.(this.#extensionContext(extension), {
					cwd: this.cwd,
					reason,
				});
				if (result === undefined) continue;
				if (!result || typeof result !== "object" || Array.isArray(result))
					throw new Error("Invalid discovered resource result");
				for (const paths of [result.skillPaths, result.promptPaths, result.themePaths])
					if (paths !== undefined && (!Array.isArray(paths) || paths.some((path) => typeof path !== "string" || !path)))
						throw new Error("Invalid discovered resource paths");
				skillPaths.push(...(result.skillPaths ?? []));
				promptPaths.push(...(result.promptPaths ?? []));
				themePaths.push(...(result.themePaths ?? []));
			} catch (error) {
				this.#report(error, { type: "extension_error", extension: extension.name });
			}
		}
		if (!skillPaths.length && !promptPaths.length && !themePaths.length && !this.#discoveredThemePaths.length) return;
		const additional = await loadResourcePaths(
			skillPaths.map((path) => resolve(this.cwd, path)),
			promptPaths.map((path) => resolve(this.cwd, path)),
		);
		const previous = this.#discoveredThemePaths;
		this.#discoveredThemePaths = themePaths.map((path) => resolve(this.cwd, path));
		try {
			await this.themes.reload(this.#themePaths());
		} catch (error) {
			this.#discoveredThemePaths = previous;
			throw error;
		}
		const unique = <T extends { readonly name: string }>(items: readonly T[]): T[] => {
			const byName = new Map<string, T>();
			for (const item of items) if (!byName.has(item.name)) byName.set(item.name, item);
			return [...byName.values()];
		};
		const resources = {
			...base,
			skills: unique([...base.skills, ...additional.skills]),
			prompts: unique([...base.prompts, ...additional.prompts]),
		};
		this.#registry.install(createPromptExtension(resources, this.cwd, this.#options));
		this.#resources = resources;
		this.#presentationRevision++;
		await this.#readState();
	}

	#themePaths(): string[] {
		return [
			join(this.#home, "themes"),
			...(this.#projectTrusted ? [join(this.cwd, ".arc", "themes")] : []),
			...this.#settings.resourcePaths.map((path) => join(path, "themes")),
			...(this.#settings.themes ?? []),
			...this.#discoveredThemePaths,
		];
	}
	async reload(): Promise<void> {
		this.#assertOpen();
		this.#commandEpoch++;
		await this.themes.reload(this.#themePaths());
		const resources =
			this.#options.resources ??
			(await loadResources({
				cwd: this.cwd,
				home: this.#home,
				paths: this.#settings.resourcePaths,
				projectTrusted: this.#projectTrusted,
			}));
		await this.#event("onSessionShutdown", "reload");
		const errors: unknown[] = [];
		try {
			await this.#loadFiles(resources);
			this.#refreshFlagValues();
			this.#registry.install(createPromptExtension(resources, this.cwd, this.#options));
			this.#resources = resources;
		} catch (error) {
			errors.push(error);
		}
		try {
			await this.#syncLifetimes();
		} catch (error) {
			errors.push(error);
		}
		this.#presentationRevision++;
		try {
			await this.#readState();
			await this.#event("onSessionStart", "reload");
			await this.#discoverResources(resources, "reload");
		} catch (error) {
			errors.push(error);
		}
		if (errors.length === 1) throw errors[0];
		if (errors.length > 1) throw new AggregateError(errors, "Resource reload failed");
	}

	async #duringTransition(operation: () => Promise<void>): Promise<void> {
		await this.#transition;
		this.#assertOpen();
		const transition = operation();
		this.#transition = transition;
		try {
			await transition;
		} finally {
			if (this.#transition === transition) this.#transition = undefined;
		}
	}
	async #switch(conversation: Conversation, reason: SessionReason = "tree"): Promise<void> {
		if ((await this.snapshot()).busy) throw new Error("Abort current work before switching conversations");
		await this.#event("onSessionShutdown", reason);
		await this.#duringTransition(async () => {
			await this.harness.commit(async (tx) => {
				(await tx.doc(SessionInfo)).conversationId = conversation.id;
			}, this.context);
			this.#runtime.conversation = conversation;
			await this.#attach();
		});
		await this.#event("onSessionStart", reason);
	}
	async #switchFile(
		file: string | undefined,
		reason: SessionReason = "resume",
		prepare?: (runtime: Runtime) => Promise<void>,
	): Promise<void> {
		if ((await this.snapshot()).busy) throw new Error("Abort current work before switching sessions");
		await this.#duringTransition(async () => {
			const next = await this.#openRuntime(file, undefined, prepare ? "clone" : "startup");
			const abandon = async () => {
				try {
					await next.harness.close(this.context);
				} finally {
					await next.release();
				}
			};
			try {
				await prepare?.(next);
			} catch (error) {
				await abandon();
				throw error;
			}
			if (this.#closed) {
				await abandon();
				throw new Error("Application is closed");
			}
			const old = this.#runtime;
			await this.#event("onSessionShutdown", reason);
			this.#epoch++;
			await this.#view?.stop();
			this.#view = undefined;
			this.#state = undefined;
			try {
				await old.harness.close(this.context);
			} catch (error) {
				this.#report(error, { type: "session_failed" });
			} finally {
				await old.release();
			}
			if (this.#closed) {
				await abandon();
				throw new Error("Application is closed");
			}
			this.#runtime = next;
			try {
				await this.#attach();
			} catch (error) {
				this.#opened = undefined;
				await abandon();
				throw error;
			}
		});
		await this.#event("onSessionStart", reason);
		this.harness.resume();
	}

	async command(input: string): Promise<CommandResult> {
		this.#assertOpen();
		const match = /^\/?([^\s]+)(?:\s+([\s\S]*))?$/.exec(input.trim());
		const name = match?.[1],
			args = match?.[2] ?? "";
		if (name === "abort") return this.abort().then(() => ({ message: "Abort requested" }));
		if (name === "quit") return Promise.resolve({ quit: true });
		const contributed = this.#extensionCommands().find((command) => command.name === name);
		if (contributed)
			return (
				(await this.#beforeCommand(name ?? "", args)) ??
				contributed.command.execute(args, this, this.#commandContext(contributed.extension))
			);
		return this.#admit(() => this.#command(input));
	}

	async #beforeCommand(name: string, args: string): Promise<CommandResult | undefined> {
		for (const { extension } of [...this.#lifetimes.values()]) {
			const decision: unknown = await extension.beforeCommand?.(this.#extensionContext(extension), { name, args });
			if (decision === undefined) continue;
			if (
				!decision ||
				typeof decision !== "object" ||
				!("action" in decision) ||
				(decision.action !== "continue" && decision.action !== "cancel")
			)
				throw new Error(`Extension ${extension.name} returned an invalid command decision`);
			if (decision.action === "cancel") {
				if ("message" in decision && decision.message !== undefined && typeof decision.message !== "string")
					throw new Error(`Extension ${extension.name} returned an invalid cancellation message`);
				return {
					cancelled: true,
					...("message" in decision && typeof decision.message === "string" ? { message: decision.message } : {}),
				};
			}
		}
		return undefined;
	}
	async #sessionCancelled(
		check: (
			extension: ApplicationExtension,
			context: ExtensionContext,
		) => void | SessionDecision | Promise<void | SessionDecision>,
	): Promise<boolean> {
		for (const { extension } of [...this.#lifetimes.values()]) {
			const result: unknown = await check(extension, this.#extensionContext(extension));
			if (result === undefined) continue;
			if (
				!result ||
				typeof result !== "object" ||
				("cancel" in result && result.cancel !== undefined && typeof result.cancel !== "boolean")
			)
				throw new Error("Invalid session hook result");
			if ("cancel" in result && result.cancel === true) return true;
		}
		return false;
	}

	async #command(input: string, control?: SessionControl): Promise<CommandResult> {
		this.#assertOpen();
		const match = /^\/?([^\s]+)(?:\s+([\s\S]*))?$/.exec(input.trim());
		if (!match) return {};
		const name = match[1]!,
			args = match[2] ?? "";
		const intercepted = await this.#beforeCommand(name, args);
		if (intercepted) return intercepted;

		const template = !control && this.#resources.prompts.find((p) => p.name === name);
		if (template) return { editorText: expandPrompt(template.content, args) };
		const skill =
			!control && name.startsWith("skill:") ? this.#resources.skills.find((s) => s.name === name.slice(6)) : undefined;
		if (skill) return { editorText: promptForSkill(skill, args) };
		switch (name) {
			case "copy": {
				const text = assistantText(await this.#entries());
				if (!text) throw new Error("No assistant reply to copy");
				await this.ui.copyText(text);
				return { message: "Copied the last assistant reply" };
			}
			case "help":
				return {
					message: this.commands()
						.map((c) => `/${c.name}  ${c.description}`)
						.join("\n"),
				};
			case "quit":
				return { quit: true };
			case "hotkeys":
				return {
					message:
						"Enter send; Shift+Enter newline; Escape abort; Ctrl+C abort or clear; Ctrl+D quit; Ctrl+O expand tools; Ctrl+T show thinking",
				};
			case "abort":
				await this.abort();
				return { message: "Abort requested" };
			case "reload":
				await this.reload();
				return { message: "Resources reloaded" };
			case "settings": {
				if (args) {
					const [key, ...values] = args.split(/\s+/);
					const value = values.join(" ");
					if (
						(key === "showHardwareCursor" || key === "clearOnShrink" || key === "showTerminalProgress") &&
						(value === "true" || value === "false")
					) {
						await saveSettings(this.#home, { [key]: value === "true" });
						this.#settings = { ...this.#settings, [key]: value === "true" };
					} else if ((key === "editorPaddingX" || key === "autocompleteMaxVisible") && /^\d+$/.test(value)) {
						const number = Number(value);
						await saveSettings(this.#home, { [key]: number });
						this.#settings = { ...this.#settings, [key]: number };
					} else if (key === "codemode" && (value === "true" || value === "false")) {
						if ((await this.snapshot()).busy)
							throw new Error("Wait for current work to finish before changing Code Mode");
						const enabled = value === "true";
						await saveSettings(this.#home, { codemode: enabled });
						if (enabled && !this.#codemode) {
							this.#sandbox ??= new CodemodeSandbox();
							this.#codemode = createCodemodeExtension({ sandbox: this.#sandbox, models: true });
							this.#registry.install(this.#codemode);
						} else if (!enabled && this.#codemode) {
							this.#registry.uninstall(this.#codemode);
							this.#codemode = undefined;
						}
						this.#settings = { ...this.#settings, codemode: enabled };
					} else if (key === "retry" && (value === "true" || value === "false")) {
						const retry = { ...this.#settings.retry, enabled: value === "true" };
						await saveSettings(this.#home, { retry });
						this.#settings = { ...this.#settings, retry };
					} else if (key === "branchSummarySkipPrompt" && (value === "true" || value === "false")) {
						await saveSettings(this.#home, { branchSummarySkipPrompt: value === "true" });
						this.#settings = { ...this.#settings, branchSummarySkipPrompt: value === "true" };
					} else if (
						key === "treeFilterMode" &&
						(value === "default" ||
							value === "no-tools" ||
							value === "user-only" ||
							value === "labeled-only" ||
							value === "all")
					) {
						await saveSettings(this.#home, { treeFilterMode: value });
						this.#settings = { ...this.#settings, treeFilterMode: value };
					} else if (key === "cacheWarming" && (value === "off" || value === "streaming" || value === "idle")) {
						await saveSettings(this.#home, { cacheWarming: value });
						this.#settings = { ...this.#settings, cacheWarming: value };
						this.#cacheWarmer.modeChanged();
					} else if (key === "theme" && value) {
						const pair = value.split("/");
						if (pair.length > 2 || pair.some((name) => !this.themes.get(name)))
							throw new Error(`Unknown theme selection: ${value}`);
						await saveSettings(this.#home, { theme: value });
						this.#settings = { ...this.#settings, theme: value };
					} else if (key === "mermaid" && (value === "off" || value === "final" || value === "streaming")) {
						const markdown: ApplicationSettings["markdown"] = { ...this.#settings.markdown, mermaid: value };
						await saveSettings(this.#home, { markdown });
						this.#settings = { ...this.#settings, markdown };
					} else if (key === "toolExecution" && (value === "parallel" || value === "sequential")) {
						await saveSettings(this.#home, { toolExecution: value });
						this.#settings = { ...this.#settings, toolExecution: value };
					} else if (key === "fullscreen" && (value === "true" || value === "false")) {
						await saveSettings(this.#home, { fullscreen: value === "true" });
						this.#settings = { ...this.#settings, fullscreen: value === "true" };
						this.#fullscreenRevision++;
					} else if (
						(key === "steeringMode" || key === "followUpMode") &&
						(value === "all" || value === "one-at-a-time")
					) {
						await saveSettings(this.#home, { [key]: value });
						this.#settings = { ...this.#settings, [key]: value };
					} else if (key === "autoCompact" && (value === "true" || value === "false")) {
						const compaction = { ...this.#settings.compaction, enabled: value === "true" };
						await saveSettings(this.#home, { compaction });
						this.#settings = { ...this.#settings, compaction };
					} else
						throw new Error(
							"Settings accepts: codemode, retry, branchSummarySkipPrompt, fullscreen or autoCompact true|false; treeFilterMode default|no-tools|user-only|labeled-only|all; theme <name>; cacheWarming off|streaming|idle; mermaid off|final|streaming; toolExecution parallel|sequential; steeringMode or followUpMode all|one-at-a-time",
						);
					await this.#readState();
				}
				return {
					message: JSON.stringify(
						{
							...this.#settings,
							mcpServers: this.#settings.mcpServers.map((server) => ({
								name: server.name,
								transport: server.transport,
							})),
						},
						null,
						2,
					),
				};
			}
			case "trust": {
				const decision =
					args ||
					(this.ui.supported
						? await this.ui.select(`Project trust: ${this.cwd}`, [
								{ value: "yes", label: "Trust this project" },
								{ value: "parent", label: `Trust parent folder ${dirname(this.cwd)}` },
								{ value: "no", label: "Do not trust" },
							])
						: undefined);
				if (!decision)
					return {
						message: `Project resources are ${this.#projectTrusted ? "trusted" : "untrusted"}. Use /trust yes|no|parent to save a decision.`,
					};
				if (!["yes", "no", "parent"].includes(decision)) throw new Error("Usage: /trust yes|no|parent");
				await saveProjectTrust(this.#home, this.cwd, decision !== "no", decision === "parent");
				return { message: "Saved project trust. Restart Arc to apply it." };
			}
			case "mcp": {
				let [action, name, extra] = args.split(/\s+/);
				if (!action && this.ui.supported && this.#settings.mcpServers.length) {
					const selection = await this.ui.select(
						"MCP servers",
						this.#settings.mcpServers.map((server) => ({
							value: server.name,
							label: server.name,
							description: this.#mcp.status().some((item) => item.name === server.name) ? "Connected" : "Disconnected",
						})),
					);
					if (!selection) return {};
					name = selection;
					action =
						(await this.ui.select(`MCP ${name}`, [
							{ value: "connect", label: "Connect" },
							{ value: "disconnect", label: "Disconnect" },
							{ value: "login", label: "Log in with OAuth" },
							{ value: "logout", label: "Log out and remove saved OAuth" },
						])) ?? "";
					if (!action) return {};
				}
				if (action) {
					if (!name || extra || !["connect", "disconnect", "login", "logout"].includes(action))
						throw new Error("Usage: /mcp [connect|disconnect|login|logout <server-name>]");
					const server = this.#settings.mcpServers.find((server) => server.name === name);
					if (!server) throw new Error(`No configured MCP server named ${name}`);
					if (action === "logout") {
						await this.#mcp.disconnect(name);
						await logoutMcp(this.#home, server);
					} else if (action === "disconnect") await this.#mcp.disconnect(name);
					else {
						if (action === "login") {
							const authentication = new AbortController();
							this.#commandAbort = authentication;
							try {
								await loginMcp(this.#home, server, this.ui, authentication.signal);
							} finally {
								this.#commandAbort = undefined;
							}
							await this.#mcp.disconnect(name);
						}
						await this.#mcp.connect(server.transport === "stdio" ? { ...server, cwd: server.cwd ?? this.cwd } : server);
					}
					await this.#readState();
				}
				const servers = this.#mcp.status();
				return {
					message: servers.length
						? [
								"MCP servers",
								...servers.map((server) => `${server.name} · connected · ${server.tools} tools`),
								"Use /mcp connect|disconnect|login|logout <name>.",
							].join("\n")
						: `No MCP servers connected.\nConfigure mcpServers in ${join(this.home, "settings.json")}, then use /mcp connect <name> or /mcp login <name>.\nMCP works independently of Code Mode.`,
				};
			}
			case "login": {
				if (!this.ui.supported) return { message: `Run arc login${args ? ` ${args}` : ""} in a terminal.` };
				const providers = this.models
					.getProviders()
					.filter((provider) => provider.auth.oauth || provider.auth.apiKey?.login);
				if (!providers.length) return { message: "No provider login methods are available." };
				const exact = args
					? providers.find(
							(provider) =>
								provider.id.toLowerCase() === args.toLowerCase() || provider.name.toLowerCase() === args.toLowerCase(),
						)
					: undefined;
				const provider =
					exact?.id ??
					(await this.ui.select(
						"Sign in",
						providers.map((provider) => ({ value: provider.id, label: provider.name })),
						{ initialSearch: args },
					));
				if (!provider) return {};
				const authentication = new AbortController();
				this.#commandAbort = authentication;
				try {
					const refreshed = await loginWithUI(this.models, this.ui, provider, authentication.signal);
					if (refreshed.aborted) return { message: `Signed in to ${provider}. Model refresh was cancelled.` };
					const available = await this.models.getAvailable(provider, { signal: authentication.signal });
					if (available.length) {
						const selected = await this.ui.select(
							"Select model",
							available.map((model) => ({
								value: `${model.provider}/${model.id}`,
								label: `${model.provider}/${model.id}`,
								description: model.name,
							})),
							{ signal: authentication.signal },
						);
						if (selected !== undefined) {
							await this.#command(`/model ${selected}`, control);
							const model = (await this.conversation.agent(this.context)).model;
							await saveSettings(this.#home, { model });
							this.#settings = { ...this.#settings, model };
						}
					}
					await this.#readState();
					return {
						message: `Signed in to ${provider}${refreshed.errors.size ? ". Model refresh failed; cached models remain available." : ""}`,
					};
				} finally {
					this.#commandAbort = undefined;
				}
			}
			case "logout": {
				let provider = args;
				if (!provider) {
					if (!this.ui.supported) throw new Error("Usage: /logout <provider>");
					const credentials = await new FileCredentialStore(join(this.#home, "auth.json")).list();
					if (!credentials.length)
						return { message: "No stored credentials to remove. Environment credentials are unchanged." };
					provider =
						(await this.ui.select(
							"Sign out",
							credentials.map((credential) => ({
								value: credential.providerId,
								label: this.models.getProvider(credential.providerId)?.name ?? credential.providerId,
								description: credential.type === "oauth" ? "OAuth" : "Stored API key",
							})),
						)) ?? "";
					if (!provider) return {};
				}
				await logoutProvider(this.models, provider);
				return { message: `Logged out of ${provider}. Environment credentials are unchanged.` };
			}
			case "scoped-models": {
				if (!args) return { message: this.#enabledModels?.join("\n") ?? "All available models" };
				const persist = args === "save" || args.startsWith("save ");
				const value = persist ? args.slice(4).trim() : args;
				const ids =
					value === "all" ? undefined : value === "none" ? [] : value ? value.split(/[\s,]+/) : this.#enabledModels;
				const resolved = resolveModelScope(ids ?? [], this.models.getModels());
				if (resolved.unmatched.length) throw new Error(`Unknown model pattern: ${resolved.unmatched.join(", ")}`);
				const selected = ids ? [...new Set(ids)] : undefined;
				if (persist) await saveSettings(this.#home, { enabledModels: selected ?? [] });
				this.#enabledModels = selected;
				await this.#readState();
				return {
					message: [
						selected?.length ? `Models: ${selected.join(", ")}` : "Cycling uses all available models",
						...resolved.warnings,
					].join("\n"),
				};
			}
			case "model": {
				if (!args)
					return {
						message: this.models
							.getModels()
							.map((m) => `${m.provider}/${m.id}`)
							.join("\n"),
					};
				const slash = args.indexOf("/"),
					provider = args.slice(0, slash),
					id = args.slice(slash + 1);
				const model = slash > 0 ? this.models.getModel(provider, id) : undefined;
				if (!model) throw new Error(`Unknown model: ${args}`);
				const current = await this.conversation.agent(this.context);
				await this.conversation.configure(
					{
						model: { provider, modelId: id },
						thinkingLevel: clampThinkingLevel(
							model,
							this.#settings.modelThinkingLevels?.[`${provider}/${id}`] ??
								this.#settings.thinkingLevel ??
								current.thinkingLevel ??
								"off",
						),
					},
					this.context,
				);
				await this.#readState();
				return { message: `Model: ${provider}/${id}` };
			}
			case "thinking": {
				const persist = args.startsWith("save ");
				const requested = persist ? args.slice(5).trim() : args;
				const ref = (await this.conversation.agent(this.context)).model;
				const model = ref ? this.models.getModel(ref.provider, ref.modelId) : undefined;
				const levels: ModelThinkingLevel[] = model ? getSupportedThinkingLevels(model) : ["off"];
				const level = levels.find((level) => level === requested);
				if (!level) throw new Error(`Choose a thinking level: ${levels.join(", ")}`);
				if (persist) {
					if (!ref) throw new Error("Select a model before saving its thinking level");
					const modelThinkingLevels = {
						...this.#settings.modelThinkingLevels,
						[`${ref.provider}/${ref.modelId}`]: level,
					};
					await saveSettings(this.#home, { modelThinkingLevels: { [`${ref.provider}/${ref.modelId}`]: level } });
					this.#settings = { ...this.#settings, modelThinkingLevels };
				}
				await this.conversation.configure({ thinkingLevel: level }, this.context);
				await this.#readState();
				return { message: `Thinking: ${level}` };
			}
			case "tools": {
				const all = this.#registry
					.snapshot()
					.tools()
					.map(({ tool }) => tool);
				if (!args)
					return { message: (await this.conversation.agent(this.context)).tools.map((t) => t.name).join("\n") };
				const names = args === "none" ? [] : args.split(/[\s,]+/);
				const selected = names.map((name) => {
					const tool = all.find((t) => t.name === name);
					if (!tool) throw new Error(`Unknown tool: ${name}`);
					return tool;
				});
				await this.conversation.configure({ tools: selected }, this.context);
				await this.#readState();
				return { message: `Tools: ${names.join(", ")}` };
			}
			case "compact": {
				const task = await this.conversation.compact(args || undefined, this.context);
				const settled = await this.harness.waitForTask(task, this.context);
				if (settled.state.outcome.status !== "completed") throw new Error("Compaction did not complete");
				return { message: "Context compacted" };
			}
			case "name":
				await this.#setSessionName(args);
				return { message: `Session name: ${args}` };
			case "session": {
				const info = await this.harness.snapshot(SessionInfo, this.context);
				return {
					message: JSON.stringify(
						{
							cacheWarming: this.#cacheWarmer.status,
							name: info?.name ?? "",
							file: this.#runtime.file,
							conversation: this.conversation.id,
							cwd: this.cwd,
							usage: await this.harness.usage(this.context),
						},
						null,
						2,
					),
				};
			}
			case "new": {
				const options = control?.kind === "new" ? control.options : undefined;
				const setup: import("@arc/durable").ConversationInit | undefined = options
					? async (tx, conversationId) => {
							if (options.parentSession) (await tx.doc(SessionInfo)).parentSession = options.parentSession;
							await options.setup?.(tx, conversationId);
						}
					: undefined;
				if (
					await this.#sessionCancelled((extension, context) =>
						extension.beforeSessionSwitch?.(context, { reason: "new" }),
					)
				)
					return { cancelled: true };
				if ((await this.snapshot()).busy) throw new Error("Abort current work before starting a new session");
				if (this.#options.storage || this.#options.backend === "memory")
					await this.#switch(
						await this.harness.createConversation(
							{
								ownership: { kind: "ownerless" },
								agent: { cwd: this.cwd, model: (await this.conversation.agent(this.context)).model },
								init: setup,
							},
							this.context,
						),
						"new",
					);
				else
					await this.#switchFile(
						await newSessionFile(this.#home, this.cwd, this.#options.backend ?? "sqlite"),
						"new",
						setup
							? async (runtime) => {
									await runtime.harness.commit((tx) => setup(tx, runtime.conversation.id), this.context);
								}
							: undefined,
					);
				return { message: "New session" };
			}
			case "resume": {
				let file = args;
				if (!file) {
					const sessions = await listSessions(this.#home, this.cwd);
					if (!this.ui.supported) return { message: sessions.map((session) => session.path).join("\n") };
					if (this.ui.sessions) {
						file =
							(await this.ui.sessions({
								current: this.#runtime.file,
								load: (scope) =>
									savedSessions(
										this.#home,
										this.cwd,
										scope,
										this.#runtime.file ? { path: this.#runtime.file, name: this.#state?.sessionName } : undefined,
									),
								remove: (path) => removeSavedSession(this.#home, path, this.#runtime.file),
								rename: async (path, name) => {
									if (this.#runtime.file && resolve(path) === resolve(this.#runtime.file))
										await this.#setSessionName(name.trim());
									else await renameSavedSession(this.#home, path, name);
								},
							})) ?? "";
					} else {
						file =
							(await this.ui.select(
								"Resume session",
								sessions.map((session) => ({
									value: session.path,
									label: session.path,
									description: new Date(session.modified).toISOString(),
								})),
							)) ?? "";
					}
					if (!file) return {};
				}
				const targetSessionFile = resolve(this.cwd, file);
				if (
					await this.#sessionCancelled((extension, context) =>
						extension.beforeSessionSwitch?.(context, { reason: "resume", targetSessionFile }),
					)
				)
					return { cancelled: true };
				await this.#switchFile(targetSessionFile);
				return { message: `Opened ${file}` };
			}
			case "tasks": {
				if (args && args !== "on" && args !== "off") throw new Error("Usage: /tasks [on|off]");
				this.#showTasks = args ? args === "on" : !this.#showTasks;
				await this.#attachTasks();
				await this.#readState();
				return { message: `Task panel ${this.#showTasks ? "shown" : "hidden"}` };
			}
			case "tree": {
				const options = control?.kind === "tree" ? control.options : undefined;
				const { conversations: records, entries } = await this.#navigation();
				let tree = sessionTree(
					records,
					entries,
					this.conversation.id,
					(await this.harness.snapshot(NavigationDoc, this.context))?.labels,
				);
				const request = /^(entry:\d+)\s+--summarize(?:\s+([\s\S]*))?$/.exec(args);
				let selected = request?.[1] ?? args;
				let summarize = options?.summarize ?? request !== null;
				let instructions = options?.customInstructions ?? request?.[2];
				if (!selected && this.ui.tree) {
					let initialValue = tree.find((item) => item.current)?.value;
					while (true) {
						const result = await this.ui.tree(tree, {
							initialValue,
							filter: this.#settings.treeFilterMode ?? "default",
						});
						if (result.filter !== (this.#settings.treeFilterMode ?? "default")) {
							await saveSettings(this.#home, { treeFilterMode: result.filter });
							this.#settings = { ...this.#settings, treeFilterMode: result.filter };
						}
						if (result.action === "cancel") return {};
						if (result.action === "select") {
							initialValue = result.value;
							if (
								!tree.find((item) => item.value === result.value)?.current &&
								!this.#settings.branchSummarySkipPrompt
							) {
								const choice = await this.ui.select("Summarize branch?", [
									{ value: "no", label: "No summary" },
									{ value: "yes", label: "Summarize" },
									{ value: "custom", label: "Summarize with custom prompt" },
								]);
								if (!choice) continue;
								summarize = choice !== "no";
								if (choice === "custom") {
									instructions = await this.ui.editor("Custom summarization instructions");
									if (instructions === undefined) continue;
								}
							}
							selected = result.value;
							break;
						}
						const target = tree.find((item) => item.value === result.value)?.target;
						if (target?.kind !== "entry") throw new Error("Choose an entry to label");
						await this.setLabel(target.entry.id, result.label);
						tree = sessionTree(
							records,
							entries,
							this.conversation.id,
							(await this.harness.snapshot(NavigationDoc, this.context))?.labels,
						);
						initialValue = result.value;
					}
				}
				if (!selected && this.ui.supported) {
					selected =
						(await this.ui.select("Session tree", tree, { initialValue: tree.find((item) => item.current)?.value })) ??
						"";
					if (!selected) return {};
				}
				if (!selected)
					return {
						message: records
							.map(
								(r) =>
									`${r.id}${r.parent ? ` <- ${r.parent.conversationId}` : ""}${r.id === this.conversation.id ? " *" : ""}`,
							)
							.join("\n"),
					};
				if (selected.startsWith("entry:")) {
					const target = tree.find((item) => item.value === selected)?.target;
					if (!target || target.kind !== "entry") throw new Error(`Unknown entry: ${selected.slice(6)}`);
					const current = await this.#entries();
					if (current.at(-1)?.id === target.entry.id) return { message: "Already at this point" };
					if ((await this.snapshot()).busy) throw new Error("Abort current work before navigating the tree");
					const preparation = abandonedBranch(tree, current, target.entry.id);
					const controller = new AbortController();
					this.#commandAbort = controller;
					let branchSummary: string | undefined;
					let branchDetails: { readFiles: string[]; modifiedFiles: string[]; fromHook: boolean } = {
						readFiles: [],
						modifiedFiles: [],
						fromHook: false,
					};
					try {
						for (const { extension } of [...this.#lifetimes.values()]) {
							const decision: unknown = await extension.beforeTree?.(this.#extensionContext(extension), {
								targetId: target.entry.id,
								oldLeafId: current.at(-1)?.id,
								...preparation,
								userWantsSummary: summarize,
								signal: controller.signal,
							});
							if (decision === undefined) continue;
							if (
								!decision ||
								typeof decision !== "object" ||
								("cancel" in decision && decision.cancel !== undefined && typeof decision.cancel !== "boolean")
							)
								throw new Error("Invalid tree hook result");
							if ("cancel" in decision && decision.cancel === true) return { cancelled: true };
							if ("summary" in decision && decision.summary !== undefined) {
								if (typeof decision.summary !== "string") throw new Error("Invalid branch summary override");
								branchSummary = decision.summary;
								branchDetails.fromHook = true;
							}
						}
						controller.signal.throwIfAborted();
						if (summarize && preparation.entriesToSummarize.length && branchSummary === undefined) {
							const ref = (await this.conversation.agent(this.context)).model;
							const model = ref ? this.models.getModel(ref.provider, ref.modelId) : undefined;
							if (!model) throw new Error("Select a model before summarizing a branch");
							this.#summarizing = true;
							if (this.ui.capabilities.workingIndicator) this.ui.setWorkingMessage("Summarizing branch…");
							await this.#readState();
							const generated = await summarizeBranch(
								this.models,
								model,
								preparation.entriesToSummarize,
								controller.signal,
								instructions,
								{
									reserveTokens: this.#settings.branchSummary?.reserveTokens,
									replaceInstructions: options?.replaceInstructions,
									retry: { ...DEFAULT_RETRY_POLICY, ...this.#settings.retry },
									callbacks: {
										onRetryScheduled: (attempt, max, delay, error) => {
											if (this.ui.capabilities.workingIndicator)
												this.ui.setWorkingMessage(
													`Retrying branch summary ${attempt}/${max} in ${Math.ceil(delay / 1000)}s: ${error}`,
												);
										},
										onRetryAttemptStart: () => {
											if (this.ui.capabilities.workingIndicator) this.ui.setWorkingMessage("Summarizing branch…");
										},
									},
								},
							);
							branchSummary = generated.summary;
							branchDetails = {
								readFiles: generated.readFiles,
								modifiedFiles: generated.modifiedFiles,
								fromHook: false,
							};
							if (generated.usage)
								await this.harness.commit(
									(tx) =>
										recordUsage(tx, this.conversation.id, "models", `${model.provider}/${model.id}`, generated.usage),
									this.context,
								);
						}
						controller.signal.throwIfAborted();
					} finally {
						this.#summarizing = false;
						this.#commandAbort = undefined;
						if (this.ui.capabilities.workingIndicator) this.ui.setWorkingMessage();
						await this.#readState();
					}
					const user =
						target.entry.kind === "arc.branch-summary"
							? undefined
							: target.entry.model?.find((message) => message.role === "user");
					const editorText = user
						? typeof user.content === "string"
							? user.content
							: user.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("")
						: undefined;
					const entry = user ? entries.find((entry) => entry.id === target.parent) : target.entry;
					if (entry && current.at(-1)?.id === entry.id && !summarize) {
						if (options?.label !== undefined) await this.setLabel(target.entry.id, options.label);
						return { message: "Already at this point", editorText };
					}
					const owner = await this.harness.conversation(
						entry?.conversationId ?? target.entry.conversationId,
						this.context,
					);
					if (!owner) throw new Error("The selected conversation no longer exists");
					const latest = entries.filter((entry) => entry.conversationId === owner.id).at(-1);
					let conversation: Conversation;
					if (!entry)
						conversation = await this.harness.createConversation(
							{ ownership: { kind: "ownerless" }, agent: await owner.agent(this.context) },
							this.context,
						);
					else if (latest?.id === entry.id) conversation = owner;
					else conversation = await owner.fork(entry.id, { ownership: { kind: "ownerless" } }, this.context);
					if (summarize && branchSummary) {
						const summary = branchSummary;
						await conversation.commit(
							(tx) =>
								tx.appendEntry(conversation.id, {
									kind: "arc.branch-summary",
									data: { fromId: current.at(-1)?.id ?? null, summary, ...branchDetails },
									model: [
										{ role: "user", content: `Summary of the branch left behind:\n${summary}`, timestamp: Date.now() },
									],
								}),
							this.context,
						);
					}
					const previousConversationId = this.conversation.id;
					await this.#switch(conversation, "tree");
					if (options?.label !== undefined) await this.setLabel(target.entry.id, options.label);
					for (const { extension } of [...this.#lifetimes.values()]) {
						try {
							await extension.onTree?.(this.#extensionContext(extension), {
								previousConversationId,
								conversationId: conversation.id,
							});
						} catch (error) {
							this.#report(error, { type: "extension_error", extension: extension.name });
						}
					}
					return { message: `Navigated to entry ${target.entry.id}`, editorText };
				}
				const record = records.find((r) => String(r.id) === selected);
				if (!record) throw new Error(`Unknown conversation: ${selected}`);
				const conversation = await this.harness.conversation(record.id, this.context);
				if (!conversation) throw new Error(`Conversation no longer exists: ${selected}`);
				await this.#switch(conversation);
				return { message: `Conversation ${selected}` };
			}
			case "fork":
			case "clone": {
				const options = control?.kind === "fork" ? control.options : undefined;
				const position = control?.kind === "fork" ? (options?.position ?? "before") : "at";
				if ((await this.snapshot()).busy) throw new Error("Abort current work before forking");
				const entries = await this.#entries();
				let selected = args;
				if (name === "fork" && !selected && this.ui.supported) {
					selected =
						(await this.ui.select(
							"Fork from an entry",
							entries.map((entry) => ({
								value: String(entry.id),
								label: `${entry.id}: ${entry.kind}`,
								description: entry.model
									?.flatMap((message) =>
										typeof message.content === "string"
											? [message.content]
											: message.content.flatMap((block) => (block.type === "text" ? [block.text] : [])),
									)
									.join(" ")
									.slice(0, 160),
							})),
						)) ?? "";
					if (!selected) return {};
				}
				const entry = selected ? entries.find((entry) => String(entry.id) === selected) : entries.at(-1);
				if (!entry) throw new Error("Choose an existing entry to fork");
				const user = entry.model?.find((message) => message.role === "user");
				if (position === "before" && !user) throw new Error("Forking before an entry requires a user message");
				if (
					await this.#sessionCancelled((extension, context) =>
						extension.beforeFork?.(context, { entryId: entry.id, clone: name === "clone", position }),
					)
				)
					return { cancelled: true };
				const source = this.#runtime.file;
				if (name === "clone" && source) {
					const file = await newSessionFile(this.#home, this.cwd, source.endsWith(".jsonl") ? "jsonl" : "sqlite");
					await this.harness.commit(async (tx) => {
						let cursor: Cursor | undefined;
						do {
							const page = await tx.scanTasks({}, 256, cursor);
							if (page.items.some((task) => task.state.status !== "terminal"))
								throw new Error("Finish or abort all session tasks before cloning");
							cursor = page.next;
						} while (cursor !== undefined);
						await copySession(source, file);
					}, this.context);
					await this.#switchFile(file, "fork", async (next) => {
						let cursor: Cursor | undefined;
						do {
							const page = await next.harness.commit((tx) => tx.scanConversations({}, 256, cursor), this.context);
							const identities = await Promise.all(
								page.items.map(async (conversation) =>
									(await next.harness.snapshot(ProviderDoc, conversation.id, this.context))
										? conversation.id
										: undefined,
								),
							);
							await next.harness.commit(async (tx) => {
								for (const id of identities)
									if (id !== undefined) Object.assign(await tx.doc(ProviderDoc, id), ProviderDoc.definition.initial());
							}, this.context);
							cursor = page.next;
						} while (cursor !== undefined);
						next.conversation = await next.conversation.fork(
							entry.id,
							{ ownership: { kind: "ownerless" } },
							this.context,
						);
						await next.harness.commit(async (tx) => {
							(await tx.doc(SessionInfo)).conversationId = next.conversation.id;
						}, this.context);
					});
					return { message: `Cloned session ${file}`, editorText: "" };
				}
				const boundary =
					position === "before" ? entries[entries.findIndex((value) => value.id === entry.id) - 1] : entry;
				await this.#switch(
					boundary
						? await this.conversation.fork(boundary.id, { ownership: { kind: "ownerless" } }, this.context)
						: await this.harness.createConversation(
								{ ownership: { kind: "ownerless" }, agent: await this.conversation.agent(this.context) },
								this.context,
							),
					"fork",
				);
				return {
					message: `Forked conversation ${this.conversation.id}`,
					...(position === "before" && user
						? {
								editorText:
									typeof user.content === "string"
										? user.content
										: user.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n"),
							}
						: {}),
				};
			}
			case "share": {
				const controller = new AbortController();
				this.#commandAbort = controller;
				try {
					return {
						message: await shareHtml(
							exportHtml(
								await this.#entries(),
								this.ui.capabilities.themes ? this.ui.theme : this.themes.resolve(this.#settings.theme ?? "system"),
							),
							controller.signal,
						),
					};
				} finally {
					this.#commandAbort = undefined;
				}
			}
			case "export": {
				const file = resolve(this.cwd, args || "conversation.html");
				const entries = await this.#entries();
				await writeFile(
					file,
					file.toLowerCase().endsWith(".html")
						? exportHtml(
								entries,
								this.ui.capabilities.themes ? this.ui.theme : this.themes.resolve(this.#settings.theme ?? "system"),
							)
						: exportTranscript(entries),
					{
						mode: 0o600,
					},
				);
				return { message: `Exported ${file}` };
			}
			case "import": {
				if (!args) throw new Error("Usage: /import <path>");
				const messages = importTranscript(await readFile(resolve(this.cwd, args), "utf8"));
				if ((await this.snapshot()).busy) throw new Error("Abort current work before importing");
				const conversation = await this.harness.createConversation(
					{
						ownership: { kind: "ownerless" },
						agent: { cwd: this.cwd, model: (await this.conversation.agent(this.context)).model },
					},
					this.context,
				);
				await conversation.commit(async (tx) => {
					for (const message of messages)
						await tx.appendEntry(conversation.id, { kind: `arc.import.${message.role}`, model: [message] });
				}, this.context);
				await this.#switch(conversation, "import");
				return { message: `Imported ${messages.length} messages` };
			}
			default:
				throw new Error(`Unknown command: /${name}`);
		}
	}
	async #entries(): Promise<EntryRecord[]> {
		const entries: EntryRecord[] = [];
		let cursor: Cursor | undefined;
		do {
			const page = await this.conversation.entries({}, 256, cursor, this.context);
			entries.push(...page.items);
			cursor = page.next;
		} while (cursor !== undefined);
		return entries.sort((a, b) => a.id - b.id);
	}
	async #navigation() {
		return this.harness.commit(async (tx) => {
			const conversations = [];
			const entries: EntryRecord[] = [];
			let cursor: Cursor | undefined;
			do {
				const page = await tx.scanConversations({}, 256, cursor);
				conversations.push(...page.items);
				cursor = page.next;
			} while (cursor !== undefined);
			for (const conversation of conversations) {
				cursor = undefined;
				do {
					const page = await tx.scanEntries(
						{ conversationId: conversation.id, minEntryId: conversation.parent?.at, order: "ascending" },
						256,
						cursor,
					);
					entries.push(...page.items.filter((entry) => entry.conversationId === conversation.id));
					cursor = page.next;
				} while (cursor !== undefined);
			}
			return { conversations, entries };
		}, this.context);
	}
	async #dispose(preserveWork = false): Promise<void> {
		this.#cacheWarmer.cancel("application closed");
		this.#commandAbort?.abort(new Error("Application closed"));
		for (const { controller } of this.#userBash.values()) controller.abort(new Error("Application closed"));
		const aborted = preserveWork ? undefined : this.#opened?.conversation.abort(this.context).catch(() => {});
		await this.#admissions;
		await Promise.allSettled([...this.#userBash.values()].map(({ work }) => work));
		await aborted;
		await this.#transition?.catch(() => {});
		await this.#extensionEvents;
		await this.#runtimeEvents?.stop();
		this.#runtimeEvents = undefined;
		if (this.#opened) await this.#event("onSessionShutdown", "quit");
		this.#epoch++;
		await this.#view?.stop();
		this.#detachTasks();
		this.#listeners.clear();
		this.#unsubscribeUsage?.();
		await this.#refresh;
		const errors: unknown[] = [];
		for (const action of [
			...(preserveWork
				? [() => this.#opened?.harness.close(this.context), () => this.#closeLifetimes()]
				: [() => this.#closeLifetimes(), () => this.#opened?.harness.close(this.context)]),
			() => this.#opened?.release(),
			() => this.#loader.close(),
			() => this.#restoreProviders(),
			() => this.#mcp.close(),
			() => this.#sandbox?.close(),
			...Array.from(this.#environments.values(), (env) => () => env.cleanup(this.context)),
		]) {
			try {
				await action();
			} catch (error) {
				errors.push(error);
			}
		}
		if (errors.length) throw new AggregateError(errors, "Application cleanup failed");
	}
	close(options?: { readonly preserveWork?: boolean }): Promise<void> {
		if (this.#closed) return this.#closed;
		const done = Promise.withResolvers<void>();
		this.#closed = done.promise;
		void this.#dispose(options?.preserveWork).then(done.resolve, done.reject);
		return this.#closed;
	}
}
