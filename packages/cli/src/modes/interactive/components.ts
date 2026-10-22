import { plainText } from "../../core/ui/text.ts";
import {
	customMessage,
	customEntry,
	type CustomMessage,
	type CustomEntry,
} from "../../core/sessions/custom-entries.ts";
import { userBashEntry, type UserBashEntry, type UserBashProgress } from "../../core/tools/user-bash.ts";
import type { EntryRecord } from "@arc/durable";
import { homedir } from "node:os";
import { relative, isAbsolute, sep } from "node:path";
import type { Message, ToolCall, ToolResultMessage } from "@arc/ai";
import type { ToolSlot, NestedToolSlot, TaskGraph } from "@arc/durable";
import {
	Container,
	Box,
	Image,
	Markdown,
	MouseRegion,
	Spacer,
	Text,
	truncateToWidth,
	visibleWidth,
	type Component,
	type Focusable,
	type MarkdownTheme,
	type SelectListTheme,
	getKeybindings,
	type Keybinding,
} from "@arc/tui";
import chalk from "chalk";

export function shortcut(id: Keybinding, fallback: string): string {
	const bindings = getKeybindings();
	if (!bindings.getDefinition(id)) return fallback;
	const key = bindings.getKeys(id)[0];
	return key
		? key
				.split("+")
				.map((part) => (part ? part[0]!.toUpperCase() + part.slice(1) : ""))
				.join("+")
		: "unbound";
}
import type { ToolRenderers, ToolRenderContext } from "../../core/ui/tool-renderers.ts";
import type { ApplicationState } from "../../core/types.ts";
import type { Theme } from "../../core/ui/theme.ts";
import { mermaidTransform, highlightCode, type MermaidMode } from "./markdown.ts";

export function selectColors(getTheme: () => Theme): SelectListTheme {
	return {
		selectedPrefix: (text) => getTheme().fg("accent", text),
		selectedText: (text) => getTheme().fg("accent", text),
		description: (text) => getTheme().fg("muted", text),
		scrollInfo: (text) => getTheme().fg("muted", text),
		noMatch: (text) => getTheme().fg("warning", text),
	};
}

export const selectTheme: SelectListTheme = {
	selectedPrefix: chalk.cyan,
	selectedText: chalk.cyan,
	description: chalk.dim,
	scrollInfo: chalk.dim,
	noMatch: chalk.yellow,
};

const markdownTheme: MarkdownTheme = {
	heading: chalk.bold.cyan,
	link: chalk.cyan,
	linkUrl: chalk.dim,
	code: chalk.yellow,
	codeBlock: (text) => text,
	codeBlockBorder: chalk.dim,
	quote: chalk.italic,
	quoteBorder: chalk.dim,
	hr: chalk.dim,
	listBullet: chalk.cyan,
	bold: chalk.bold,
	italic: chalk.italic,
	strikethrough: chalk.strikethrough,
	underline: chalk.underline,
};
function markdownColors(theme: Theme | undefined): MarkdownTheme {
	if (!theme) return { ...markdownTheme };
	return {
		heading: (text) => theme.bold(theme.fg("mdHeading", text)),
		link: (text) => theme.fg("mdLink", text),
		linkUrl: (text) => theme.fg("mdLinkUrl", text),
		code: (text) => theme.fg("mdCode", text),
		codeBlock: (text) => theme.fg("mdCodeBlock", text),
		codeBlockBorder: (text) => theme.fg("mdCodeBlockBorder", text),
		quote: (text) => theme.fg("mdQuote", text),
		quoteBorder: (text) => theme.fg("mdQuoteBorder", text),
		hr: (text) => theme.fg("mdHr", text),
		listBullet: (text) => theme.fg("mdListBullet", text),
		bold: (text) => theme.bold(text),
		italic: (text) => theme.italic(text),
		strikethrough: (text) => theme.strikethrough(text),
		underline: (text) => theme.underline(text),
		highlightCode: (code, lang) => highlightCode(code, lang, theme),
	};
}

