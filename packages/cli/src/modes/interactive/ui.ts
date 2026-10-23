import { SessionSelector } from "./session-selector.ts";
import type { SessionPickerRequest } from "../../core/sessions/session-actions.ts";
import { plainText } from "../../core/ui/text.ts";
import {
	Container,
	CURSOR_MARKER,
	Input,
	SelectList,
	Text,
	fuzzyFilter,
	getKeybindings,
	type Component,
	Editor,
	type Focusable,
	type EditorTheme,
	type AutocompleteProvider,
	type SelectItem,
	type SelectListTheme,
	type TUI,
	type OverlayHandle,
} from "@arc/tui";
import chalk from "chalk";
import type {
	ApplicationEditor,
	UIComponent,
	EditorFactory,
	ApplicationUI,
	UICapabilities,
	UIItem,
	UINotificationKind,
	UIFactory,
	FooterFactory,
	FooterData,
	WidgetContent,
	AutocompleteProviderFactory,
	CustomUIOptions,
	CustomUIFactory,
	UISelectOptions,
	UIDialogOptions,
} from "../../core/ui/ui.ts";
import { Theme, type ThemeCatalog } from "../../core/ui/theme.ts";
import { copyText } from "./clipboard.ts";
import { selectTheme, shortcut } from "./components.ts";
import { TreeSelector } from "./tree-selector.ts";
import type { NavigationItem, TreeFilter, TreeSelection } from "../../core/sessions/navigation.ts";

const selectionActions = [
	"tui.select.up",
	"tui.select.down",
	"tui.select.pageUp",
	"tui.select.pageDown",
	"tui.select.confirm",
	"tui.select.cancel",
] as const;

