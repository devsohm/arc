import type { ApplicationUI } from "./ui/ui.ts";
import type {
	Agent,
	Context,
	Conversation,
	ConversationView,
	Harness,
	InboxState,
	LiveState,
	Submission,
	UsageState,
	TaskGraph,
	UserInput,
} from "@arc/durable";
import type { Models } from "@arc/ai";

export interface ApplicationState {
	readonly userBash?: readonly import("./tools/user-bash.ts").UserBashProgress[];
	readonly cwd: string;
	readonly sessionFile: string | undefined;
	readonly sessionName?: string;
	readonly parentSession?: string;
	readonly view: ConversationView;
	readonly agent: Agent;
	readonly live: LiveState;
	readonly inbox: InboxState;
	readonly usage: UsageState;
	readonly busy: boolean;
	readonly routedModel?: {
		readonly contextWindow?: number;
		readonly provider: string;
		readonly modelId: string;
		readonly thinkingLevel?: import("@arc/ai").ModelThinkingLevel;
	};
	readonly cacheWarming?: import("./providers/cache-warmer.ts").CacheWarmingStatus;
	readonly enabledModels?: readonly string[];
	readonly presentationRevision?: number;
	readonly fullscreenRevision?: number;
	readonly tasks?: TaskGraph;
	readonly settings?: Pick<
		import("./configuration/settings.ts").ApplicationSettings,
		| "toolExecution"
		| "fullscreen"
		| "compaction"
		| "steeringMode"
		| "followUpMode"
		| "theme"
		| "markdown"
		| "cacheWarming"
		| "codemode"
		| "retry"
		| "treeFilterMode"
		| "branchSummarySkipPrompt"
		| "editorPaddingX"
		| "autocompleteMaxVisible"
		| "showHardwareCursor"
		| "clearOnShrink"
		| "showTerminalProgress"
	>;
}
export interface CommandInfo {
	readonly getArgumentCompletions?: (
		prefix: string,
	) => import("@arc/tui").AutocompleteItem[] | null | Promise<import("@arc/tui").AutocompleteItem[] | null>;
	readonly name: string;
	readonly description: string;
}
export interface CommandResult {
	readonly cancelled?: true;
	readonly message?: string;
	readonly quit?: boolean;
	readonly editorText?: string;
}
export interface RunResult {
	readonly status: "done" | "unanswered";
	readonly text: string;
}
export interface Application {
	flags(): Readonly<Record<string, ExtensionFlag>>;
	readonly mode: ApplicationMode;
	readonly home: string;
	readonly cwd: string;
	readonly ui: ApplicationUI;
	attachUI(ui: ApplicationUI): () => Promise<void>;
	readonly context: Context;
	readonly models: Models;
	readonly themes: import("./ui/theme.ts").ThemeCatalog;
	toolRenderers(
		name: string,
		base?: () => import("./ui/tool-renderers.ts").ToolRenderers | undefined,
	): import("./ui/tool-renderers.ts").ToolRenderers | undefined;
	messageRenderer(name: string): import("./ui/tool-renderers.ts").MessageRenderer | undefined;
	entryRenderer(name: string): import("./ui/tool-renderers.ts").EntryRenderer | undefined;
	markdownTransformers(): readonly import("./ui/tool-renderers.ts").MarkdownTransformer[];
	shortcuts(): readonly {
		readonly key: import("@arc/tui").KeyId;
		readonly description?: string;
		execute(): Promise<void>;
	}[];
	getLabel(id: import("@arc/durable").EntryId): Promise<string | undefined>;
	setLabel(id: import("@arc/durable").EntryId, label: string | undefined): Promise<void>;
	previewEdit(
		input: import("@arc/durable/tools").EditToolInput,
	): ReturnType<typeof import("@arc/durable/tools").previewEdit>;
	readonly harness: Harness;
	readonly conversation: Conversation;
	snapshot(): Promise<ApplicationState>;
	subscribe(listener: (state: ApplicationState) => void): () => void;
	submit(
		input: UserInput,
		options?: { readonly whenBusy?: "steer" | "followUp" | "reject" },
	): Promise<Submission | undefined>;
	run(input: UserInput): Promise<RunResult>;
	executeBash(
		command: string,
		options?: {
			readonly excludeFromContext?: boolean;
			readonly onChunk?: (chunk: string) => void;
			readonly signal?: AbortSignal;
		},
	): Promise<import("./tools/user-bash.ts").UserBashResult>;
	abort(): Promise<void>;
	cycleModel(direction?: "forward" | "backward"): Promise<CommandResult>;
	hasCommandOverride(name: string): boolean;
	commands(): readonly CommandInfo[];
	command(input: string): Promise<CommandResult>;
	reload(): Promise<void>;
	close(options?: { readonly preserveWork?: boolean }): Promise<void>;
}

