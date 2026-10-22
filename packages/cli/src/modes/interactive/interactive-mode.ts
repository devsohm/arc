import { plainText, linkifyUrls } from "../../core/ui/text.ts";
import type { ImageContent } from "@arc/ai";
import { getSupportedThinkingLevels } from "@arc/ai";
import {
	CombinedAutocompleteProvider,
	Container,
	Loader,
	type LoaderIndicatorOptions,
	ProcessTerminal,
	ScrollView,
	SettingsList,
	type SettingItem,
	Spacer,
	Text,
	VStack,
	getKeybindings,
	isKeyRelease,
	isKeyRepeat,
	matchesKey,
	setKeybindings,
	type Component,
	type SelectItem,
	type Terminal,
} from "@arc/tui";
import { GitBranch } from "../../core/ui/git-branch.ts";
import type { Theme } from "../../core/ui/theme.ts";
import { watch, type FSWatcher } from "node:fs";
import { basename, dirname } from "node:path";
import type { Application } from "../../core/types.ts";
import {
	Transcript,
	footerLines,
	queueText,
	selectColors,
	statusText,
	shortcut,
	taskGraphText,
	type DisplayOptions,
} from "./components.ts";
import { APP_KEYBINDINGS, loadKeybindings, blocksExtensionShortcut } from "../../core/configuration/keybindings.ts";
import { copyText, readClipboard, type ClipboardContent } from "./clipboard.ts";
import { ModelScopeSelector } from "./model-scope.ts";
import { AgentEditor } from "./editor.ts";
import { resolveModelScope } from "../../core/providers/model-scope.ts";
import { InteractiveUI } from "./ui.ts";
import { InteractiveRenderer } from "./tui-renderer.ts";
import { builtinRenderer } from "./renderers/index.ts";