export interface DisplayOptions {
	readonly markdownTransformers?: readonly import("../../core/ui/tool-renderers.ts").MarkdownTransformer[];
	readonly toolsExpanded: boolean;
	readonly thinkingVisible: boolean;
	readonly hiddenThinkingLabel?: string;
	readonly theme?: Theme;
	readonly mermaid?: MermaidMode;
	readonly codeBlockIndent?: string;
	readonly cwd?: string;
}

export type ToolCard = {
	readonly kind: "tool";
	readonly name: string;
	readonly call?: ToolCall;
	readonly notRun?: boolean;
	result?: ToolResultMessage;
	slot?: ToolSlot;
	nested?: NestedToolSlot[];
};

type ConversationItem =
	| { readonly kind: "bash"; readonly execution: UserBashEntry | UserBashProgress }
	| { readonly kind: "message"; readonly message: Exclude<Message, ToolResultMessage> }
	| ToolCard
	| {
			readonly kind: "custom";
			readonly record: EntryRecord;
			readonly message?: CustomMessage;
			readonly entry?: CustomEntry;
	  };

function messageText(content: Exclude<Message, { role: "assistant" }>["content"]): string {
	return typeof content === "string"
		? content
		: content.map((part) => (part.type === "text" ? part.text : `[${part.mimeType} image]`)).join("\n");
}

export function conversationItems(state: ApplicationState): ConversationItem[] {
	const items: ConversationItem[] = [];
	const shells = new Set<string>();
	const pending = new Map<string, ToolCard>();
	const completed = new Set<string>();
	const append = (message: Message) => {
		if (message.role === "toolResult") {
			const card = pending.get(message.toolCallId);
			if (card) card.result = message;
			else items.push({ kind: "tool", name: message.toolName, result: message });
			pending.delete(message.toolCallId);
			completed.add(message.toolCallId);
			return;
		}
		items.push({ kind: "message", message });
		if (message.role !== "assistant") return;
		for (const part of message.content) {
			if (part.type !== "toolCall") continue;
			const card: ToolCard = {
				kind: "tool",
				name: part.name,
				call: part,
				notRun: message.stopReason !== "pending" && message.stopReason !== "toolUse",
			};
			items.push(card);
			pending.set(part.id, card);
			completed.delete(part.id);
		}
	};
	for (const entry of state.view.entries) {
		const bash = userBashEntry(entry);
		if (bash) {
			shells.add(bash.id);
			items.push({ kind: "bash", execution: bash });
			continue;
		}
		const message = customMessage(entry),
			data = customEntry(entry);
		if (message || data) {
			if (!message || message.display) items.push({ kind: "custom", record: entry, message, entry: data });
			continue;
		}
		for (const message of entry.model ?? []) if (message.role !== "system" || entry.head !== undefined) append(message);
		if (entry.head !== undefined && !entry.model?.length)
			items.push({
				kind: "message",
				message: { role: "system", content: "Earlier context summarized.", timestamp: 0 },
			});
	}
	if (state.live.generation?.message) append(state.live.generation.message);
	for (const execution of state.userBash ?? []) if (!shells.has(execution.id)) items.push({ kind: "bash", execution });
	for (const slot of state.live.tools ?? []) {
		const card = pending.get(slot.callId);
		if (card) card.slot = slot;
		else if (slot.status !== "done" || !completed.has(slot.callId)) items.push({ kind: "tool", name: slot.name, slot });
	}
	for (const slot of state.live.nestedTools ?? []) {
		const parent = items.findLast(
			(item) =>
				item.kind === "tool" &&
				item.name === "codemode" &&
				(item.call?.id ?? item.slot?.callId ?? item.result?.toolCallId) === slot.parentCallId,
		);
		if (parent?.kind === "tool") (parent.nested ??= []).push(slot);
		else items.push({ kind: "tool", name: slot.name, slot });
	}
	return items;
}