export interface ApplicationCommand extends CommandInfo {
	execute(
		args: string,
		application: Application,
		context: ExtensionCommandContext,
	): Promise<CommandResult> | CommandResult;
}
export type SessionReason = "startup" | "reload" | "new" | "resume" | "fork" | "tree" | "import" | "quit";
export type ApplicationMode = "sdk" | "interactive" | "text" | "json" | "rpc";
export type CommandInterception =
	| { readonly action: "continue" }
	| { readonly action: "cancel"; readonly message?: string };
export interface InputEvent {
	readonly text: string;
	readonly images?: readonly import("@arc/ai").ImageContent[];
	readonly source: "interactive" | "rpc" | "extension";
	readonly streamingBehavior?: "steer" | "followUp";
}
export type InputResult =
	| { readonly action: "continue" }
	| { readonly action: "handled" }
	| {
			readonly action: "transform";
			readonly text: string;
			readonly images?: readonly import("@arc/ai").ImageContent[];
	  };
export type SessionSwitchEvent = { readonly reason: "new" | "resume"; readonly targetSessionFile?: string };
export type ForkEvent = {
	readonly entryId: import("@arc/durable").EntryId;
	readonly clone: boolean;
	readonly position?: "before" | "at";
};
export type TreeEvent = {
	readonly targetId: import("@arc/durable").EntryId;
	readonly oldLeafId?: import("@arc/durable").EntryId;
	readonly commonAncestorId?: import("@arc/durable").EntryId;
	readonly entriesToSummarize: readonly import("@arc/durable").EntryRecord[];
	readonly userWantsSummary: boolean;
	readonly signal: AbortSignal;
};
export type TreeDecision = SessionDecision & { readonly summary?: string };
export type SessionDecision = { readonly cancel?: boolean };
export type ExtensionFlag = { readonly description?: string } & (
	| { readonly type: "boolean"; readonly default?: boolean }
	| { readonly type: "string"; readonly default?: string }
);

export interface ExtensionEvents {
	emit(channel: string, data: unknown): void;
	on(channel: string, listener: (data: unknown) => void | Promise<void>): () => void;
}

export interface ProjectTrustContext {
	readonly cwd: string;
	readonly mode: ApplicationMode;
	readonly hasUI: boolean;
	readonly ui: Pick<ApplicationUI, "select" | "confirm" | "input" | "notify">;
}
export interface ProjectTrustDecision {
	readonly trusted: "yes" | "no" | "undecided";
	readonly remember?: boolean;
}

export interface ContextUsage {
	readonly tokens: number | null;
	readonly contextWindow: number;
	readonly percent: number | null;
}

