import type {
	Component,
	Focusable,
	Editor,
	EditorTheme,
	TUI,
	TuiInputListener,
	LoaderIndicatorOptions,
	AutocompleteProvider,
	OverlayOptions,
	OverlayHandle,
	KeybindingsManager,
} from "@arc/tui";
import type { Theme } from "./theme.ts";
import type { ApplicationState } from "../types.ts";

export type ApplicationEditor = Component &
	Focusable &
	Pick<
		Editor,
		| "getText"
		| "getExpandedText"
		| "setText"
		| "addToHistory"
		| "setAutocompleteProvider"
		| "isShowingAutocomplete"
		| "onSubmit"
		| "onChange"
		| "insertTextAtCursor"
		| "handleInput"
	> & { dispose?(): void };
export type EditorFactory = (tui: TUI, theme: EditorTheme, keybindings: KeybindingsManager) => ApplicationEditor;
export type AutocompleteProviderFactory = (current: AutocompleteProvider) => AutocompleteProvider;

export type UIComponent = Component & Partial<Focusable> & { dispose?(): void };
export type CustomUIFactory<T> = (
	tui: TUI,
	theme: Theme,
	keybindings: KeybindingsManager,
	done: (value: T) => void,
) => UIComponent | Promise<UIComponent>;
export type UIFactory = (tui: TUI, theme: Theme) => UIComponent;
export interface FooterData {
	getGitBranch(): string | null;
	getAvailableProviderCount(): number;
	onBranchChange(listener: () => void): () => void;
	getState(): ApplicationState;
	getExtensionStatuses(): ReadonlyMap<string, string>;
}
export type FooterFactory = (tui: TUI, theme: Theme, data: FooterData) => UIComponent;
export type WidgetContent = Component | readonly string[] | UIFactory;
export interface CustomUIOptions {
	readonly overlay?: boolean;
	readonly overlayOptions?: OverlayOptions | (() => OverlayOptions);
	readonly onHandle?: (handle: OverlayHandle) => void;
}

export interface UIItem {
	readonly value: string;
	readonly label: string;
	readonly description?: string;
}
export interface UIDialogOptions {
	readonly signal?: AbortSignal;
	readonly timeout?: number;
}

export interface UISelectOptions extends UIDialogOptions {
	readonly initialSearch?: string;
	readonly initialValue?: string;
}

export type UINotificationKind = "info" | "warning" | "error";

export interface UICapabilities {
	readonly select: boolean;
	readonly confirm: boolean;
	readonly input: boolean;
	readonly notifications: boolean;
	readonly editor: boolean;
	readonly status: boolean;
	readonly widgets: boolean;
	readonly title: boolean;
	readonly custom: boolean;
	readonly clipboard: boolean;
	readonly themes: boolean;
	readonly header: boolean;
	readonly footer: boolean;
	readonly terminalInput: boolean;
	readonly toolExpansion: boolean;
	readonly workingIndicator: boolean;
	readonly hiddenThinkingLabel: boolean;
	readonly autocomplete: boolean;
	readonly overlays: boolean;
}

export interface ApplicationUI {
	tree?(
		items: readonly import("../sessions/navigation.ts").NavigationItem[],
		options: { readonly initialValue?: string; readonly filter: import("../sessions/navigation.ts").TreeFilter },
	): Promise<import("../sessions/navigation.ts").TreeSelection>;
	readonly supported: boolean;
	readonly capabilities: UICapabilities;
	readonly theme: Theme;
	getAllThemes(): { name: string; path: string | undefined }[];
	getTheme(name: string): Theme | undefined;
	setTheme(theme: string | Theme): { success: boolean; error?: string };
	onTerminalInput(handler: TuiInputListener): () => void;
	setHeader(factory: UIFactory | undefined): void;
	setFooter(factory: FooterFactory | undefined): void;
	getToolsExpanded(): boolean;
	setToolsExpanded(expanded: boolean): void;
	setWorkingMessage(message?: string): void;
	setWorkingVisible(visible: boolean): void;
	setWorkingIndicator(options?: LoaderIndicatorOptions): void;
	setHiddenThinkingLabel(label?: string): void;
	addAutocompleteProvider(factory: AutocompleteProviderFactory): () => void;
	select(title: string, items: readonly UIItem[], options?: UISelectOptions): Promise<string | undefined>;
	confirm(title: string, message: string, options?: UIDialogOptions): Promise<boolean>;
	input(
		title: string,
		initial?: string,
		options?: UIDialogOptions & { readonly secret?: boolean },
	): Promise<string | undefined>;
	notify(message: string, kind?: UINotificationKind): void;
	copyText(text: string): Promise<void>;
	setEditorComponent(factory: EditorFactory | undefined): void;
	getEditorComponent(): EditorFactory | undefined;
	getEditorText(): string;
	setEditorText(text: string): void;
	pasteToEditor(text: string): void;
	editor(title: string, initial?: string): Promise<string | undefined>;
	setStatus(key: string, text?: string): void;
	setWidget(key: string, content?: WidgetContent, options?: { placement?: "aboveEditor" | "belowEditor" }): void;
	setTitle(title: string): void;
	custom<T>(factory: CustomUIFactory<T>, options?: CustomUIOptions): Promise<T>;
}

export function createUnavailableUI(): ApplicationUI {
	const unavailable = (): never => {
		throw new Error("The application UI requires interactive mode");
	};
	return {
		supported: false,
		capabilities: {
			select: false,
			confirm: false,
			input: false,
			notifications: false,
			editor: false,
			status: false,
			widgets: false,
			title: false,
			custom: false,
			clipboard: false,
			themes: false,
			header: false,
			footer: false,
			terminalInput: false,
			toolExpansion: false,
			workingIndicator: false,
			hiddenThinkingLabel: false,
			autocomplete: false,
			overlays: false,
		},
		get theme() {
			return unavailable();
		},
		getAllThemes: unavailable,
		getTheme: unavailable,
		setTheme: unavailable,
		onTerminalInput: unavailable,
		setHeader: unavailable,
		setFooter: unavailable,
		getToolsExpanded: unavailable,
		setToolsExpanded: unavailable,
		setWorkingMessage: unavailable,
		setWorkingVisible: unavailable,
		setWorkingIndicator: unavailable,
		setHiddenThinkingLabel: unavailable,
		addAutocompleteProvider: unavailable,
		async select() {
			return unavailable();
		},
		async confirm() {
			return unavailable();
		},
		async input() {
			return unavailable();
		},
		notify: unavailable,
		async copyText() {
			return unavailable();
		},
		setEditorComponent: unavailable,
		getEditorComponent: unavailable,
		getEditorText: unavailable,
		setEditorText: unavailable,
		pasteToEditor: unavailable,
		async editor() {
			return unavailable();
		},
		setStatus: unavailable,
		setWidget: unavailable,
		setTitle: unavailable,
		async custom() {
			return unavailable();
		},
	};
}
