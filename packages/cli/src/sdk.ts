export { createApplication, assistantText, type ApplicationOptions } from "./core/application.ts";
export type {
	Application,
	ApplicationState,
	CommandInfo,
	CommandResult,
	RunResult,
	ApplicationCommand,
	ApplicationExtension,
	ExtensionContext,
	ContextUsage,
	ProjectTrustContext,
	ProjectTrustDecision,
	ExtensionEvents,
	ExtensionFlag,
	ExtensionCommandContext,
	ExtensionCleanup,
	SessionReason,
	ApplicationMode,
	CommandInterception,
	InputEvent,
	InputResult,
	SessionSwitchEvent,
	ForkEvent,
	TreeEvent,
	TreeDecision,
	NewSessionOptions,
	ForkOptions,
	NavigateTreeOptions,
	SessionReplacementOptions,
	SessionDecision,
} from "./core/types.ts";
export {
	FileCredentialStore,
	createApplicationModels,
	loginProvider,
	logoutProvider,
} from "./core/authentication/auth.ts";
export {
	loadSettings,
	saveSettings,
	type ApplicationSettings,
	type McpServerSetting,
} from "./core/configuration/settings.ts";
export { loadResources, expandPrompt, promptForSkill, type Resources } from "./core/resources/resources.ts";

export type {
	ApplicationUI,
	ApplicationEditor,
	UIComponent,
	EditorFactory,
	AutocompleteProviderFactory,
	UIItem,
	UISelectOptions,
	UIDialogOptions,
	UINotificationKind,
	UICapabilities,
	UIFactory,
	FooterFactory,
	FooterData,
	WidgetContent,
	CustomUIOptions,
	CustomUIFactory,
} from "./core/ui/ui.ts";
export { createUnavailableUI } from "./core/ui/ui.ts";
export type { UserBashEntry, UserBashProgress, UserBashResult } from "./core/tools/user-bash.ts";

export type {
	ToolRenderers,
	ToolRenderContext,
	ToolRendererResolver,
	MarkdownTransformer,
	MarkdownTransformContext,
} from "./core/ui/tool-renderers.ts";

export type { UserInput } from "@arc/durable";
export { Theme, ThemeCatalog, type ThemeToken, type ThemeJson } from "./core/ui/theme.ts";
export type { NavigationItem, TreeFilter, TreeSelection } from "./core/sessions/navigation.ts";

export type { CustomMessage, CustomEntry } from "./core/sessions/custom-entries.ts";
export type { MessageRenderer, EntryRenderer } from "./core/ui/tool-renderers.ts";

export type { ProviderContext, ProviderCallbacks } from "./core/providers/provider-events.ts";

export type { CacheWarmingMode, CacheWarmingStatus, CacheWarmingDecision } from "./core/providers/cache-warmer.ts";

export type { VirtualModelDefinition, ModelRouteRequest } from "./core/providers/virtual-models.ts";