export function imageComponent(part: { readonly data: string; readonly mimeType: string }): Component {
	if (!/^image\/(png|jpeg|gif|webp)$/.test(part.mimeType) || !/^[A-Za-z0-9+/=\s]*$/.test(part.data))
		return new Text("[Unsupported image]", 1, 0);
	return new Image(
		Buffer.from(part.data, "base64").toString("base64"),
		part.mimeType,
		{ fallbackColor: (text) => text },
		{ maxWidthCells: 60, maxHeightCells: 24 },
	);
}

export function messageComponent(message: Exclude<Message, ToolResultMessage>, options: DisplayOptions): Component {
	const shellZones =
		message.role === "user" ||
		(message.role === "assistant" && !message.content.some((part) => part.type === "toolCall"));
	const card = new (class extends Container {
		render(width: number): string[] {
			const lines = super.render(width);
			if (shellZones && lines.length) {
				lines[0] = "\x1b]133;A\x07" + lines[0];
				lines[lines.length - 1] = "\x1b]133;B\x07\x1b]133;C\x07" + lines[lines.length - 1];
			}
			return lines;
		}
	})();
	const theme = options.theme;
	const markdownTheme = markdownColors(theme);
	markdownTheme.codeBlockIndent = options.codeBlockIndent;

	const streaming = message.role === "assistant" && message.stopReason === "pending";
	const diagram = mermaidTransform({ mode: options.mermaid, theme, streaming });
	const transformFor =
		(messageType: import("../../core/ui/tool-renderers.ts").MarkdownTransformContext["messageType"]) =>
		(source: string, width: number): string => {
			let result = source;
			for (const transform of options.markdownTransformers ?? [])
				result = transform(result, { messageType, isStreaming: streaming, availableWidth: width });
			return diagram ? diagram(result, width) : result;
		};
	const transform = transformFor(message.role === "assistant" ? "assistant" : "user");

	const overrides = new Map<number, boolean>();
	const draw = () => {
		card.clear();
		if (message.role !== "assistant") {
			if (message.role === "system") card.addChild(new Text(chalk.dim("Context"), 1, 0));
			const content =
				typeof message.content === "string" ? [{ type: "text" as const, text: message.content }] : message.content;
			for (const part of content) {
				if (part.type === "image") card.addChild(imageComponent(part));
				else
					card.addChild(
						new Markdown(
							plainText(part.text),
							1,
							message.role === "user" ? 1 : 0,
							markdownTheme,
							theme && message.role === "user"
								? {
										color: (text) => theme.fg("userMessageText", text),
										bgColor: (text) => theme.bg("userMessageBg", text),
									}
								: undefined,
							{
								preserveOrderedListMarkers: message.role === "user",
								preserveBackslashEscapes: message.role === "user",
								transform,
							},
						),
					);
			}
			return;
		}
		if (
			message.content.some((part) =>
				part.type === "text" ? part.text.trim() : part.type === "thinking" && part.thinking.trim(),
			)
		)
			card.addChild(new Spacer(1));
		let run = 0;
		for (let index = 0; index < message.content.length; index++) {
			const part = message.content[index];
			if (part.type === "text" && part.text.trim())
				card.addChild(new Markdown(plainText(part.text.trim()), 1, 0, markdownTheme, undefined, { transform }));
			else if (part.type === "thinking") {
				const chunks = [part.thinking.trim()];
				while (message.content[index + 1]?.type === "thinking") {
					const next = message.content[++index];
					if (next.type === "thinking" && next.thinking.trim()) chunks.push(next.thinking.trim());
				}
				const text = chunks.filter(Boolean).join("\n\n");
				if (!text) continue;
				const key = run++;
				const visible = overrides.get(key) ?? options.thinkingVisible;
				const color = (text: string) => (theme ? theme.fg("thinkingText", text) : chalk.dim(text));
				const content = visible
					? new Markdown(
							plainText(text),
							1,
							0,
							markdownTheme,
							{ color, italic: true },
							{ transform: transformFor("assistant-thinking") },
						)
					: new Text(chalk.italic(color(plainText(options.hiddenThinkingLabel ?? "Thinking..."))), 1, 0);
				card.addChild(
					new MouseRegion(content, (event) => {
						if (event.type !== "click" || event.button !== "left") return undefined;
						overrides.set(key, !visible);
						draw();
						return { handled: true };
					}),
				);
				if (
					message.content
						.slice(index + 1)
						.some((part) =>
							part.type === "text" ? part.text.trim() : part.type === "thinking" && part.thinking.trim(),
						)
				)
					card.addChild(new Spacer(1));
			}
		}
		const toolCalls = message.content.some((part) => part.type === "toolCall");
		const failure =
			message.stopReason === "length"
				? "Response was truncated before completion."
				: toolCalls
					? undefined
					: message.stopReason === "error"
						? `Error: ${message.errorMessage || "Unknown error"}`
						: message.stopReason === "aborted"
							? message.errorMessage && message.errorMessage !== "Request was aborted"
								? message.errorMessage
								: "Operation aborted"
							: undefined;
		if (failure) {
			card.addChild(new Spacer(1));
			card.addChild(new Text(theme ? theme.fg("error", plainText(failure)) : chalk.red(plainText(failure)), 1, 0));
		}
	};
	draw();
	return card;
}