export interface ExtensionContext {
	on<T extends import("@arc/durable").AgentEvent["type"]>(
		type: T,
		listener: (
			context: ExtensionContext,
			event: Extract<import("@arc/durable").AgentEvent, { type: T }>,
		) => void | Promise<void>,
	): () => void;
	registerHook(registration: import("@arc/durable").HookRegistration): () => void;
	registerTool(tool: import("@arc/durable").ToolRegistration): void;
	registerCommand(command: ApplicationCommand): void;
	registerFlag(name: string, flag: ExtensionFlag): void;
	registerShortcut(shortcut: NonNullable<ApplicationExtension["shortcuts"]>[number]): void;
	registerMessageRenderer(name: string, renderer: import("./ui/tool-renderers.ts").MessageRenderer): void;
	registerEntryRenderer(name: string, renderer: import("./ui/tool-renderers.ts").EntryRenderer): void;
	registerToolRenderer(name: string, renderer: import("./ui/tool-renderers.ts").ToolRenderers): void;
	readonly events: ExtensionEvents;
	getSystemPrompt(): Promise<string>;
	getContextUsage(): Promise<ContextUsage | undefined>;
	getFlag(name: string): string | boolean | undefined;
	getLabel(id: import("@arc/durable").EntryId): Promise<string | undefined>;
	setLabel(id: import("@arc/durable").EntryId, label: string | undefined): Promise<void>;
	readonly hasUI: boolean;
	readonly model: import("@arc/ai").Model<import("@arc/ai").Api> | undefined;
	readonly scopedModels: readonly import("./providers/model-scope.ts").ScopedModel[];
	readonly thinkingLevel: import("@arc/ai").ModelThinkingLevel;
	isIdle(): boolean;
	isProjectTrusted(): boolean;
	hasPendingMessages(): boolean;
	abort(): Promise<void>;
	compact(instructions?: string): Promise<import("@arc/durable").TaskId<import("@arc/durable").CompactionResult>>;
	getSessionName(): string | undefined;
	setSessionName(name: string): Promise<void>;
	getActiveTools(): string[];
	getAllTools(): readonly import("@arc/durable").ToolRegistration[];
	setActiveTools(names: readonly string[]): Promise<void>;
	getCommands(): readonly CommandInfo[];
	getSettings(): Readonly<import("./configuration/settings.ts").ApplicationSettings>;
	setModel(model: import("@arc/ai").Model<import("@arc/ai").Api>): Promise<boolean>;
	getThinkingLevel(): import("@arc/ai").ModelThinkingLevel;
	setThinkingLevel(level: import("@arc/ai").ModelThinkingLevel): Promise<void>;
	sendUserMessage(input: UserInput, options?: { deliverAs?: "steer" | "followUp" }): Promise<Submission>;
	sendMessage(
		message: import("./sessions/custom-entries.ts").CustomMessage,
		options?: { triggerTurn?: boolean; deliverAs?: "steer" | "followUp" | "nextTurn" },
	): Promise<Submission | undefined>;
	appendEntry(customType: string, data?: import("@arc/durable").JsonValue): Promise<Submission>;
	registerVirtualModel(definition: import("./providers/virtual-models.ts").VirtualModelDefinition): void;
	unregisterVirtualModel(provider: string, id: string): void;
	registerProvider(provider: import("@arc/ai").Provider): void;
	unregisterProvider(id: string): void;
	registerMcpServer(server: import("./configuration/settings.ts").McpServerSetting): Promise<void>;
	unregisterMcpServer(name: string): Promise<void>;
	getMcpServers(): readonly { name: string; tools: number }[];

	readonly mode: ApplicationMode;
	readonly cwd: string;
	readonly state: ApplicationState;
	readonly models: Models;
	readonly harness: Harness;
	readonly conversation: Conversation;
	readonly ui: ApplicationUI;
}
export interface ExtensionCommandContext extends ExtensionContext {
	getSystemPromptOptions(): Readonly<import("./resources/prompt.ts").PromptOptions>;
	waitForIdle(): Promise<void>;
	newSession(options?: NewSessionOptions): Promise<CommandResult>;
	fork(entryId: import("@arc/durable").EntryId, options?: ForkOptions): Promise<CommandResult>;
	navigateTree(entryId: import("@arc/durable").EntryId, options?: NavigateTreeOptions): Promise<CommandResult>;
	switchSession(path: string, options?: SessionReplacementOptions): Promise<CommandResult>;
	reload(): Promise<void>;
}
export interface SessionReplacementOptions {
	readonly withSession?: (context: ExtensionCommandContext) => void | Promise<void>;
}
export interface NewSessionOptions extends SessionReplacementOptions {
	readonly parentSession?: string;
	readonly setup?: import("@arc/durable").ConversationInit;
}
export interface ForkOptions extends SessionReplacementOptions {
	readonly position?: "before" | "at";
}
export interface NavigateTreeOptions {
	readonly summarize?: boolean;
	readonly customInstructions?: string;
	readonly replaceInstructions?: boolean;
	readonly label?: string;
}

export type ExtensionCleanup = () => void | Promise<void>;
export type SessionListener = (
	context: ExtensionContext,
	event: { readonly reason: SessionReason },
) => void | Promise<void>;

