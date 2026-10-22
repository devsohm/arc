import type { ConversationId, ConversationRecord, EntryId, EntryRecord } from "@arc/durable";
import type { UIItem } from "../ui/ui.ts";
import { defineDoc } from "@arc/durable";

export const NavigationDoc = defineDoc<{ labels: Record<string, { text: string; updated: number }> }>({
	kind: "arc.navigation",
	scope: "session",
	version: 1,
	initial: () => ({ labels: {} }),
	checkpointWhen: () => true,
});
export type TreeFilter = "default" | "no-tools" | "user-only" | "labeled-only" | "all";
export type TreeSelection = { readonly filter: TreeFilter } & (
	| { readonly action: "cancel" }
	| { readonly action: "select"; readonly value: string }
	| { readonly action: "label"; readonly value: string; readonly label?: string }
);

type Target =
	| { kind: "entry"; entry: EntryRecord; parent: EntryId | undefined }
	| { kind: "conversation"; conversation: ConversationRecord };
export type NavigationItem = UIItem & {
	readonly target: Target;
	readonly current: boolean;
	readonly active?: boolean;
	readonly parentValue?: string;
	readonly depth: number;
	readonly prefix?: string;
	readonly text: string;
	readonly tag?: string;
	readonly tagUpdated?: number;
};

export function sessionTree(
	conversations: readonly ConversationRecord[],
	entries: readonly EntryRecord[],
	current: ConversationId,
	labels: Readonly<Record<string, { text: string; updated: number }>> = {},
): NavigationItem[] {
	const byConversation = new Map<ConversationId, EntryRecord[]>();
	for (const entry of entries) {
		let group = byConversation.get(entry.conversationId);
		if (!group) byConversation.set(entry.conversationId, (group = []));
		group.push(entry);
	}
	const children = new Map<EntryId | undefined, Target[]>();
	const append = (parent: EntryId | undefined, target: Target) => {
		let group = children.get(parent);
		if (!group) children.set(parent, (group = []));
		group.push(target);
	};
	let currentEntry: EntryId | undefined;
	for (const conversation of conversations) {
		const group = byConversation.get(conversation.id)?.sort((a, b) => a.id - b.id) ?? [];
		let parent = conversation.parent?.at;
		for (const entry of group) {
			append(parent, { kind: "entry", entry, parent });
			parent = entry.id;
		}
		if (!group.length) append(parent, { kind: "conversation", conversation });
		if (conversation.id === current) currentEntry = group.at(-1)?.id;
	}
	const rows: NavigationItem[] = [];
	const parents = new Map<EntryId, EntryId | undefined>();
	for (const group of children.values())
		for (const target of group) if (target.kind === "entry") parents.set(target.entry.id, target.parent);
	const active = new Set<EntryId>();
	let position = currentEntry ?? conversations.find((conversation) => conversation.id === current)?.parent?.at;
	while (position !== undefined) {
		active.add(position);
		position = parents.get(position);
	}
	const ordered = (group: readonly Target[]) =>
		group.toSorted(
			(a, b) =>
				Number(b.kind === "entry" ? active.has(b.entry.id) : b.conversation.id === current) -
				Number(a.kind === "entry" ? active.has(a.entry.id) : a.conversation.id === current),
		);
	const roots = ordered(children.get(undefined) ?? []);
	const pending = roots
		.map((target, index) => ({
			target,
			depth: 0,
			branched: roots.length > 1,
			connector: false,
			last: index === roots.length - 1,
			gutters: new Map<number, boolean>(),
		}))
		.toReversed();
	while (pending.length) {
		const node = pending.pop();
		if (!node) break;
		const { target, depth } = node;
		const columns: string[] = Array.from({ length: depth }, (_, index) => (node.gutters.get(index) ? "│  " : "   "));
		if (node.connector && depth) columns[depth - 1] = node.last ? "└─ " : "├─ ";
		const prefix = columns.join("");
		const selected = target.kind === "entry" ? target.entry.id === currentEntry : target.conversation.id === current;
		const indent = "  ".repeat(Math.min(depth, 8));
		if (target.kind === "conversation") {
			rows.push({
				target,
				depth,
				prefix,
				text: `Conversation ${target.conversation.id} · empty`,
				parentValue: target.conversation.parent ? `entry:${target.conversation.parent.at}` : undefined,
				current: selected,
				active: selected,
				value: String(target.conversation.id),
				label: `${indent}${selected ? "●" : "○"} Conversation ${target.conversation.id} · empty`,
			});
			continue;
		}
		const entry = target.entry;
		const text = entry.model
			?.flatMap((message) =>
				typeof message.content === "string"
					? [message.content]
					: message.content.flatMap((block) => (block.type === "text" ? [block.text] : [])),
			)
			.join("\n");
		const preview = text?.replace(/\s+/g, " ").slice(0, 180);
		rows.push({
			target,
			depth,
			prefix,
			text: text || entry.kind,
			parentValue: target.parent === undefined ? undefined : `entry:${target.parent}`,
			tag: labels[String(entry.id)]?.text,
			tagUpdated: labels[String(entry.id)]?.updated,
			current: selected,
			active: active.has(entry.id),
			value: `entry:${entry.id}`,
			label: `${indent}${selected ? "●" : "○"} ${entry.id} ${preview || entry.kind}`,
			description: `Conversation ${entry.conversationId} · ${entry.kind}`,
		});
		const group = ordered(children.get(entry.id) ?? []);
		const branch = group.length > 1;
		const childDepth = branch || (node.branched && depth > 0) ? depth + 1 : depth;
		const gutters = new Map(node.gutters);
		if (node.connector) gutters.set(depth - 1, !node.last);
		for (let index = group.length - 1; index >= 0; index--)
			pending.push({
				target: group[index],
				depth: childDepth,
				branched: branch,
				connector: branch,
				last: index === group.length - 1,
				gutters,
			});
	}
	return rows;
}

export function filterTree(items: readonly NavigationItem[], filter: TreeFilter, search = ""): NavigationItem[] {
	const words = search.toLowerCase().split(/\s+/).filter(Boolean);
	return items.filter((item) => {
		const entry = item.target.kind === "entry" ? item.target.entry : undefined;
		const messages = entry?.model ?? [];
		if (
			!item.current &&
			messages.length &&
			messages.every(
				(message) =>
					message.role === "assistant" &&
					message.stopReason !== "error" &&
					message.stopReason !== "aborted" &&
					!message.content.some((part) => part.type === "text" && part.text.trim()),
			)
		)
			return false;
		if (
			filter === "user-only" &&
			(entry?.kind === "arc.branch-summary" || !messages.some((message) => message.role === "user"))
		)
			return false;
		if (filter === "labeled-only" && item.tag === undefined) return false;
		if (filter === "no-tools" && messages.some((message) => message.role === "toolResult")) return false;
		if (
			(filter === "default" || filter === "no-tools") &&
			entry &&
			(entry.kind === "arc.system" ||
				(!messages.length && entry.kind !== "arc.branch-summary" && entry.head === undefined))
		)
			return false;
		const text =
			`${item.text} ${messages.map((message) => message.role).join(" ")} ${item.tag ?? ""} ${item.description ?? ""}`.toLowerCase();
		return words.every((word) => text.includes(word));
	});
}