type DisposableComponent = Component & { dispose?(): void };
class RenderedTool extends Box {
	readonly owned = new Set<DisposableComponent>();
	readonly #report: (error: unknown) => void;
	constructor(report: (error: unknown) => void, background?: (text: string) => string) {
		super(0, 1, background);
		this.#report = report;
	}
	custom(factory: (() => Component | undefined) | undefined, fallback: Component | (() => Component)): Component {
		let resolved: Component | undefined;
		const fallbackView = () => (resolved ??= typeof fallback === "function" ? fallback() : fallback);
		if (!factory) return fallbackView();
		let component: DisposableComponent | undefined;
		try {
			component = factory();
			if (!component) return fallbackView();
			if (typeof component.render !== "function" || typeof component.invalidate !== "function")
				throw new Error("Tool renderer returned an invalid component");
		} catch (error) {
			this.#report(error);
			return fallbackView();
		}
		this.owned.add(component);
		const child = component;
		let failed = false;
		const view: Component & Partial<Focusable> = {
			render: (width) => {
				if (!failed)
					try {
						return child.render(width);
					} catch (error) {
						failed = true;
						this.#report(error);
					}
				return fallbackView().render(width);
			},
			invalidate: () => {
				if (!failed)
					try {
						child.invalidate();
					} catch (error) {
						failed = true;
						this.#report(error);
					}
			},
			handleInput: (data) => {
				if (!failed)
					try {
						child.handleInput?.(data);
					} catch (error) {
						failed = true;
						this.#report(error);
					}
			},
			handleMouse: (event) => {
				if (!failed)
					try {
						return child.handleMouse?.(event);
					} catch (error) {
						failed = true;
						this.#report(error);
					}
				return undefined;
			},
			get focused() {
				return "focused" in child && typeof child.focused === "boolean" ? child.focused : false;
			},
			set focused(value: boolean) {
				if ("focused" in child && typeof child.focused === "boolean") child.focused = value;
			},
		};
		return view;
	}
	disposeExcept(keep: ReadonlySet<DisposableComponent> = new Set()): void {
		for (const component of this.owned)
			if (!keep.has(component)) {
				try {
					component.dispose?.();
				} catch (error) {
					this.#report(error);
				}
			}
		this.owned.clear();
	}
}