export type ApplicationExtension = import("@arc/durable").Extension &
	import("./providers/provider-events.ts").ProviderCallbacks & {
		readonly runtimeEvents?: readonly ((
			context: ExtensionContext,
			event: import("@arc/durable").AgentEvent,
		) => void | Promise<void>)[];
		readonly virtualModels?: readonly import("./providers/virtual-models.ts").VirtualModelDefinition[];
		onCacheWarmingDecision?(
			context: ExtensionContext,
			event: import("./providers/cache-warmer.ts").CacheWarmingDecision,
		): void | { action?: "warm" | "stop" } | Promise<void | { action?: "warm" | "stop" }>;
		onProjectTrust?(context: ProjectTrustContext): void | ProjectTrustDecision | Promise<void | ProjectTrustDecision>;
		onResourcesDiscover?(
			context: ExtensionContext,
			event: { readonly cwd: string; readonly reason: "startup" | "reload" },
		):
			| void
			| {
					readonly skillPaths?: readonly string[];
					readonly promptPaths?: readonly string[];
					readonly themePaths?: readonly string[];
			  }
			| Promise<void | {
					readonly skillPaths?: readonly string[];
					readonly promptPaths?: readonly string[];
					readonly themePaths?: readonly string[];
			  }>;
		onInput?(context: ExtensionContext, event: InputEvent): void | InputResult | Promise<void | InputResult>;
		onUserBash?(
			context: ExtensionContext,
			event: {
				readonly command: string;
				readonly cwd: string;
				readonly excludeFromContext: boolean;
				readonly signal: AbortSignal;
			},
		):
			| void
			| {
					readonly result?: import("./tools/user-bash.ts").UserBashResult;
					readonly operations?: Pick<import("@arc/durable/env").ExecutionEnv, "exec">;
			  }
			| Promise<void | {
					readonly result?: import("./tools/user-bash.ts").UserBashResult;
					readonly operations?: Pick<import("@arc/durable/env").ExecutionEnv, "exec">;
			  }>;
		beforeSessionSwitch?(
			context: ExtensionContext,
			event: SessionSwitchEvent,
		): void | SessionDecision | Promise<void | SessionDecision>;
		beforeFork?(context: ExtensionContext, event: ForkEvent): void | SessionDecision | Promise<void | SessionDecision>;
		onSessionInfoChanged?(context: ExtensionContext, event: { readonly name: string }): void | Promise<void>;
		onTree?(
			context: ExtensionContext,
			event: {
				readonly previousConversationId: import("@arc/durable").ConversationId;
				readonly conversationId: import("@arc/durable").ConversationId;
			},
		): void | Promise<void>;
		onMcpServersChange?(
			context: ExtensionContext,
			event: { readonly servers: readonly { name: string; tools: number }[] },
		): void | Promise<void>;
		beforeTree?(context: ExtensionContext, event: TreeEvent): void | TreeDecision | Promise<void | TreeDecision>;
		readonly commands?: readonly ApplicationCommand[];
		activate?(context: ExtensionContext): void | ExtensionCleanup | Promise<void | ExtensionCleanup>;
		onSessionStart?: SessionListener;
		onSessionShutdown?: SessionListener;
		onUIAttached?: SessionListener;
		onUIDetached?: SessionListener;
		beforeCommand?(
			context: ExtensionContext,
			command: { readonly name: string; readonly args: string },
		): void | CommandInterception | Promise<void | CommandInterception>;
		readonly providers?: readonly import("@arc/ai").Provider[];
		readonly flags?: Readonly<Record<string, ExtensionFlag>>;
		readonly shortcuts?: readonly {
			readonly key: import("@arc/tui").KeyId;
			readonly description?: string;
			execute(context: ExtensionContext): void | Promise<void>;
		}[];
		readonly toolRendererResolvers?: readonly import("./ui/tool-renderers.ts").ToolRendererResolver[];
		readonly markdownTransformer?: import("./ui/tool-renderers.ts").MarkdownTransformer;
		readonly messageRenderers?: Readonly<Record<string, import("./ui/tool-renderers.ts").MessageRenderer>>;
		readonly entryRenderers?: Readonly<Record<string, import("./ui/tool-renderers.ts").EntryRenderer>>;
		readonly toolRenderers?: Readonly<Record<string, import("./ui/tool-renderers.ts").ToolRenderers>>;
	};
