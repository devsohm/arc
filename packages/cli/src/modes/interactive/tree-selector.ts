import { plainText } from "../../core/ui/text.ts";
import {
	Container,
	Spacer,
	Input,
	Text,
	getKeybindings,
	sliceByColumn,
	truncateToWidth,
	visibleWidth,
	type Focusable,
	type Component,
	type SelectListTheme,
} from "@arc/tui";
import type { Theme } from "../../core/ui/theme.ts";
import {
	filterTree,
	type NavigationItem,
	type TreeFilter,
	type TreeSelection,
} from "../../core/sessions/navigation.ts";
import { shortcut } from "./components.ts";

const filters: readonly TreeFilter[] = ["default", "no-tools", "user-only", "labeled-only", "all"];
const filterActions = [
	"app.tree.filter.default",
	"app.tree.filter.noTools",
	"app.tree.filter.userOnly",
	"app.tree.filter.labeledOnly",
	"app.tree.filter.all",
] as const;

export function labelTimestamp(value: number, now = new Date()): string {
	const date = new Date(value);
	const time = `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
	if (date.toDateString() === now.toDateString()) return time;
	return `${date.getFullYear() === now.getFullYear() ? "" : `${String(date.getFullYear()).slice(-2)}/`}${date.getMonth() + 1}/${date.getDate()} ${time}`;
}

export class TreeSelector extends Container implements Focusable {
	readonly #items: readonly NavigationItem[];
	readonly #byId: Map<string, NavigationItem>;
	readonly #search = new Input({ placeholder: "Search tree" });
	readonly #label = new Input();
	readonly #body: Component;
	readonly #done: (result: TreeSelection) => void;
	readonly #copy: (text: string) => Promise<void>;
	readonly #theme: SelectListTheme;
	readonly #palette: Theme | undefined;
	readonly #limit: number;
	readonly #folded = new Set<string>();
	readonly #parents = new Map<string, string>();
	readonly #children = new Map<string, string[]>();
	#visible: NavigationItem[] = [];
	#filter: TreeFilter;
	#selected: string | undefined;
	#index = 0;
	#editing = false;
	#timestamps = false;
	#focused = false;
	get focused(): boolean {
		return this.#focused;
	}
	set focused(value: boolean) {
		this.#focused = value;
		this.#search.focused = value && !this.#editing;
		this.#label.focused = value && this.#editing;
	}
	constructor(
		items: readonly NavigationItem[],
		options: { initialValue?: string; filter: TreeFilter; limit: number; theme?: Theme },
		done: (result: TreeSelection) => void,
		copy: (text: string) => Promise<void>,
		theme: SelectListTheme,
	) {
		super();
		this.#items = items;
		this.#byId = new Map(items.map((item) => [item.value, item]));
		this.#selected = options.initialValue;
		this.#filter = options.filter;
		this.#limit = options.limit;
		this.#done = done;
		this.#copy = copy;
		this.#theme = theme;
		this.#palette = options.theme;
		this.#body = { render: (width) => this.#renderRows(width), invalidate() {} };
		this.#refresh();
	}
	#refresh(): void {
		this.focused = this.#focused;
		const filtered = filterTree(this.#items, this.#filter, this.#search.getValue());
		const included = new Set(filtered.map((item) => item.value));
		this.#parents.clear();
		this.#children.clear();
		for (const item of filtered) {
			let parent = item.parentValue;
			while (parent && !included.has(parent)) parent = this.#byId.get(parent)?.parentValue;
			if (parent) {
				this.#parents.set(item.value, parent);
				const children = this.#children.get(parent) ?? [];
				children.push(item.value);
				this.#children.set(parent, children);
			}
		}
		const hidden = new Set<string>();
		this.#visible = filtered.filter((item) => {
			const parent = this.#parents.get(item.value);
			if (!parent || (!hidden.has(parent) && !this.#folded.has(parent))) return true;
			hidden.add(item.value);
			return false;
		});
		let selected = this.#selected;
		let index = this.#visible.findIndex((item) => item.value === selected);
		while (index < 0 && selected) {
			selected = this.#byId.get(selected)?.parentValue;
			index = this.#visible.findIndex((item) => item.value === selected);
		}
		this.#index = index < 0 ? Math.max(0, this.#visible.length - 1) : index;
		if (this.#visible.length) this.#selected = this.#visible[this.#index]?.value;
		this.clear();
		const border: Component = {
			render: (width) => [
				this.#palette?.fg("border", "─".repeat(Math.max(1, width))) ?? "─".repeat(Math.max(1, width)),
			],
			invalidate() {},
		};
		this.addChild(new Spacer(1));
		this.addChild(border);
		this.addChild(new Text(this.#palette?.bold("  Session Tree") ?? "  Session Tree", 1, 0));
		this.addChild(
			new Text(
				this.#theme.scrollInfo(
					[
						`${shortcut("tui.select.up", "↑")}/${shortcut("tui.select.down", "↓")} move`,
						`${shortcut("tui.editor.cursorLeft", "←")}/${shortcut("tui.editor.cursorRight", "→")} page`,
						`${shortcut("app.tree.foldOrUp", "Ctrl+←")}/${shortcut("app.tree.unfoldOrDown", "Ctrl+→")} branch`,
						`${shortcut("app.message.copy", "Ctrl+X")} copy`,
						`${shortcut("app.tree.editLabel", "Shift+L")} label`,
						`${shortcut("app.tree.toggleLabelTimestamp", "Shift+T")} label time`,
						`${shortcut("app.tree.filter.cycleForward", "Ctrl+O")} filter`,
						"Esc back",
					].join(" · "),
				),
				2,
				0,
			),
		);
		this.addChild({
			render: (width) => [
				truncateToWidth(
					`  ${this.#theme.scrollInfo("Type to search:")}${this.#search.getValue() ? ` ${this.#theme.selectedText(this.#search.getValue())}` : ""}`,
					width,
				),
			],
			invalidate() {},
		});
		this.addChild(border);
		this.addChild(new Spacer(1));
		if (this.#editing) {
			this.addChild(new Text(this.#theme.scrollInfo("Label (empty to remove):"), 2, 0));
			this.addChild(this.#label);
			this.addChild(
				new Text(
					`${shortcut("tui.select.confirm", "Enter")} save  ${shortcut("tui.select.cancel", "Esc")} cancel`,
					2,
					0,
				),
			);
		} else {
			this.addChild(this.#body);
			this.addChild({
				render: (width) => [
					truncateToWidth(
						this.#theme.scrollInfo(
							`  (${this.#visible.length ? this.#index + 1 : 0}/${this.#visible.length})${this.#filter === "default" ? "" : ` [${this.#filter === "user-only" ? "user" : this.#filter === "labeled-only" ? "labeled" : this.#filter}]`}${this.#timestamps ? " [+label time]" : ""}`,
						),
						width,
					),
				],
				invalidate() {},
			});
		}
		this.addChild(new Spacer(1));
		this.addChild(border);
	}
	#renderRows(width: number): string[] {
		if (!this.#visible.length) return new Text(this.#theme.noMatch("No entries found"), 1, 0).render(width);
		const start = Math.min(
			Math.max(0, this.#index - Math.floor(this.#limit / 2)),
			Math.max(0, this.#visible.length - this.#limit),
		);
		const rows = this.#visible.slice(start, start + this.#limit).map((item) => {
			const role = item.target.kind === "entry" ? item.target.entry.model?.[0]?.role : undefined;
			const prefix = item.prefix ?? "   ".repeat(item.depth) + (item.depth ? "└─ " : "");
			const foldable = this.#foldable(item.value),
				folded = this.#folded.has(item.value);
			const branchPrefix = prefix.replace(/([└├])─ /g, `$1${folded ? "⊞" : foldable ? "⊟" : "─"} `);
			const marker = `${folded && !/[└├]/.test(branchPrefix) ? "⊞ " : ""}${item.active ? "• " : ""}`;
			const tag = plainText(
				item.tag === undefined
					? ""
					: `[${item.tag}]${this.#timestamps && item.tagUpdated !== undefined ? ` ${labelTimestamp(item.tagUpdated)}` : ""}`,
			).replace(/[\n\t]/g, " ");
			const text = plainText(item.text)
				.replace(/[\n\t]/g, " ")
				.trim();
			const fg = (role: import("../../core/ui/theme.ts").ThemeToken, text: string) =>
				this.#palette?.fg(role, text) ?? text;
			const roleLabel =
				role === "user"
					? fg("accent", "user: ")
					: role === "assistant"
						? fg("success", "assistant: ")
						: role
							? fg("muted", `[${role}] `)
							: "";
			const body =
				fg("dim", branchPrefix) + fg("accent", marker) + fg("warning", tag) + (tag ? " " : "") + roleLabel + text;
			return {
				body: item.value === this.#selected ? (this.#palette?.bold(body) ?? body) : body,
				anchor: visibleWidth(branchPrefix + marker),
				selected: item.value === this.#selected,
			};
		});
		const viewport = Math.max(0, width - 2);
		const selected = rows.find((row) => row.selected);
		const useful = Math.min(20, Math.max(4, Math.floor(viewport / 3)));
		const context = Math.min(12, Math.max(2, Math.floor(viewport / 4)));
		const offset =
			selected && selected.anchor > viewport - useful
				? Math.max(
						0,
						Math.min(Math.max(...rows.map((row) => visibleWidth(row.body))) - viewport, selected.anchor - context),
					)
				: 0;
		return rows.map((row) => {
			const body = sliceByColumn(row.body, offset, viewport, true);
			const line = truncateToWidth(`${row.selected ? "› " : "  "}${body}`, width, "");
			return row.selected ? (this.#palette?.bg("selectedBg", line) ?? this.#theme.selectedText(line)) : line;
		});
	}
	#foldable(value: string): boolean {
		if (!this.#children.get(value)?.length) return false;
		const parent = this.#parents.get(value);
		return !parent || (this.#children.get(parent)?.length ?? 0) > 1;
	}
	#segment(value: string, direction: "up" | "down"): string {
		const selected = value;
		for (;;) {
			if (direction === "down") {
				const children = this.#children.get(value) ?? [];
				const first = children[0];
				if (!first || this.#folded.has(value)) return value;
				if (children.length > 1) return first;
				value = first;
			} else {
				const parent = this.#parents.get(value);
				if (!parent || ((this.#children.get(parent)?.length ?? 0) > 1 && value !== selected)) return value;
				value = parent;
			}
		}
	}

	handleInput(data: string): void {
		const keys = getKeybindings();
		if (this.#editing) {
			if (keys.matches(data, "tui.select.cancel")) {
				this.#editing = false;
				this.#refresh();
			} else if (keys.matches(data, "tui.select.confirm") && this.#selected)
				this.#done({
					action: "label",
					value: this.#selected,
					label: this.#label.getValue().trim() || undefined,
					filter: this.#filter,
				});
			else this.#label.handleInput(data);
			return;
		}
		const direct = filterActions.findIndex((action) => keys.matches(data, action));
		if (direct >= 0) {
			const filter = filters[direct];
			if (filter) this.#filter = filter === this.#filter ? "default" : filter;
			this.#folded.clear();
			this.#refresh();
			return;
		}
		if (keys.matches(data, "app.tree.filter.cycleForward") || keys.matches(data, "app.tree.filter.cycleBackward")) {
			this.#filter =
				filters[
					(filters.indexOf(this.#filter) +
						(keys.matches(data, "app.tree.filter.cycleForward") ? 1 : filters.length - 1)) %
						filters.length
				] ?? "default";
			this.#folded.clear();
			this.#refresh();
			return;
		}
		const item = this.#visible[this.#index];
		if (keys.matches(data, "tui.select.cancel")) {
			if (this.#search.getValue()) {
				this.#search.setValue("");
				this.#folded.clear();
				this.#refresh();
			} else this.#done({ action: "cancel", filter: this.#filter });
		} else if (keys.matches(data, "tui.select.confirm")) {
			if (item) this.#done({ action: "select", value: item.value, filter: this.#filter });
		} else if (keys.matches(data, "app.tree.editLabel")) {
			if (item?.target.kind === "entry") {
				this.#label.setValue(item.tag ?? "");
				this.#editing = true;
				this.#refresh();
			}
		} else if (keys.matches(data, "app.tree.toggleLabelTimestamp")) this.#timestamps = !this.#timestamps;
		else if (keys.matches(data, "app.message.copy")) {
			if (item) void this.#copy(item.text).catch(() => {});
		} else if (keys.matches(data, "app.tree.foldOrUp")) {
			if (item && this.#foldable(item.value) && !this.#folded.has(item.value)) this.#folded.add(item.value);
			else if (item) this.#selected = this.#segment(item.value, "up");
			this.#refresh();
		} else if (keys.matches(data, "app.tree.unfoldOrDown")) {
			if (item && !this.#folded.delete(item.value)) this.#selected = this.#segment(item.value, "down");
			this.#refresh();
		} else if (
			(
				[
					"tui.select.up",
					"tui.select.down",
					"tui.select.pageUp",
					"tui.select.pageDown",
					"tui.editor.cursorLeft",
					"tui.editor.cursorRight",
				] as const
			).some((action) => keys.matches(data, action))
		) {
			const step =
				keys.matches(data, "tui.select.pageUp") || keys.matches(data, "tui.editor.cursorLeft")
					? -this.#limit
					: keys.matches(data, "tui.select.pageDown") || keys.matches(data, "tui.editor.cursorRight")
						? this.#limit
						: keys.matches(data, "tui.select.up")
							? -1
							: 1;
			this.#index =
				Math.abs(step) === 1
					? (this.#index + step + this.#visible.length) % (this.#visible.length || 1)
					: Math.min(Math.max(0, this.#index + step), Math.max(0, this.#visible.length - 1));
			this.#selected = this.#visible[this.#index]?.value;
		} else {
			this.#search.handleInput(data);
			this.#folded.clear();
			this.#refresh();
		}
	}
}