export function toolComponent(
	tool: ToolCard,
	options: DisplayOptions,
	renderer?: ToolRenderers,
	state: Record<string, unknown> = {},
	requestRender: () => void = () => {},
	report: (error: unknown) => void = () => {},
): RenderedTool {
	const background = tool.result ? (tool.result.isError ? "toolErrorBg" : "toolSuccessBg") : "toolPendingBg";
	const theme = options.theme;
	const card = new RenderedTool(report, theme ? (text) => theme.bg(background, text) : undefined);
	const status = tool.result
		? tool.result.isError
			? "error"
			: "done"
		: tool.notRun
			? "not run"
			: (tool.slot?.status ?? "pending");
	const context: ToolRenderContext = {
		expanded: options.toolsExpanded,
		partial: !tool.result,
		call: tool.call,
		slot: tool.slot,
		nested: tool.nested,
		state,
		cwd: options.cwd ?? process.cwd(),
		theme: options.theme,
		executionStarted: tool.result !== undefined || tool.slot?.status === "running" || tool.slot?.status === "done",
		argsComplete: tool.result !== undefined || tool.slot !== undefined,
		isError: tool.result?.isError ?? false,
		requestRender,
	};
	const heading = `Tool · ${plainText(tool.name)} [${status}]`;
	if (renderer?.renderShell !== "self")
		card.addChild(new Text(status === "error" ? chalk.red(heading) : chalk.dim(heading), 1, 0));
	if (tool.call) {
		const call = tool.call;
		card.addChild(
			card.custom(
				renderer?.renderCall ? () => renderer.renderCall?.(call.arguments, context) : undefined,
				() =>
					new Text(
						theme
							? highlightCode(plainText(JSON.stringify(call.arguments)), "json", theme).join("\n")
							: plainText(JSON.stringify(call.arguments)),
						1,
						0,
					),
			),
		);
	}
	const fallback = new Container();
	const output = plainText(
		tool.result
			? tool.result.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n")
			: (tool.slot?.output ?? ""),
	);
	const lines = output.split("\n");
	if (output) fallback.addChild(new Text((options.toolsExpanded ? lines : lines.slice(0, 5)).join("\n"), 1, 0));
	if (!options.toolsExpanded && lines.length > 5)
		fallback.addChild(
			new Text(chalk.dim(`${lines.length - 5} more lines · ${shortcut("app.tools.expand", "Ctrl+O")} to expand`), 1, 0),
		);
	for (const part of tool.result?.content ?? []) if (part.type === "image") fallback.addChild(imageComponent(part));
	card.addChild(
		card.custom(renderer?.renderResult ? () => renderer.renderResult?.(tool.result, context) : undefined, fallback),
	);
	if (tool.slot?.droppedBytes || tool.slot?.droppedLines)
		card.addChild(
			new Text(
				chalk.dim(
					`Output truncated · ${tool.slot.droppedLines ?? 0} lines, ${tool.slot.droppedBytes ?? 0} bytes omitted`,
				),
				1,
				0,
			),
		);
	for (const diagnostic of tool.slot?.diagnostics ?? []) card.addChild(new Text(plainText(diagnostic.message), 1, 0));
	return card;
}

