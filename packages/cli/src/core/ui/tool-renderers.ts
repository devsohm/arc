import type { ToolCall, ToolResultMessage } from "@arc/ai";
import type { NestedToolSlot, ToolSlot } from "@arc/durable";
import type { Component } from "@arc/tui";
import type { Theme } from "./theme.ts";

export interface ToolRenderContext {
	readonly expanded: boolean;
	readonly partial: boolean;
	readonly call?: ToolCall;
	readonly slot?: ToolSlot;
	readonly nested?: readonly NestedToolSlot[];
	readonly state: Record<string, unknown>;
	readonly cwd: string;
	readonly theme?: Theme;
	readonly executionStarted: boolean;
	readonly argsComplete: boolean;
	readonly isError: boolean;
	requestRender(): void;
}
export interface ToolRenderers {
	readonly renderShell?: "default" | "self";
	renderCall?(args: ToolCall["arguments"], context: ToolRenderContext): Component | undefined;
	renderResult?(result: ToolResultMessage | undefined, context: ToolRenderContext): Component | undefined;
}

export type ToolRendererResolver = (name: string, next: () => ToolRenderers | undefined) => ToolRenderers | undefined;
export interface MarkdownTransformContext {
	readonly messageType: "user" | "assistant" | "assistant-thinking";
	readonly isStreaming: boolean;
	readonly availableWidth: number;
}
export type MarkdownTransformer = (source: string, context: MarkdownTransformContext) => string;

export type MessageRenderer = (
	message: import("../sessions/custom-entries.ts").CustomMessage,
	options: { readonly expanded: boolean },
	theme: Theme,
) => Component | undefined;
export type EntryRenderer = (
	entry: import("../sessions/custom-entries.ts").CustomEntry,
	options: { readonly expanded: boolean },
	theme: Theme,
) => Component | undefined;