export async function runInteractive(
	app: Application,
	options: {
		readonly terminal?: Terminal;
		readonly fullscreen?: boolean;
		readonly signal?: AbortSignal;
		readonly readClipboard?: (signal: AbortSignal) => Promise<ClipboardContent | undefined>;
	} = {},
): Promise<void> {
	if (options.signal?.aborted) return;
	let bindings = await loadKeybindings(app.home);
	const previousBindings = getKeybindings();
	const terminal = options.terminal ?? new ProcessTerminal();
	const renderer = new InteractiveRenderer(terminal, options.fullscreen ?? false, {
		onRightClickPaste: () => pasteClipboard(),
		copySelection: async (text) => {
			try {
				await copyText(text, (data) => terminal.write(data));
				return true;
			} catch (error) {
				return error instanceof Error ? error.message : String(error);
			}
		},
	});
	const tui = renderer.ui;
	let state = await app.snapshot();
	let themeSetting = state.settings?.theme;
	let themeSelection: string | Theme = themeSetting ?? "system";
	let appearance: "dark" | "light" = "dark";
	let activeTheme = app.themes.resolve(themeSetting);
	const selectTheme = selectColors(() => activeTheme);
	const transcript = new Transcript(
		(name) => {
			const defaults = builtinRenderer(name, (input) => app.previewEdit(input)),
				custom = app.toolRenderers(name, () => defaults);
			return custom;
		},
		() => tui.requestRender(),
		(error) => {
			queueMicrotask(() => {
				if (!closed) report(`Renderer failed: ${error instanceof Error ? error.message : String(error)}`, true);
			});
		},
		app,
		() => preserveViewport(),
	);
	const queue = new Text("", 1, 0);
	const status = new Container();
	const statusMessage = new Text("", 1, 0);
	let workingLoader: Loader | undefined;
	let workingMessage: string | undefined;
	let workingVisible = true;
	let workingIndicator: LoaderIndicatorOptions | undefined;
	const tasks = new Text("", 1, 0);
	const feedback = new Text("", 1, 0);
	const editorDock = new Container();
	const extensionStatus = new Container();
	const extensionWidgets = new Container();
	const belowWidgets = new Container();
	const headerDock = new Container();
	const footerDock = new Container();
	const editorTheme = {
		borderColor: (text: string) => activeTheme.getThinkingBorderColor(state.agent.thinkingLevel ?? "off")(text),
		selectList: selectTheme,
	};
	const editor = new AgentEditor(tui, editorTheme, { paddingX: 1 });
	let screenSetting = state.settings?.fullscreen;
	let screenRevision = state.fullscreenRevision;
	let availableModels = await app.models.getAvailable(undefined, { signal: options.signal });
	let display: DisplayOptions = { toolsExpanded: false, thinkingVisible: false, theme: activeTheme, cwd: app.cwd };
	let attachments: ImageContent[] = [];
	let running = false;
	let closed = false;
	let repaintTimer: ReturnType<typeof setTimeout> | undefined;
	const done = Promise.withResolvers<void>();
	const clipboardAbort = new AbortController();
	let watchedTheme: string | undefined;
	let themeWatcher: FSWatcher | undefined;
	let themeTimer: ReturnType<typeof setTimeout> | undefined;
	let themeReload = Promise.resolve();
	function watchThemeFile(): void {
		const path = activeTheme.sourcePath;
		if (path === watchedTheme) return;
		themeWatcher?.close();
		themeWatcher = undefined;
		watchedTheme = path;
		if (!path) return;
		try {
			themeWatcher = watch(dirname(path), { persistent: false }, (_event, file) => {
				if (file && file.toString() !== basename(path)) return;
				clearTimeout(themeTimer);
				themeTimer = setTimeout(() => {
					themeReload = themeReload
						.then(async () => {
							if (closed || activeTheme.sourcePath !== path) return;
							await app.themes.reload();
							if (closed) return;
							const result = ui.setTheme(themeSelection);
							if (!result.success) throw new Error(result.error);
						})
						.catch((error) => {
							if (!closed) report(error instanceof Error ? error.message : String(error), true);
						});
				}, 80);
			});
			themeWatcher.on("error", (error) => {
				themeWatcher?.close();
				themeWatcher = undefined;
				watchedTheme = undefined;
				if (!closed) report(error.message, true);
			});
		} catch (error) {
			watchedTheme = undefined;
			report(error instanceof Error ? error.message : String(error), true);
		}
	}
	const branch = await GitBranch.open(app.cwd);
	const unsubscribeBranch = branch.subscribe(() => tui.requestRender());
	let subscription = false;
	let authGeneration = 0;
	let authProvider: string | undefined;
	const updateAuth = (force = false) => {
		const provider = state.agent.model?.provider;
		if (!force && provider === authProvider) return;
		authProvider = provider;
		subscription = provider === "kimi-coding";
		const generation = ++authGeneration;
		if (provider)
			void app.models
				.checkAuth(provider, { signal: clipboardAbort.signal })
				.then((auth) => {
					if (!closed && generation === authGeneration) {
						subscription = auth?.type === "oauth" || provider === "kimi-coding";
						tui.requestRender();
					}
				})
				.catch(() => {});
	};
	const footer: Component = {
		render: (width) =>
			footerLines(
				state,
				width,
				state.agent.model ? app.models.getModel(state.agent.model.provider, state.agent.model.modelId) : undefined,
				availableModels.length ? new Set(availableModels.map((model) => model.provider)).size : 1,
				{ branch: branch.value, subscription },
			).map((line) => activeTheme.fg("muted", line)),
		invalidate() {},
	};
	const document = new Container();
	const header: Component = {
		render: (width) =>
			new Text(
				activeTheme.bold(activeTheme.fg("accent", "Arc")) +
					activeTheme.fg(
						"muted",
						` · /help for commands\n${shortcut("tui.input.submit", "Enter")} send · ${shortcut("tui.input.newLine", "Shift+Enter")} newline · ${shortcut("app.exit", "Ctrl+D")} exit · ${shortcut("app.tools.expand", "Ctrl+O")} tools · ${shortcut("app.thinking.toggle", "Ctrl+T")} thinking`,
					),
				1,
				0,
			).render(width),
		invalidate() {},
	};
	headerDock.addChild(header);
	footerDock.addChild(footer);
	document.addChild(headerDock);
	document.addChild(new Spacer(1));
	document.addChild(transcript);
	document.addChild(feedback);
	document.addChild(new Spacer(1));
	editorDock.addChild(editor);
	for (const component of [
		document,
		queue,
		status,
		tasks,
		extensionWidgets,
		editorDock,
		belowWidgets,
		extensionStatus,
		footerDock,
	])
		tui.addChild(component);
	const scroll = new ScrollView(document, { primary: true, follow: "end", overscroll: "chain" });
	const preserveViewport = () => {
		if (tui.mode === "fullscreen") scroll.scrollTo(scroll.scrollTop, { disableFollow: true });
	};
	{
		renderer.setLayoutRoot(
			new VStack([
				{ component: scroll, basis: 0, grow: 1, shrink: 1, minSize: 1 },
				{ component: queue, shrink: 1, minSize: 0 },
				{ component: status, shrink: 1, minSize: 0 },
				{ component: tasks, shrink: 1, minSize: 0 },
				{ component: extensionWidgets, shrink: 1, minSize: 0 },
				{ component: editorDock, shrink: 1, minSize: 3 },
				{ component: belowWidgets, shrink: 1, minSize: 0 },
				{ component: extensionStatus, shrink: 1, minSize: 0 },
				{ component: footerDock, shrink: 1, minSize: 0 },
			]),
		);
	}

	const repaint = () => {
		if (closed) return;
		editor.setPaddingX(state.settings?.editorPaddingX ?? 1);
		editor.setAutocompleteMaxVisible(state.settings?.autocompleteMaxVisible ?? 5);
		tui.setShowHardwareCursor(state.settings?.showHardwareCursor ?? false);
		tui.setClearOnShrink(state.settings?.clearOnShrink ?? false);
		display = {
			...display,
			mermaid: state.settings?.markdown?.mermaid,
			codeBlockIndent: state.settings?.markdown?.codeBlockIndent,
		};
		if (state.settings?.theme !== themeSetting) {
			themeSetting = state.settings?.theme;
			const result = ui.setTheme(themeSetting ?? "system");
			if (!result.success) feedback.setText(activeTheme.fg("error", result.error ?? "Theme could not be selected"));
		}
		if (state.settings?.fullscreen !== screenSetting || state.fullscreenRevision !== screenRevision) {
			screenSetting = state.settings?.fullscreen;
			screenRevision = state.fullscreenRevision;
			try {
				renderer.switchMode(screenSetting ?? false);
			} catch (error) {
				feedback.setText(activeTheme.fg("error", error instanceof Error ? error.message : String(error)));
			}
		}
		transcript.update(state, { ...display, markdownTransformers: app.markdownTransformers() });
		const taskText = [
			taskGraphText(state.tasks),
			attachments.length ? `${attachments.length} attached image${attachments.length === 1 ? "" : "s"}` : "",
		]
			.filter(Boolean)
			.join("\n");
		tasks.setText(taskText ? activeTheme.fg("muted", taskText) : "");
		const queued = queueText(state);
		queue.setText(queued ? activeTheme.fg("warning", queued) : "");
		const working =
			(state.busy || running) &&
			!state.live.generation?.retry &&
			!state.live.compactionFailure &&
			!state.live.compactions?.length;
		status.clear();
		if (working && workingVisible) {
			const message = plainText(workingMessage ?? (statusText(state) || "Working · Ctrl+C to abort"));
			if (!workingLoader)
				workingLoader = new Loader(
					tui,
					(text) => activeTheme.fg("accent", text),
					(text) => activeTheme.fg("muted", text),
					message,
					workingIndicator,
				);
			else workingLoader.setMessage(message);
			if (ui.activeEditor === editor) editor.setWorking(workingLoader);
			else {
				editor.setWorking(undefined);
				status.addChild(workingLoader);
			}
		} else {
			editor.setWorking(undefined);
			workingLoader?.stop();
			workingLoader = undefined;
			const idleStatus = working ? "" : statusText(state);
			statusMessage.setText(idleStatus ? activeTheme.fg("muted", idleStatus) : "");
			status.addChild(statusMessage);
		}
		terminal.setProgress(state.settings?.showTerminalProgress !== false && (state.busy || running));
		tui.requestRender();
	};
	const report = (text: string, error: boolean | "warning" = false) => {
		feedback.setText(activeTheme.fg(error === "warning" ? "warning" : error ? "error" : "accent", linkifyUrls(text)));
		repaint();
	};
	const ui = new InteractiveUI({
		editor,
		editorTheme,
		dock: editorDock,
		status: extensionStatus,
		widgets: extensionWidgets,
		belowWidgets,
		header: headerDock,
		footer: footerDock,
		defaultHeader: header,
		defaultFooter: footer,
		footerData: {
			getState: () => state,
			getGitBranch: () => branch.value,
			getAvailableProviderCount: () => new Set(availableModels.map((model) => model.provider)).size,
			onBranchChange: (listener) => branch.subscribe(listener),
		},
		themes: app.themes,
		theme: activeTheme,
		appearance: () => appearance,
		toolExpansion: {
			getToolsExpanded: () => display.toolsExpanded,
			setToolsExpanded: (expanded) => {
				if (expanded === display.toolsExpanded) return;
				preserveViewport();
				display = { ...display, toolsExpanded: expanded };
				repaint();
			},
		},
		presentation: {
			setWorkingMessage: (message) => {
				workingMessage = message;
				repaint();
			},
			setWorkingVisible: (visible) => {
				workingVisible = visible;
				repaint();
			},
			setWorkingIndicator: (indicator) => {
				workingIndicator = indicator && { ...indicator, frames: indicator.frames && [...indicator.frames] };
				workingLoader?.setIndicator(workingIndicator);
				repaint();
			},
			setHiddenThinkingLabel: (label) => {
				display = { ...display, hiddenThinkingLabel: label };
				repaint();
			},
		},
		themeChanged: (theme, selection) => {
			activeTheme = theme;
			themeSelection = selection;
			display = { ...display, theme };
			watchThemeFile();
			repaint();
		},
		tui,
		notify: (text, kind) => report(text, kind === "warning" ? "warning" : kind === "error"),
	});
	const act = (operation: () => Promise<void>) => {
		void (async () => {
			try {
				await operation();
				if (!closed) {
					state = await app.snapshot();
					repaint();
				}
			} catch (error) {
				if (!closed && !(error instanceof Error && error.name === "AbortError"))
					report(error instanceof Error ? error.message : String(error), true);
			}
		})();
	};
	const pasteClipboard = () => {
		act(async () => {
			if (ui.hasDialogs) return;
			const value = await (options.readClipboard ?? readClipboard)(clipboardAbort.signal);
			if (closed) return;
			if (value?.type === "image") attachments.push(value.image);
			else if (value?.type === "text") ui.pasteToEditor(value.text);
			else report("Clipboard contains no supported image or text.");
		});
	};
	const command = async (input: string) => {
		const overridden = app.hasCommandOverride(input.slice(1).split(/\s/, 1)[0] ?? "");
		if (input === "/hotkeys" && !app.hasCommandOverride("hotkeys")) {
			report(
				Object.entries(APP_KEYBINDINGS)
					.map(([id, definition]) => `${bindings.getResolvedBindings()[id] || "unbound"}: ${definition.description}`)
					.join("\n"),
			);
			return;
		}
		const conversationId = app.conversation.id;
		const result = await app.command(input);
		if (closed) return;
		const screenMode = overridden ? null : /^\/settings\s+fullscreen\s+(true|false)$/.exec(input);
		if (screenMode) renderer.switchMode(screenMode[1] === "true");
		if (app.conversation.id !== conversationId) attachments = [];
		if (input === "/reload" && !overridden) {
			const next = await loadKeybindings(app.home);
			bindings = next;
			setKeybindings(bindings);
			transcript.dispose();
			tui.invalidate();
			const result = ui.setTheme(themeSelection);
			if (!result.success) report(result.error ?? "Theme reload failed", true);
		}
		if (!overridden && /^\/(?:login|logout|reload)(?:\s|$)/.test(input)) {
			availableModels = await app.models.getAvailable(undefined, { signal: options.signal });
			updateAuth(true);
		}
		if (result.message) report(result.message);
		if (result.editorText !== undefined) ui.setEditorText(result.editorText);
		updateAutocomplete();
		if (result.quit) done.resolve();
	};
	const modelItems = (): SelectItem[] =>
		availableModels.map((model) => ({
			value: `${model.provider}/${model.id}`,
			label: plainText(`${model.provider}/${model.id}`),
			description: plainText(model.name),
		}));
	const thinkingItems = (): SelectItem[] => {
		const ref = state.agent.model;
		const model = ref ? app.models.getModel(ref.provider, ref.modelId) : undefined;
		return (model ? getSupportedThinkingLevels(model) : ["off"]).map((level) => ({
			value: level,
			label: level,
			description: level === state.agent.thinkingLevel ? "Current" : undefined,
		}));
	};
	const select = (name: "model" | "thinking", search = "") => {
		act(async () => {
			if (name === "model") availableModels = await app.models.getAvailable(undefined, { signal: options.signal });
			updateAuth(true);
			const items = name === "model" ? modelItems() : thinkingItems();
			if (!items.length) {
				report("No models are configured. Use /login to add a provider.");
				return;
			}
			const value = await ui.select(`Select ${name}`, items, { initialSearch: search });
			if (value !== undefined) await command(`/${name} ${value}`);
		});
	};
	const send = (text: string, followUp = false) => {
		const input = text.trim();
		if (!input && !attachments.length) return;
		scroll.scrollToEnd();
		ui.activeEditor.addToHistory(input);
		feedback.setText("");
		if (input === "/settings" && !app.hasCommandOverride("settings")) {
			act(async () => {
				const items: SettingItem[] = [
					{
						id: "codemode",
						label: "Code Mode",
						description: "Let the model compose tool calls in JavaScript. Independent of MCP.",
						currentValue: String(state.settings?.codemode ?? true),
						values: ["true", "false"],
					},
					{
						id: "retry",
						label: "Retry transient provider errors",
						currentValue: String(state.settings?.retry?.enabled ?? true),
						values: ["true", "false"],
					},
					{
						id: "treeFilterMode",
						label: "Tree filter mode",
						currentValue: state.settings?.treeFilterMode ?? "default",
						values: ["default", "no-tools", "user-only", "labeled-only", "all"],
					},
					{
						id: "branchSummarySkipPrompt",
						label: "Skip branch summary prompt",
						currentValue: String(state.settings?.branchSummarySkipPrompt ?? false),
						values: ["false", "true"],
					},
					{
						id: "toolExecution",
						label: "Tool execution",
						currentValue: state.settings?.toolExecution ?? "parallel",
						values: ["parallel", "sequential"],
					},
					{
						id: "autoCompact",
						label: "Automatic compaction",
						currentValue: String(state.settings?.compaction?.enabled ?? true),
						values: ["true", "false"],
					},
					{
						id: "steeringMode",
						label: "Steering delivery",
						currentValue: state.settings?.steeringMode ?? "one-at-a-time",
						values: ["one-at-a-time", "all"],
					},
					{
						id: "followUpMode",
						label: "Follow-up delivery",
						currentValue: state.settings?.followUpMode ?? "one-at-a-time",
						values: ["one-at-a-time", "all"],
					},
					{
						id: "fullscreen",
						label: "Fullscreen",
						description: "Switch between terminal scrollback and a fullscreen viewport",
						currentValue: String(state.settings?.fullscreen ?? false),
						values: ["false", "true"],
					},
					{
						id: "theme",
						label: "Theme",
						currentValue: typeof themeSelection === "string" ? themeSelection : activeTheme.name,
						values: app.themes.all().map((theme) => theme.name),
					},
					{
						id: "mermaid",
						label: "Mermaid diagrams",
						currentValue: state.settings?.markdown?.mermaid ?? "streaming",
						values: ["streaming", "final", "off"],
					},
					{
						id: "thinking",
						label: "Thinking level",
						currentValue: state.agent.thinkingLevel ?? "off",
						values: thinkingItems().map((item) => item.value),
					},
					{
						id: "thinkingVisible",
						label: "Show thinking",
						currentValue: String(display.thinkingVisible),
						values: ["false", "true"],
					},
					{
						id: "toolsExpanded",
						label: "Expand tools",
						currentValue: String(display.toolsExpanded),
						values: ["false", "true"],
					},
					{
						id: "cacheWarming",
						label: "Prompt cache warming",
						currentValue: state.settings?.cacheWarming ?? "streaming",
						values: ["off", "streaming", "idle"],
					},
					{
						id: "editorPaddingX",
						label: "Editor padding",
						currentValue: String(state.settings?.editorPaddingX ?? 1),
						values: ["0", "1", "2", "3"],
					},
					{
						id: "autocompleteMaxVisible",
						label: "Autocomplete max items",
						currentValue: String(state.settings?.autocompleteMaxVisible ?? 5),
						values: ["3", "5", "8", "10", "15", "20"],
					},
					{
						id: "showHardwareCursor",
						label: "Show hardware cursor",
						currentValue: String(state.settings?.showHardwareCursor ?? false),
						values: ["false", "true"],
					},
					{
						id: "clearOnShrink",
						label: "Clear on shrink",
						currentValue: String(state.settings?.clearOnShrink ?? false),
						values: ["false", "true"],
					},
					{
						id: "showTerminalProgress",
						label: "Terminal progress",
						currentValue: String(state.settings?.showTerminalProgress ?? true),
						values: ["true", "false"],
					},
				];
				const applied = new Map(items.map((item) => [item.id, item.currentValue]));
				let pending = Promise.resolve();
				await ui.custom<void>((_tui, _theme, _keybindings, finish) => {
					const list = new SettingsList(
						items,
						8,
						{
							label: (text, selected) => activeTheme.fg(selected ? "accent" : "text", text),
							value: (text) => activeTheme.fg("warning", text),
							description: (text) => activeTheme.fg("muted", text),
							cursor: "→ ",
							hint: (text) => activeTheme.fg("muted", text),
						},
						(id, value) => {
							pending = pending.then(async () => {
								try {
									if (id === "thinkingVisible") {
										preserveViewport();
										display = { ...display, thinkingVisible: value === "true" };
									} else if (id === "toolsExpanded") ui.setToolsExpanded(value === "true");
									else await command(id === "thinking" ? `/thinking ${value}` : `/settings ${id} ${value}`);
									applied.set(id, value);
									repaint();
								} catch (error) {
									list.updateValue(id, applied.get(id) ?? "");
									report(error instanceof Error ? error.message : String(error), true);
								}
							});
						},
						() => {
							void pending.then(() => finish());
						},
						{ enableSearch: true },
					);
					const panel = new Container();
					const border = {
						render: (width: number) => [activeTheme.fg("borderAccent", "─".repeat(width))],
						invalidate() {},
					};
					panel.addChild(border);
					panel.addChild(new Text(activeTheme.bold(activeTheme.fg("accent", "Settings")), 1, 1));
					panel.addChild(list);
					panel.addChild(new Spacer(1));
					panel.addChild(border);
					return Object.assign(panel, { handleInput: (data: string) => list.handleInput(data) });
				});
			});
			return;
		}
		if (input === "/scoped-models" && !app.hasCommandOverride("scoped-models")) {
			act(async () => {
				const available = await app.models.getAvailable();
				const scoped =
					state.enabledModels === undefined ? undefined : resolveModelScope(state.enabledModels, available).models;
				const scopeIds = scoped?.map(
					({ model, thinkingLevel }) => `${model.provider}/${model.id}${thinkingLevel ? `:${thinkingLevel}` : ""}`,
				);
				let pending = Promise.resolve();
				let selected: import("./model-scope.ts").ModelScopeResult;
				try {
					selected = await ui.custom<import("./model-scope.ts").ModelScopeResult>(
						(_tui, _theme, _keybindings, done) =>
							new ModelScopeSelector(
								available.map((model) => ({
									value:
										scopeIds?.[
											scoped?.findIndex(
												(entry) => entry.model.provider === model.provider && entry.model.id === model.id,
											) ?? -1
										] ?? `${model.provider}/${model.id}`,
									label: `${model.provider}/${model.id}`,
									description: model.name,
								})),
								scopeIds,
								done,
								(ids) => {
									pending = pending.then(() => command(`/scoped-models ${ids.join(",") || "none"}`));
									void pending.catch(() => {});
								},
								selectTheme,
							),
					);
				} finally {
					await pending;
				}
				await command(`/scoped-models ${selected.save ? "save " : ""}${selected.ids.join(",") || "none"}`);
			});
			return;
		}
		if (
			input.startsWith("/model ") &&
			!app.models.getModels().some((model) => `${model.provider}/${model.id}` === input.slice(7).trim())
		) {
			select("model", input.slice(7).trim());
			return;
		}
		if ((input === "/model" || input === "/thinking") && !app.hasCommandOverride(input.slice(1))) {
			select(input === "/model" ? "model" : "thinking");
			return;
		}
		if (input.startsWith("!")) {
			act(async () => {
				await app.executeBash(input.slice(input.startsWith("!!") ? 2 : 1), {
					excludeFromContext: input.startsWith("!!"),
				});
			});
			return;
		}
		const images = input.startsWith("/") ? [] : attachments.splice(0);
		const content = images.length ? [...(input ? [{ type: "text" as const, text: input }] : []), ...images] : input;
		repaint();
		act(async () => {
			try {
				if (input.startsWith("/")) await command(input);
				else if (state.busy || running) await app.submit(content, { whenBusy: followUp ? "followUp" : "steer" });
				else {
					running = true;
					repaint();
					try {
						const result = await app.run(content);
						if (result.status === "unanswered") report("Run ended without a complete answer.", true);
					} finally {
						running = false;
						repaint();
					}
				}
			} catch (error) {
				if (!closed && images.length) {
					attachments.unshift(...images);
					if (!ui.activeEditor.getText()) ui.activeEditor.setText(input);
				}
				throw error;
			}
		});
	};
	editor.onSubmit = (text) => send(text);
	const updateAutocomplete = () =>
		ui.setAutocompleteProvider(
			new CombinedAutocompleteProvider(
				app.commands().map((info) => ({
					...info,
					getArgumentCompletions:
						info.getArgumentCompletions ??
						(info.name === "model"
							? (prefix: string) =>
									modelItems().filter((item) => item.value.toLowerCase().includes(prefix.toLowerCase()))
							: info.name === "thinking"
								? (prefix: string) => thinkingItems().filter((item) => item.value.startsWith(prefix))
								: undefined),
				})),
				app.cwd,
			),
		);
	updateAutocomplete();
	const interrupt = () => {
		if (ui.cancelDialog()) return;
		if (state.busy || running)
			act(async () => {
				await app.abort();
			});
		else if (ui.activeEditor.getText() || attachments.length) {
			attachments = [];
			ui.activeEditor.setText("");
			repaint();
		} else done.resolve();
	};
	const exit = () => done.resolve();
	const removeInput = tui.addInputListener((data) => {
		if (isKeyRelease(data)) return;
		const extensionShortcut = !ui.hasDialogs && app.shortcuts().find((shortcut) => matchesKey(data, shortcut.key));
		if (extensionShortcut && !blocksExtensionShortcut(data, bindings)) {
			act(() => extensionShortcut.execute());
			return { consume: true };
		}
		if (
			!ui.hasDialogs &&
			(bindings.matches(data, "app.model.cycleForward") || bindings.matches(data, "app.model.cycleBackward"))
		) {
			act(async () => {
				const result = await app.cycleModel(bindings.matches(data, "app.model.cycleBackward") ? "backward" : "forward");
				if (result.message) report(result.message);
			});
		} else if (!ui.hasDialogs && bindings.matches(data, "app.model.select")) select("model");
		else if (!ui.hasDialogs && bindings.matches(data, "app.thinking.cycle")) {
			const levels = thinkingItems().map((item) => item.value);
			const next = levels[(levels.indexOf(state.agent.thinkingLevel ?? "off") + 1) % levels.length];
			if (next) act(() => command(`/thinking ${next}`));
		} else if (!ui.hasDialogs && bindings.matches(data, "app.clipboard.pasteImage")) {
			pasteClipboard();
		} else if (!ui.hasDialogs && bindings.matches(data, "app.message.copy")) act(() => command("/copy"));
		else if (!ui.hasDialogs && bindings.matches(data, "app.session.new")) act(() => command("/new"));
		else if (!ui.hasDialogs && bindings.matches(data, "app.session.tree")) act(() => command("/tree"));
		else if (!ui.hasDialogs && bindings.matches(data, "app.session.fork")) act(() => command("/fork"));
		else if (!ui.hasDialogs && bindings.matches(data, "app.session.resume")) act(() => command("/resume"));
		else if (bindings.matches(data, "app.clear")) interrupt();
		else if (!ui.hasDialogs && bindings.matches(data, "app.exit") && !ui.activeEditor.getText() && !attachments.length)
			exit();
		else if (bindings.matches(data, "app.tools.expand")) {
			if (!isKeyRepeat(data)) ui.setToolsExpanded(!ui.getToolsExpanded());
		} else if (bindings.matches(data, "app.thinking.toggle")) {
			if (isKeyRepeat(data)) return { consume: true };
			preserveViewport();
			display = { ...display, thinkingVisible: !display.thinkingVisible };
			repaint();
		} else if (!ui.hasDialogs && bindings.matches(data, "app.message.followUp")) {
			const text = ui.activeEditor.getExpandedText();
			ui.activeEditor.setText("");
			send(text, true);
		} else if (ui.hasDialogs && bindings.matches(data, "app.interrupt")) {
			ui.escapeDialog(data);
		} else if (
			!ui.hasDialogs &&
			bindings.matches(data, "app.interrupt") &&
			!ui.activeEditor.isShowingAutocomplete() &&
			(state.busy || running)
		) {
			act(async () => {
				await app.abort();
			});
		} else return;
		return { consume: true };
	});
	let detachUI: (() => Promise<void>) | undefined;
	let unsubscribe: (() => void) | undefined;
	let removeAppearance: (() => void) | undefined;
	let terminalStarted = false;
	try {
		setKeybindings(bindings);
		detachUI = app.attachUI(ui);
		unsubscribe = app.subscribe((next) => {
			state = next;
			updateAuth();
			if (!state.busy) {
				clearTimeout(repaintTimer);
				repaintTimer = undefined;
				repaint();
			} else if (!repaintTimer) {
				repaintTimer = setTimeout(() => {
					repaintTimer = undefined;
					repaint();
				}, 33);
			}
		});
		process.on("SIGINT", interrupt);
		process.on("SIGTERM", exit);
		process.on("SIGHUP", exit);
		options.signal?.addEventListener("abort", exit, { once: true });
		tui.setFocus(editor);
		terminalStarted = true;
		tui.start();
		watchThemeFile();
		updateAuth();
		const applyAppearance = () => {
			if (typeof themeSelection === "string" && (themeSelection === "system" || themeSelection.includes("/"))) {
				const result = ui.setTheme(themeSelection);
				if (!result.success) report(result.error ?? "Theme could not follow terminal appearance", true);
			}
		};
		const queryColors = () => {
			void tui
				.queryTerminalColors({
					timeoutMs: 100,
					onLateReply: (colors) => {
						if (!closed) {
							app.themes.setTerminalColors(colors);
							applyAppearance();
						}
					},
				})
				.then((colors) => {
					if (!closed) {
						app.themes.setTerminalColors(colors);
						appearance = app.themes.get("system")?.appearance ?? appearance;
						applyAppearance();
					}
				})
				.catch(() => {});
		};
		removeAppearance = tui.onTerminalColorSchemeChange((scheme) => {
			appearance = scheme;
			app.themes.beginTerminalColors(scheme);
			applyAppearance();
			queryColors();
		});
		tui.setTerminalColorSchemeNotifications(true);
		queryColors();
		state = await app.snapshot();
		repaint();
		if (options.signal?.aborted) done.resolve();
		await done.promise;
	} finally {
		closed = true;
		clearTimeout(repaintTimer);
		unsubscribeBranch();
		branch.close();
		workingLoader?.stop();
		clearTimeout(themeTimer);
		themeWatcher?.close();
		await themeReload;
		clipboardAbort.abort();
		ui.dispose();
		await detachUI?.();
		transcript.dispose();
		unsubscribe?.();
		removeAppearance?.();
		removeInput();
		if (getKeybindings() === bindings) setKeybindings(previousBindings);
		process.off("SIGINT", interrupt);
		process.off("SIGTERM", exit);
		process.off("SIGHUP", exit);
		options.signal?.removeEventListener("abort", exit);
		terminal.setProgress(false);
		if (terminalStarted) tui.stop({ preserveScreen: true });
	}
}