export class Transcript extends Container {
	readonly #customViews = new Map<EntryRecord, Component>();
	readonly #custom: Pick<import("../../core/types.ts").Application, "messageRenderer" | "entryRenderer"> | undefined;
	#releaseCustom(record: EntryRecord, component: Component): void {
		this.#customViews.delete(record);
		try {
			if ("dispose" in component && typeof component.dispose === "function") component.dispose();
		} catch (error) {
			this.#report(error);
		}
	}
	#drawCustom(item: Extract<ConversationItem, { kind: "custom" }>, options: DisplayOptions): Component | undefined {
		const theme = options.theme;
		try {
			const component =
				theme &&
				(item.message
					? this.#custom?.messageRenderer(item.message.customType)?.(
							item.message,
							{ expanded: options.toolsExpanded },
							theme,
						)
					: item.entry
						? this.#custom?.entryRenderer(item.entry.customType)?.(
								item.entry,
								{ expanded: options.toolsExpanded },
								theme,
							)
						: undefined);
			if (component) return component;
		} catch (error) {
			this.#report(error);
		}
		if (!item.message) return;
		const card = new Container();
		card.addChild(
			new Text(
				theme ? theme.fg("customMessageLabel", plainText(item.message.customType)) : plainText(item.message.customType),
				1,
				0,
			),
		);
		const content =
			typeof item.message.content === "string"
				? [{ type: "text" as const, text: item.message.content }]
				: item.message.content;
		for (const part of content)
			card.addChild(
				part.type === "image"
					? imageComponent(part)
					: new Markdown(
							plainText(part.text),
							1,
							0,
							markdownColors(theme),
							theme
								? {
										color: (text) => theme.fg("customMessageText", text),
										bgColor: (text) => theme.bg("customMessageBg", text),
									}
								: undefined,
						),
			);
		return card;
	}
	#cache = new WeakMap<object, Component>();
	#options: DisplayOptions = { toolsExpanded: false, thinkingVisible: false };
	#scope = "";
	#state: ApplicationState | undefined;
	readonly #tools = new Map<
		string,
		{ key: object | undefined; card: RenderedTool; view: Component; expanded: boolean; state: Record<string, unknown> }
	>();
	readonly #expanded = new Map<string, boolean>();
	readonly #resolve: (name: string) => ToolRenderers | undefined;
	readonly #request: () => void;
	readonly #onExpansion: (() => void) | undefined;
	readonly #report: (error: unknown) => void;
	constructor(
		resolve: (name: string) => ToolRenderers | undefined = () => undefined,
		request: () => void = () => {},
		report: (error: unknown) => void = () => {},
		custom?: Pick<import("../../core/types.ts").Application, "messageRenderer" | "entryRenderer">,
		onExpansion?: () => void,
	) {
		super();
		this.#custom = custom;
		this.#onExpansion = onExpansion;
		this.#resolve = resolve;
		this.#request = request;
		this.#report = report;
	}
	dispose(): void {
		for (const [record, component] of this.#customViews) this.#releaseCustom(record, component);
		this.#state = undefined;
		for (const tool of this.#tools.values()) tool.card.disposeExcept();
		this.#tools.clear();
		this.#expanded.clear();
		this.#cache = new WeakMap();
	}
	update(state: ApplicationState, options: DisplayOptions): void {
		const scope = `${state.view.conversation.id}:${state.presentationRevision ?? 0}`;
		if (scope !== this.#scope) {
			this.dispose();
			this.#scope = scope;
		}
		this.#state = state;
		const changed =
			options.markdownTransformers?.length !== this.#options.markdownTransformers?.length ||
			(options.markdownTransformers?.some((transform, i) => transform !== this.#options.markdownTransformers?.[i]) ??
				false) ||
			options.theme !== this.#options.theme ||
			options.mermaid !== this.#options.mermaid ||
			options.codeBlockIndent !== this.#options.codeBlockIndent ||
			options.toolsExpanded !== this.#options.toolsExpanded;
		const messagesChanged =
			changed ||
			options.hiddenThinkingLabel !== this.#options.hiddenThinkingLabel ||
			options.thinkingVisible !== this.#options.thinkingVisible;
		if (options.toolsExpanded !== this.#options.toolsExpanded) this.#expanded.clear();
		if (messagesChanged) this.#cache = new WeakMap();
		if (changed) {
			for (const [record, component] of this.#customViews) this.#releaseCustom(record, component);
		}
		this.#options = options;
		this.clear();
		const visible = new Set<string>();
		const customRecords = new Set<EntryRecord>();
		for (const [index, item] of conversationItems(state).entries()) {
			if (item.kind === "bash") {
				const execution = item.execution;
				const result = "result" in execution ? execution.result : undefined;
				const output = plainText("output" in execution ? execution.output : execution.result.output);
				const lines = output.split("\n");
				const shown = options.toolsExpanded ? output : lines.slice(-5).join("\n");
				const status = !result ? "running" : result.cancelled ? "cancelled" : `exit ${result.exitCode ?? "unknown"}`;
				this.addChild(
					new Text(
						`${execution.excludeFromContext ? "!!" : "$"} ${plainText(execution.command)}\n${shown}\n[${status}${!options.toolsExpanded && lines.length > 5 ? "; collapsed" : ""}${result?.truncated ? "; truncated" : ""}${result?.fullOutputPath ? `; ${plainText(result.fullOutputPath)}` : ""}]`,
						1,
						1,
					),
				);
				continue;
			}
			if (item.kind === "custom") {
				customRecords.add(item.record);
				let component = this.#customViews.get(item.record);
				if (!component) {
					component = this.#drawCustom(item, options);
					if (component) this.#customViews.set(item.record, component);
				}
				if (component) this.addChild(component);
				continue;
			}
			if (item.kind === "message") {
				let card = this.#cache.get(item.message);
				if (!card) {
					card = messageComponent(item.message, options);
					this.#cache.set(item.message, card);
				}
				this.addChild(card);
				continue;
			}
			this.addChild(new Spacer(1));
			const id = `${index}:${item.call?.id ?? item.result?.toolCallId ?? item.slot?.callId ?? item.name}`;
			visible.add(id);
			const key = item.nested ?? item.result ?? item.slot ?? item.call;
			const previous = this.#tools.get(id);
			const expanded = this.#expanded.get(id) ?? options.toolsExpanded;
			if (previous && previous.key === key && !changed && previous.expanded === expanded) {
				this.addChild(previous.view);
				continue;
			}
			const renderState = previous?.state ?? {};
			const card = toolComponent(
				item,
				{ ...options, toolsExpanded: expanded },
				this.#resolve(item.name),
				renderState,
				this.#request,
				this.#report,
			);
			const view = new MouseRegion(card, (event) => {
				if (event.type !== "click" || event.button !== "left" || !item.result) return undefined;
				const current = this.#state;
				if (!current) return undefined;
				this.#onExpansion?.();
				this.#expanded.set(id, !expanded);
				this.update(current, this.#options);
				this.#request();
				return { handled: true };
			});
			previous?.card.disposeExcept(card.owned);
			this.#tools.set(id, { key, card, view, expanded, state: renderState });
			this.addChild(view);
		}
		for (const [record, component] of this.#customViews)
			if (!customRecords.has(record)) this.#releaseCustom(record, component);
		for (const [id, tool] of this.#tools)
			if (!visible.has(id)) {
				tool.card.disposeExcept();
				this.#tools.delete(id);
				this.#expanded.delete(id);
			}
	}
}

export function queueText(state: ApplicationState): string {
	const lines = state.inbox.items.slice(0, 3).map((item) => {
		const content = item.mode === "write" ? "Session update" : messageText(item.content);
		return `Queued ${item.mode === "followUp" ? "follow-up" : item.mode} · ${plainText(content).replace(/\n/g, " ")}`;
	});
	if (state.inbox.items.length > 3) lines.push(`${state.inbox.items.length - 3} more queued`);
	return lines.join("\n");
}

export function taskGraphText(graph: TaskGraph | undefined): string {
	if (!graph) return "";
	const tasks = Object.values(graph.tasks);
	if (!tasks.length) return "Tasks · idle";
	const lines = tasks.slice(0, 6).map((task) => {
		const phase = task.state.status === "completing" ? task.state.outcome : task.state.phase;
		const waiting = task.state.status === "waiting" ? ` · waits for ${task.state.on.join(", ")}` : "";
		return `${task.id} ${task.kind} · ${task.state.status}/${phase} · conversation ${task.conversationId}${waiting}${task.blocked ? ` · blocked: ${task.blocked}` : ""}`;
	});
	return ["Tasks", ...lines.map(plainText), ...(tasks.length > 6 ? [`${tasks.length - 6} more tasks`] : [])].join("\n");
}

export function statusText(state: ApplicationState): string {
	const retry = state.live.generation?.retry;
	if (retry) return `Retrying · ${plainText(retry.error)}`;
	if (state.live.compactionFailure) return `Compaction failed · ${plainText(state.live.compactionFailure.error)}`;
	if (state.live.compactions?.length) return "Summarizing earlier context…";
	if (state.live.tools?.some((tool) => tool.status === "running"))
		return `Running tools · ${shortcut("app.clear", "Ctrl+C")} to abort`;
	if (state.live.generation?.deferred) return `Waiting for model · ${shortcut("app.clear", "Ctrl+C")} to abort`;
	return state.busy
		? `Working · ${shortcut("tui.input.submit", "Enter")} to steer · ${shortcut("app.message.followUp", "Alt+Enter")} to queue a follow-up · ${shortcut("app.clear", "Ctrl+C")} to abort`
		: "";
}

function formatTokens(value: number): string {
	return value < 1000
		? String(value)
		: value < 10000
			? `${(value / 1000).toFixed(1)}k`
			: value < 1000000
				? `${Math.round(value / 1000)}k`
				: value < 10000000
					? `${(value / 1000000).toFixed(1)}M`
					: `${Math.round(value / 1000000)}M`;
}

export function footerLines(
	state: ApplicationState,
	width: number,
	model?: import("@arc/ai").Model<string>,
	providers = 1,
	options: { branch?: string | null; subscription?: boolean } = {},
): string[] {
	width = Math.max(1, width);
	const usage = [...Object.values(state.usage.models), ...Object.values(state.usage.tools)];
	const total = (field: "input" | "output" | "cacheRead" | "cacheWrite") =>
		usage.reduce((sum, value) => sum + value[field], 0);
	const cost = usage.reduce((sum, value) => sum + value.cost.total, 0);
	const stats = (
		[
			["input", "↑"],
			["output", "↓"],
			["cacheRead", "R"],
			["cacheWrite", "W"],
		] as const
	).flatMap(([field, marker]) => (total(field) ? [`${marker}${formatTokens(total(field))}`] : []));

	const latest = state.view.entries
		.flatMap((entry) => entry.model ?? [])
		.findLast((message) => message.role === "assistant");
	const promptTokens =
		latest?.role === "assistant" ? latest.usage.input + latest.usage.cacheRead + latest.usage.cacheWrite : 0;
	if ((total("cacheRead") || total("cacheWrite")) && promptTokens)
		stats.push(`CH${(((latest?.role === "assistant" ? latest.usage.cacheRead : 0) * 100) / promptTokens).toFixed(1)}%`);
	if (cost || options.subscription) stats.push(`$${cost.toFixed(3)}${options.subscription ? " (sub)" : ""}`);
	const window = state.routedModel?.contextWindow ?? model?.contextWindow ?? 0;
	const unknown =
		state.view.entries.at(-1)?.head !== undefined || state.view.entries.at(-1)?.kind === "arc.branch-summary";
	stats.push(
		`${unknown ? "?" : (window ? (promptTokens * 100) / window : 0).toFixed(1) + "%"}/${formatTokens(window)}${state.settings?.compaction?.enabled === false ? "" : " (auto)"}`,
	);
	const left = truncateToWidth(stats.join(" "), width, "...");
	let right = state.agent.model?.modelId ?? "no-model";
	if (model?.reasoning)
		right += ` • ${state.agent.thinkingLevel === "off" ? "thinking off" : (state.agent.thinkingLevel ?? "off")}`;
	if (state.routedModel)
		right += ` → ${state.routedModel.modelId}${state.routedModel.thinkingLevel ? ` • ${state.routedModel.thinkingLevel}` : ""}`;
	const withProvider = `(${state.agent.model?.provider}) ${right}`;
	if (providers > 1 && state.agent.model && visibleWidth(left) + visibleWidth(withProvider) + 2 <= width)
		right = withProvider;
	const available = width - visibleWidth(left) - 2;
	right = available > 0 ? truncateToWidth(right, available, "") : "";
	const home = relative(homedir(), state.cwd);
	const cwd = !home
		? "~"
		: home !== ".." && !home.startsWith(`..${sep}`) && !isAbsolute(home)
			? `~${sep}${home}`
			: state.cwd;
	const path = `${cwd}${options.branch ? ` (${options.branch})` : ""}${state.sessionName ? ` • ${state.sessionName}` : ""}`;
	return [
		truncateToWidth(plainText(path).replace(/\n/g, " "), width, "..."),
		left + " ".repeat(Math.max(0, width - visibleWidth(left) - visibleWidth(right))) + plainText(right),
	];
}