export class SelectionDialog extends Container implements Focusable {
	readonly #input = new Input({ placeholder: "Type to filter", placeholderStyle: chalk.dim });
	readonly #results = new Container();
	readonly #items: SelectItem[];
	readonly #limit: number;
	readonly #select: (value: string) => void;
	readonly #cancel: () => void;
	readonly #theme: SelectListTheme;
	#list: SelectList;
	constructor(
		title: string | Text,
		items: readonly UIItem[],
		limit: number,
		select: (value: string) => void,
		cancel: () => void,
		initialSearch = "",
		theme: SelectListTheme = selectTheme,
		initialValue?: string,
	) {
		super();
		this.#items = items.map((item) => ({
			...item,
			label: plainText(item.label || item.value),
			description: item.description === undefined ? undefined : plainText(item.description),
		}));
		this.#limit = limit;
		this.#select = select;
		this.#cancel = cancel;
		this.#theme = theme;
		this.#input.setValue(plainText(initialSearch).replace(/\n/g, " "));
		const filtered = fuzzyFilter(this.#items, this.#input.getValue(), (item) => `${item.label} ${item.value}`);
		this.#list = this.#build(filtered);
		if (initialValue !== undefined) {
			const index = filtered.findIndex((item) => item.value === initialValue);
			if (index >= 0) this.#list.setSelectedIndex(index);
		}
		this.addChild(typeof title === "string" ? new Text(theme.selectedText(plainText(title)), 1, 0) : title);
		this.addChild(this.#input);
		this.addChild(this.#results);
		this.addChild(
			new Text(
				chalk.dim(
					`${shortcut("tui.select.up", "Up")}/${shortcut("tui.select.down", "Down")} choose · ${shortcut("tui.select.confirm", "Enter")} select · ${shortcut("tui.select.cancel", "Escape")} cancel`,
				),
				1,
				0,
			),
		);
	}
	get focused(): boolean {
		return this.#input.focused;
	}
	set focused(value: boolean) {
		this.#input.focused = value;
	}
	#build(items: SelectItem[]): SelectList {
		const list = new SelectList(items, this.#limit, this.#theme);
		list.onSelect = (item) => this.#select(item.value);
		list.onCancel = this.#cancel;
		this.#results.clear();
		this.#results.addChild(list);
		return list;
	}
	handleInput(data: string): void {
		if (selectionActions.some((action) => getKeybindings().matches(data, action))) {
			this.#list.handleInput(data);
			return;
		}
		this.#input.handleInput(data);
		this.#list = this.#build(fuzzyFilter(this.#items, this.#input.getValue(), (item) => `${item.label} ${item.value}`));
	}
}

class TextDialog extends Container implements Focusable {
	readonly #input = new Input();
	constructor(title: Text, initial: string, done: (value: string | undefined) => void, secret = false) {
		super();
		this.#input.setValue(plainText(initial).replace(/\n/g, " "));
		this.#input.handleInput("\x05");
		this.#input.onSubmit = done;
		this.#input.onEscape = () => done(undefined);
		this.addChild(title);
		this.addChild(
			secret
				? {
						render: (width) => [
							"> " +
								"*".repeat(Math.min([...this.#input.getValue()].length, Math.max(0, width - 3))) +
								(this.focused ? CURSOR_MARKER : ""),
						],
						invalidate() {},
					}
				: this.#input,
		);
		this.addChild(new Text(chalk.dim(`${shortcut("tui.input.submit", "Enter")} confirm · Esc cancel`), 1, 0));
	}
	get focused(): boolean {
		return this.#input.focused;
	}
	set focused(value: boolean) {
		this.#input.focused = value;
	}
	handleInput(data: string): void {
		this.#input.handleInput(data);
	}
}

class MultilineDialog extends Container implements Focusable {
	readonly #input: Editor;
	constructor(tui: TUI, theme: EditorTheme, title: string, initial: string, done: (value: string | undefined) => void) {
		super();
		this.#input = new Editor(tui, theme);
		this.#input.setText(plainText(initial));
		this.#input.onSubmit = done;
		this.addChild(new Text(plainText(title), 1, 0));
		this.addChild(this.#input);
		this.addChild(
			new Text(
				`${shortcut("tui.input.newLine", "Shift+Enter")} newline · ${shortcut("tui.input.submit", "Enter")} confirm · Esc cancel`,
				1,
				0,
			),
		);
	}
	get focused(): boolean {
		return this.#input.focused;
	}
	set focused(value: boolean) {
		this.#input.focused = value;
	}
	handleInput(data: string): void {
		this.#input.handleInput(data);
	}
}

type Dialog = {
	view:
		| { readonly kind: "building" }
		| { readonly kind: "ready"; readonly component: UIComponent }
		| { readonly kind: "overlay"; readonly component: UIComponent; readonly handle: OverlayHandle };
	readonly cancel: () => void;
};

type PresentationControls = Pick<
	ApplicationUI,
	"setWorkingMessage" | "setWorkingVisible" | "setWorkingIndicator" | "setHiddenThinkingLabel"
>;

export class InteractiveUI implements ApplicationUI {
	readonly capabilities: UICapabilities = {
		select: true,
		confirm: true,
		input: true,
		notifications: true,
		editor: true,
		status: true,
		widgets: true,
		title: true,
		custom: true,
		clipboard: true,
		themes: true,
		header: true,
		footer: true,
		terminalInput: true,
		toolExpansion: true,
		workingIndicator: true,
		hiddenThinkingLabel: true,
		autocomplete: true,
		overlays: true,
	};
	readonly #defaultEditor: Editor;
	#editor: ApplicationEditor;
	#editorFactory: EditorFactory | undefined;
	#autocomplete: AutocompleteProvider | undefined;
	#baseAutocomplete: AutocompleteProvider | undefined;
	readonly #autocompleteFactories = new Map<symbol, AutocompleteProviderFactory>();
	readonly #editorTheme: EditorTheme;
	readonly #dock: Container;
	readonly #status: Container;
	readonly #widgets: Container;
	readonly #belowWidgets: Container;
	readonly #header: Container;
	readonly #footer: Container;
	readonly #defaultHeader: Component;
	readonly #defaultFooter: Component;
	#customHeader: { factory: UIFactory; component: UIComponent } | undefined;
	#customFooter: { factory: FooterFactory; component: UIComponent } | undefined;
	readonly #footerData: FooterData;
	readonly #themes: ThemeCatalog;
	#theme: Theme;
	readonly #appearance: () => "dark" | "light";
	readonly #themeChanged: (theme: Theme, selection: string | Theme) => void;
	readonly #inputs = new Set<() => void>();
	readonly #tui: TUI;
	readonly #notify: (text: string, kind: UINotificationKind) => void;
	readonly #toolExpansion: Pick<ApplicationUI, "getToolsExpanded" | "setToolsExpanded">;
	readonly #presentation: PresentationControls;
	readonly #statuses = new Map<string, string>();
	readonly #components = new Map<
		string,
		{ content: WidgetContent; component: UIComponent; placement: "aboveEditor" | "belowEditor" }
	>();
	readonly #dialogs: Dialog[] = [];
	#disposed = false;
	#savedTitle = false;
	constructor(options: {
		readonly editor: Editor;
		readonly editorTheme: EditorTheme;
		readonly dock: Container;
		readonly status: Container;
		readonly widgets: Container;
		readonly belowWidgets: Container;
		readonly header: Container;
		readonly footer: Container;
		readonly defaultHeader: Component;
		readonly defaultFooter: Component;
		readonly footerData: Pick<FooterData, "getState"> & Partial<Omit<FooterData, "getState" | "getExtensionStatuses">>;
		readonly themes: ThemeCatalog;
		readonly theme: Theme;
		readonly appearance: () => "dark" | "light";
		readonly themeChanged: (theme: Theme, selection: string | Theme) => void;
		readonly tui: TUI;
		readonly notify: (text: string, kind: UINotificationKind) => void;
		readonly toolExpansion: Pick<ApplicationUI, "getToolsExpanded" | "setToolsExpanded">;
		readonly presentation: PresentationControls;
	}) {
		this.#editor = options.editor;
		this.#defaultEditor = options.editor;
		this.#editorTheme = options.editorTheme;
		this.#dock = options.dock;
		this.#status = options.status;
		this.#widgets = options.widgets;
		this.#belowWidgets = options.belowWidgets;
		this.#header = options.header;
		this.#footer = options.footer;
		this.#defaultHeader = options.defaultHeader;
		this.#defaultFooter = options.defaultFooter;
		this.#footerData = {
			getState: options.footerData.getState,
			getExtensionStatuses: () => new Map(this.#statuses),
			getGitBranch: options.footerData.getGitBranch ?? (() => null),
			getAvailableProviderCount: options.footerData.getAvailableProviderCount ?? (() => 0),
			onBranchChange: options.footerData.onBranchChange ?? (() => () => {}),
		};
		this.#themes = options.themes;
		this.#theme = options.theme;
		this.#appearance = options.appearance;
		this.#themeChanged = options.themeChanged;
		this.#tui = options.tui;
		this.#notify = options.notify;
		this.#toolExpansion = options.toolExpansion;
		this.#presentation = options.presentation;
	}
	getToolsExpanded(): boolean {
		this.#assertOpen();
		return this.#toolExpansion.getToolsExpanded();
	}
	setToolsExpanded(expanded: boolean): void {
		this.#assertOpen();
		this.#toolExpansion.setToolsExpanded(expanded);
	}
	setWorkingMessage(message?: string): void {
		this.#assertOpen();
		this.#presentation.setWorkingMessage(message);
	}
	setWorkingVisible(visible: boolean): void {
		this.#assertOpen();
		this.#presentation.setWorkingVisible(visible);
	}
	setWorkingIndicator(options?: Parameters<ApplicationUI["setWorkingIndicator"]>[0]): void {
		this.#assertOpen();
		this.#presentation.setWorkingIndicator(options);
	}
	setHiddenThinkingLabel(label?: string): void {
		this.#assertOpen();
		this.#presentation.setHiddenThinkingLabel(label);
	}
	get theme(): Theme {
		return this.#theme;
	}
	getAllThemes(): { name: string; path: string | undefined }[] {
		this.#assertOpen();
		return this.#themes.all();
	}
	getTheme(name: string): Theme | undefined {
		this.#assertOpen();
		return this.#themes.get(name);
	}
	setTheme(selection: string | Theme): { success: boolean; error?: string } {
		this.#assertOpen();
		let theme: Theme;
		try {
			if (typeof selection !== "string" && !(selection instanceof Theme))
				throw new Error("Expected a theme name or Theme instance");
			theme = typeof selection === "string" ? this.#themes.resolve(selection, this.#appearance()) : selection;
		} catch (error) {
			return { success: false, error: error instanceof Error ? error.message : String(error) };
		}
		this.#theme = theme;
		for (const [key, widget] of this.#components)
			if (typeof widget.content === "function") {
				try {
					this.setWidget(key, widget.content, { placement: widget.placement });
				} catch (error) {
					this.#notify(String(error), "error");
				}
			}
		try {
			if (this.#customHeader) this.setHeader(this.#customHeader.factory);
		} catch (error) {
			this.#notify(String(error), "error");
		}
		try {
			if (this.#customFooter) this.setFooter(this.#customFooter.factory);
		} catch (error) {
			this.#notify(String(error), "error");
		}
		this.#themeChanged(theme, selection);
		this.#tui.invalidate();
		this.#tui.requestRender();
		return { success: true };
	}
	onTerminalInput(handler: Parameters<ApplicationUI["onTerminalInput"]>[0]): () => void {
		this.#assertOpen();
		const remove = this.#tui.addInputListener(handler);
		const cleanup = () => {
			remove();
			this.#inputs.delete(cleanup);
		};
		this.#inputs.add(cleanup);
		return cleanup;
	}
	#releaseUnused(component: UIComponent | undefined): void {
		if (
			component &&
			component !== this.#customHeader?.component &&
			component !== this.#customFooter?.component &&
			![...this.#components.values()].some((widget) => widget.component === component)
		)
			this.#release(component);
	}
	#checkComponent(component: UIComponent): void {
		if (!component || typeof component.render !== "function" || typeof component.invalidate !== "function")
			throw new Error("UI factory must return a component");
	}
	setHeader(factory: UIFactory | undefined): void {
		this.#assertOpen();
		const next = factory?.(this.#tui, this.#theme);
		if (next !== undefined) this.#checkComponent(next);
		const previous = this.#customHeader?.component;
		this.#customHeader = factory && next ? { factory, component: next } : undefined;
		this.#header.clear();
		this.#header.addChild(next ?? this.#defaultHeader);
		this.#releaseUnused(previous);
		this.#tui.requestRender();
	}
	setFooter(factory: FooterFactory | undefined): void {
		this.#assertOpen();
		const next = factory?.(this.#tui, this.#theme, this.#footerData);
		if (next !== undefined) this.#checkComponent(next);
		const previous = this.#customFooter?.component;
		this.#customFooter = factory && next ? { factory, component: next } : undefined;
		this.#footer.clear();
		this.#footer.addChild(next ?? this.#defaultFooter);
		this.#releaseUnused(previous);
		this.#tui.requestRender();
	}
	get activeEditor(): ApplicationEditor {
		return this.#editor;
	}
	setAutocompleteProvider(provider: AutocompleteProvider): void {
		this.#assertOpen();
		const wrapped = this.#wrapAutocomplete(provider, this.#autocompleteFactories.values());
		this.#editor.setAutocompleteProvider(wrapped);
		this.#baseAutocomplete = provider;
		this.#autocomplete = wrapped;
	}
	#wrapAutocomplete(
		base: AutocompleteProvider,
		factories: Iterable<AutocompleteProviderFactory>,
	): AutocompleteProvider {
		let provider = base;
		const triggers = new Set(base.triggerCharacters);
		for (const factory of factories) {
			provider = factory(provider);
			if (!provider || typeof provider.getSuggestions !== "function" || typeof provider.applyCompletion !== "function")
				throw new Error("Autocomplete factory must return a provider");
			for (const trigger of provider.triggerCharacters ?? []) triggers.add(trigger);
		}
		const final = provider;
		return {
			triggerCharacters: [...triggers],
			getSuggestions: (...args) => final.getSuggestions(...args),
			applyCompletion: (...args) => final.applyCompletion(...args),
			shouldTriggerFileCompletion: final.shouldTriggerFileCompletion?.bind(final),
		};
	}
	addAutocompleteProvider(factory: AutocompleteProviderFactory): () => void {
		this.#assertOpen();
		const base = this.#baseAutocomplete;
		if (!base) throw new Error("Autocomplete is not ready");
		const key = Symbol();
		const next = new Map(this.#autocompleteFactories).set(key, factory);
		const wrapped = this.#wrapAutocomplete(base, next.values());
		this.#editor.setAutocompleteProvider(wrapped);
		this.#autocompleteFactories.set(key, factory);
		this.#autocomplete = wrapped;
		return () => {
			if (this.#disposed || !this.#autocompleteFactories.has(key)) return;
			const next = new Map(this.#autocompleteFactories);
			next.delete(key);
			const wrapped = this.#wrapAutocomplete(this.#baseAutocomplete ?? base, next.values());
			this.#editor.setAutocompleteProvider(wrapped);
			this.#autocompleteFactories.delete(key);
			this.#autocomplete = wrapped;
		};
	}
	getEditorComponent(): EditorFactory | undefined {
		this.#assertOpen();
		return this.#editorFactory;
	}
	setEditorComponent(factory: EditorFactory | undefined): void {
		this.#assertOpen();
		const previous = this.#editor;
		const next = factory ? factory(this.#tui, this.#editorTheme, getKeybindings()) : this.#defaultEditor;
		if (next === previous) {
			this.#editorFactory = factory;
			return;
		}
		try {
			next.setText(previous.getExpandedText());
			next.onSubmit = this.#defaultEditor.onSubmit;
			next.onChange = this.#defaultEditor.onChange;
			if (this.#autocomplete) next.setAutocompleteProvider(this.#autocomplete);
		} catch (error) {
			if (next !== this.#defaultEditor) this.#release(next);
			throw error;
		}
		this.#editor = next;
		this.#editorFactory = factory;
		this.#mount();
		if (previous !== this.#defaultEditor) this.#release(previous);
	}

	async copyText(text: string): Promise<void> {
		this.#assertOpen();
		await copyText(text, (data) => this.#tui.terminal.write(data));
	}
	get supported(): boolean {
		return !this.#disposed;
	}
	get hasDialogs(): boolean {
		return this.#dialogs.length > 0;
	}
	#release(component: Component): void {
		try {
			if ("dispose" in component && typeof component.dispose === "function") component.dispose();
		} catch (error) {
			try {
				this.#notify(error instanceof Error ? error.message : String(error), "error");
			} catch {}
		}
	}

	#assertOpen(): void {
		if (this.#disposed) throw new Error("The interactive UI is closed");
	}
	#mount(): void {
		const view = this.#dialogs.findLast((dialog) => dialog.view.kind === "ready")?.view;
		const front = this.#dialogs.findLast((dialog) => dialog.view.kind !== "building")?.view;
		const component = view?.kind === "ready" ? view.component : this.#editor;
		this.#dock.clear();
		this.#dock.addChild(component);
		if (front?.kind !== "overlay") this.#tui.setFocus(component);
		this.#tui.requestRender();
	}
	#remove(dialog: Dialog): void {
		const index = this.#dialogs.indexOf(dialog);
		if (index < 0) return;
		this.#dialogs.splice(index, 1);
		if (dialog.view.kind === "overlay") dialog.view.handle.hide();
		if (dialog.view.kind !== "building") this.#release(dialog.view.component);
		this.#mount();
	}
	#open<T>(
		factory: (done: (value: T) => void) => UIComponent | Promise<UIComponent>,
		cancelled: () => T,
		options?: CustomUIOptions,
		dismiss?: UIDialogOptions,
		countdown?: (seconds: number) => void,
	): Promise<T> {
		if (this.#disposed) return Promise.reject(new Error("The interactive UI is closed"));
		return new Promise<T>((resolve, reject) => {
			let settled = false;
			let timer: ReturnType<typeof setInterval> | undefined;
			const cleanup = () => {
				if (timer !== undefined) clearInterval(timer);
				dismiss?.signal?.removeEventListener("abort", cancel);
			};
			const finish = (value: T) => {
				if (settled) return;
				settled = true;
				cleanup();
				this.#remove(dialog);
				resolve(value);
			};
			const cancel = () => {
				if (settled) return;
				try {
					finish(cancelled());
				} catch (error) {
					settled = true;
					cleanup();
					this.#remove(dialog);
					reject(error);
				}
			};
			const dialog: Dialog = { view: { kind: "building" }, cancel };
			this.#dialogs.push(dialog);
			const mount = (component: UIComponent) => {
				if (settled) {
					this.#release(component);
					return;
				}
				dialog.view = { kind: "ready", component };
				this.#checkComponent(component);
				if (options?.overlay) {
					const placement =
						typeof options.overlayOptions === "function" ? options.overlayOptions() : options.overlayOptions;
					const fallback =
						"width" in component && typeof component.width === "number" ? { width: component.width } : undefined;
					const handle = this.#tui.showOverlay(component, placement ?? fallback);
					dialog.view = { kind: "overlay", component, handle };
					options.onHandle?.(handle);
				}
				if (!settled) this.#mount();
			};
			const fail = (error: unknown) => {
				if (settled) return;
				settled = true;
				cleanup();
				this.#remove(dialog);
				reject(error);
			};
			try {
				if (dismiss?.signal?.aborted) {
					cancel();
					return;
				}
				dismiss?.signal?.addEventListener("abort", cancel, { once: true });
				if (dismiss?.timeout && dismiss.timeout > 0) {
					let seconds = Math.ceil(dismiss.timeout / 1000);
					countdown?.(seconds);
					timer = setInterval(() => {
						countdown?.(--seconds);
						if (seconds <= 0) cancel();
						else this.#tui.requestRender();
					}, 1000);
				}
				const component = factory(finish);
				if (component instanceof Promise) void component.then(mount).catch(fail);
				else mount(component);
			} catch (error) {
				fail(error);
			}
		});
	}
	select(title: string, items: readonly UIItem[], options?: UISelectOptions): Promise<string | undefined> {
		const heading = new Text(this.#editorTheme.selectList.selectedText(plainText(title)), 1, 0);
		return this.#open<string | undefined>(
			(done) =>
				new SelectionDialog(
					heading,
					items,
					Math.max(2, Math.min(8, this.#tui.terminal.rows - 12)),
					done,
					() => done(undefined),
					options?.initialSearch,
					this.#editorTheme.selectList,
					options?.initialValue,
				),
			() => undefined,
			undefined,
			options,
			(seconds) => heading.setText(this.#editorTheme.selectList.selectedText(`${plainText(title)} (${seconds}s)`)),
		);
	}
	sessions(request: SessionPickerRequest): Promise<string | undefined> {
		return this.#open<string | undefined>(
			(done) =>
				new SessionSelector(
					request,
					done,
					() => this.#tui.requestRender(),
					this.#editorTheme.selectList,
					Math.max(4, Math.floor(this.#tui.terminal.rows / 3)),
				),
			() => undefined,
		);
	}

	tree(
		items: readonly NavigationItem[],
		options: { initialValue?: string; filter: TreeFilter },
	): Promise<TreeSelection> {
		return this.#open<TreeSelection>(
			(done) =>
				new TreeSelector(
					items,
					{ ...options, limit: Math.max(5, Math.floor(this.#tui.terminal.rows / 2)), theme: this.#theme },
					done,
					(text) => this.copyText(text),
					this.#editorTheme.selectList,
				),
			() => ({ action: "cancel", filter: options.filter }),
		);
	}
	async confirm(title: string, message: string, options?: UIDialogOptions): Promise<boolean> {
		return (
			(await this.select(
				`${title}\n${message}`,
				[
					{ value: "yes", label: "Yes" },
					{ value: "no", label: "No" },
				],
				options,
			)) === "yes"
		);
	}
	input(
		title: string,
		initial = "",
		options?: UIDialogOptions & { readonly secret?: boolean },
	): Promise<string | undefined> {
		const heading = new Text(chalk.bold.cyan(plainText(title)), 1, 0);
		return this.#open<string | undefined>(
			(done) => new TextDialog(heading, initial, done, options?.secret),
			() => undefined,
			undefined,
			options,
			(seconds) => heading.setText(chalk.bold.cyan(`${plainText(title)} (${seconds}s)`)),
		);
	}
	editor(title: string, initial = ""): Promise<string | undefined> {
		return this.#open<string | undefined>(
			(done) => new MultilineDialog(this.#tui, this.#editorTheme, title, initial, done),
			() => undefined,
		);
	}
	pasteToEditor(text: string): void {
		this.#assertOpen();
		this.#editor.handleInput(`\x1b[200~${plainText(text)}\x1b[201~`);
		this.#tui.requestRender();
	}

	custom<T>(factory: CustomUIFactory<T>, options?: CustomUIOptions): Promise<T> {
		return this.#open<T>(
			(done) => factory(this.#tui, this.#theme, getKeybindings(), done),
			() => {
				const error = new Error("The UI dialog was cancelled");
				error.name = "AbortError";
				throw error;
			},
			options,
		);
	}
	cancelDialog(): boolean {
		const dialog = this.#dialogs.at(-1);
		if (!dialog) return false;
		dialog.cancel();
		return true;
	}
	escapeDialog(data: string): void {
		const view = this.#dialogs.at(-1)?.view;
		if (view?.kind === "ready" && (view.component instanceof TreeSelector || view.component instanceof SessionSelector))
			view.component.handleInput(data);
		else this.cancelDialog();
		this.#tui.requestRender();
	}
	notify(message: string, kind: UINotificationKind = "info"): void {
		this.#assertOpen();
		this.#notify(plainText(message), kind);
	}
	getEditorText(): string {
		this.#assertOpen();
		return this.#editor.getExpandedText();
	}
	setEditorText(text: string): void {
		this.#assertOpen();
		this.#editor.setText(plainText(text));
		this.#tui.requestRender();
	}
	setStatus(key: string, text?: string): void {
		this.#assertOpen();
		if (text === undefined) this.#statuses.delete(key);
		else this.#statuses.set(key, plainText(text));
		this.#status.clear();
		for (const value of this.#statuses.values()) this.#status.addChild(new Text(chalk.dim(value), 1, 0));
		this.#tui.requestRender();
	}
	setWidget(key: string, content?: WidgetContent, options: { placement?: "aboveEditor" | "belowEditor" } = {}): void {
		this.#assertOpen();
		const previous = this.#components.get(key)?.component;
		const component =
			typeof content === "function"
				? content(this.#tui, this.#theme)
				: content === undefined
					? undefined
					: "render" in content
						? content
						: new Text(content.map(plainText).join("\n"), 1, 0);
		if (component !== undefined) this.#checkComponent(component);
		if (content === undefined || component === undefined) this.#components.delete(key);
		else this.#components.set(key, { content, component, placement: options.placement ?? "aboveEditor" });
		this.#widgets.clear();
		this.#belowWidgets.clear();
		for (const value of this.#components.values())
			(value.placement === "aboveEditor" ? this.#widgets : this.#belowWidgets).addChild(value.component);
		this.#releaseUnused(previous);
		this.#tui.requestRender();
	}
	setTitle(title: string): void {
		this.#assertOpen();
		if (!this.#savedTitle) {
			this.#tui.terminal.write("\x1b[22;0t");
			this.#savedTitle = true;
		}
		this.#tui.terminal.setTitle(plainText(title).replace(/\n/g, " "));
	}
	dispose(): void {
		if (this.#disposed) return;
		this.#disposed = true;
		if (this.#baseAutocomplete) this.#defaultEditor.setAutocompleteProvider(this.#baseAutocomplete);
		this.#autocompleteFactories.clear();
		this.#autocomplete = undefined;
		this.#baseAutocomplete = undefined;
		for (const dialog of [...this.#dialogs].reverse()) dialog.cancel();
		this.#status.clear();
		this.#widgets.clear();
		this.#belowWidgets.clear();
		this.#statuses.clear();
		if (this.#editor !== this.#defaultEditor) this.#release(this.#editor);
		for (const remove of this.#inputs) remove();
		const components = new Set([...this.#components.values()].map((widget) => widget.component));
		if (this.#customHeader) components.add(this.#customHeader.component);
		if (this.#customFooter) components.add(this.#customFooter.component);
		for (const component of components) this.#release(component);
		this.#header.clear();
		this.#header.addChild(this.#defaultHeader);
		this.#footer.clear();
		this.#footer.addChild(this.#defaultFooter);
		this.#components.clear();
		if (this.#savedTitle) this.#tui.terminal.write("\x1b[23;0t");
	}
}
