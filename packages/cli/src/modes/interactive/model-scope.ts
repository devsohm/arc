import { plainText } from "../../core/ui/text.ts";
import {
	Container,
	Input,
	SelectList,
	Text,
	fuzzyFilter,
	getKeybindings,
	type Focusable,
	type SelectItem,
	type SelectListTheme,
} from "@arc/tui";
import { selectTheme, shortcut } from "./components.ts";

export interface ModelScopeResult {
	readonly ids: string[];
	readonly save: boolean;
}

export class ModelScopeSelector extends Container implements Focusable {
	readonly #input = new Input({ placeholder: "Filter models" });
	readonly #results = new Container();
	readonly #items: readonly SelectItem[];
	readonly #selected: string[];
	readonly #done: (result: ModelScopeResult) => void;
	readonly #change: ((ids: string[]) => void) | undefined;
	readonly #theme: SelectListTheme;
	#list: SelectList;
	constructor(
		items: readonly SelectItem[],
		enabled: readonly string[] | undefined,
		done: (result: ModelScopeResult) => void,
		onChange?: (ids: string[]) => void,
		theme: SelectListTheme = selectTheme,
	) {
		super();
		this.#items = items.map((item) => ({
			...item,
			label: plainText(item.label),
			description: item.description === undefined ? undefined : plainText(item.description),
		}));
		this.#selected = [...(enabled ?? items.map((item) => item.value))];
		this.#done = done;
		this.#change = onChange;
		this.#theme = theme;
		this.addChild(new Text("Models for cycling", 1, 0));
		this.addChild(this.#input);
		this.addChild(this.#results);
		this.addChild(
			new Text(
				`${shortcut("app.models.toggle", "Space")} toggle · ${shortcut("app.models.reorderUp", "Alt+Up")}/${shortcut("app.models.reorderDown", "Alt+Down")} reorder · ${shortcut("app.models.enableAll", "Ctrl+A")} all · ${shortcut("app.models.clearAll", "Ctrl+X")} clear · ${shortcut("app.models.save", "Ctrl+S")} save · Esc close`,
				1,
				0,
			),
		);
		this.#list = this.#build();
	}
	get focused(): boolean {
		return this.#input.focused;
	}
	set focused(value: boolean) {
		this.#input.focused = value;
	}
	#build(current?: string): SelectList {
		const order = [
			...this.#selected,
			...this.#items.map((item) => item.value).filter((id) => !this.#selected.includes(id)),
		];
		const candidates = order.flatMap((id) => {
			const item = this.#items.find((item) => item.value === id);
			return item
				? [{ ...item, label: `${this.#selected.includes(id) ? "[x]" : "[ ]"} ${plainText(item.label)}` }]
				: [];
		});
		const filtered = fuzzyFilter(candidates, this.#input.getValue(), (item) => `${item.value} ${item.label}`);
		const list = new SelectList(filtered, 8, this.#theme);
		if (current) {
			const index = filtered.findIndex((item) => item.value === current);
			if (index >= 0) list.setSelectedIndex(index);
		}
		this.#results.clear();
		this.#results.addChild(list);
		return list;
	}
	handleInput(data: string): void {
		const bindings = getKeybindings();
		if (bindings.matches(data, "app.models.save") || bindings.matches(data, "app.models.apply")) {
			this.#done({ ids: [...this.#selected], save: bindings.matches(data, "app.models.save") });
			return;
		}
		const selected = this.#list.getSelectedItem()?.value;
		if (bindings.matches(data, "app.models.toggle")) {
			if (!selected) return;
			const index = this.#selected.indexOf(selected);
			if (index < 0) this.#selected.push(selected);
			else this.#selected.splice(index, 1);
		} else if (bindings.matches(data, "app.models.enableAll")) {
			this.#selected.splice(0, this.#selected.length, ...this.#items.map((item) => item.value));
		} else if (bindings.matches(data, "app.models.clearAll")) this.#selected.length = 0;
		else if (bindings.matches(data, "app.models.toggleProvider")) {
			const provider = selected?.slice(0, selected.indexOf("/"));
			if (!provider) return;
			const ids = this.#items.filter((item) => item.value.startsWith(provider + "/")).map((item) => item.value);
			const remove = ids.every((id) => this.#selected.includes(id));
			for (const id of ids) {
				const index = this.#selected.indexOf(id);
				if (remove && index >= 0) this.#selected.splice(index, 1);
				else if (!remove && index < 0) this.#selected.push(id);
			}
		} else if (bindings.matches(data, "app.models.reorderUp") || bindings.matches(data, "app.models.reorderDown")) {
			const index = selected === undefined ? -1 : this.#selected.indexOf(selected);
			const next = index + (bindings.matches(data, "app.models.reorderUp") ? -1 : 1);
			if (index >= 0 && next >= 0 && next < this.#selected.length) {
				const value = this.#selected.splice(index, 1)[0];
				if (value !== undefined) this.#selected.splice(next, 0, value);
			}
		} else if (
			(["tui.select.up", "tui.select.down", "tui.select.pageUp", "tui.select.pageDown"] as const).some((action) =>
				bindings.matches(data, action),
			)
		) {
			this.#list.handleInput(data);
			return;
		} else {
			this.#input.handleInput(data);
			this.#list = this.#build();
			return;
		}
		this.#list = this.#build(selected);
		this.#change?.([...this.#selected]);
	}
}
