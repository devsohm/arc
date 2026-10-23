import { Input, getKeybindings, truncateToWidth, type Component, type Focusable, type SelectListTheme } from "@arc/tui";
import { plainText } from "../../core/ui/text.ts";
import {
	sessionLabel,
	type SavedSession,
	type SessionPickerRequest,
	type SessionScope,
} from "../../core/sessions/session-actions.ts";
import { shortcut } from "./components.ts";

export function filterSessions(items: readonly SavedSession[], query: string): SavedSession[] {
	const terms = query.match(/"[^"]*"|\S+/g) ?? [];
	const checks = terms.map((term) =>
		term.startsWith("re:") ? new RegExp(term.slice(3), "i") : term.replace(/^"|"$/g, "").toLowerCase(),
	);
	return items.filter((item) => {
		const text = `${sessionLabel(item)} ${item.path} ${item.cwd ?? ""}`;
		return checks.every((check) => (typeof check === "string" ? text.toLowerCase().includes(check) : check.test(text)));
	});
}
export class SessionSelector implements Component, Focusable {
	readonly #request: SessionPickerRequest;
	readonly #done: (path: string | undefined) => void;
	readonly #redraw: () => void;
	readonly #theme: SelectListTheme;
	readonly #limit: number;
	readonly #search = new Input({ placeholder: "Search sessions" });
	readonly #name = new Input();
	#items: readonly SavedSession[] = [];
	#visible: SavedSession[] = [];
	#scope: SessionScope = "current";
	#sort: "recent" | "name" = "recent";
	#named = false;
	#paths = false;
	#index = 0;
	#busy = false;
	#error = "";
	#mode: "list" | "delete" | "rename" = "list";
	#target: SavedSession | undefined;
	#focused = false;
	#disposed = false;
	get focused() {
		return this.#focused;
	}
	set focused(value: boolean) {
		this.#focused = value;
		this.#search.focused = value && this.#mode === "list";
		this.#name.focused = value && this.#mode === "rename";
	}
	constructor(
		request: SessionPickerRequest,
		done: (path: string | undefined) => void,
		redraw: () => void,
		theme: SelectListTheme,
		limit = 10,
	) {
		this.#request = request;
		this.#done = done;
		this.#redraw = () => {
			if (!this.#disposed) redraw();
		};
		this.#theme = theme;
		this.#limit = limit;
		void this.#load();
	}
	async #load(): Promise<void> {
		this.#busy = true;
		this.#redraw();
		try {
			this.#items = await this.#request.load(this.#scope);
			this.#error = "";
			this.#refresh();
		} catch (error) {
			this.#error = error instanceof Error ? error.message : String(error);
		} finally {
			this.#busy = false;
			this.#redraw();
		}
	}
	#refresh(): void {
		const selected = this.#visible[this.#index]?.path;
		try {
			this.#visible = filterSessions(
				this.#items.filter((item) => !this.#named || !!item.name?.trim()),
				this.#search.getValue(),
			);
		} catch {
			this.#error = "Invalid regular expression";
			this.#visible = [];
			return;
		}
		this.#visible.sort(
			this.#sort === "name"
				? (a, b) => sessionLabel(a).localeCompare(sessionLabel(b)) || b.modified - a.modified
				: (a, b) => b.modified - a.modified || a.path.localeCompare(b.path),
		);
		const at = this.#visible.findIndex((item) => item.path === selected);
		this.#index = at >= 0 ? at : Math.min(this.#index, Math.max(0, this.#visible.length - 1));
	}
	async #apply(): Promise<void> {
		const target = this.#target;
		if (!target) return;
		this.#busy = true;
		try {
			if (this.#mode === "delete") await this.#request.remove(target.path);
			else await this.#request.rename(target.path, this.#name.getValue());
			this.#error = "";
		} catch (error) {
			this.#error = error instanceof Error ? error.message : String(error);
		}
		this.#mode = "list";
		this.#target = undefined;
		this.focused = this.#focused;
		const error = this.#error;
		await this.#load();
		if (error) this.#error = error;
		this.#redraw();
	}
	handleInput(data: string): void {
		const keys = getKeybindings();
		if (this.#busy) {
			if (keys.matches(data, "tui.select.cancel")) this.#done(undefined);
			return;
		}
		if (this.#mode !== "list") {
			if (keys.matches(data, "tui.select.cancel")) {
				this.#mode = "list";
				this.#target = undefined;
				this.focused = this.#focused;
			} else if (keys.matches(data, "tui.select.confirm")) void this.#apply();
			else if (this.#mode === "rename") this.#name.handleInput(data);
			this.#redraw();
			return;
		}
		const selected = this.#visible[this.#index];
		this.#error = "";
		if (keys.matches(data, "tui.select.cancel")) this.#done(undefined);
		else if (keys.matches(data, "tui.input.tab")) {
			this.#scope = this.#scope === "current" ? "all" : "current";
			void this.#load();
		} else if (keys.matches(data, "app.session.toggleSort")) {
			this.#sort = this.#sort === "recent" ? "name" : "recent";
			this.#refresh();
		} else if (keys.matches(data, "app.session.toggleNamedFilter")) {
			this.#named = !this.#named;
			this.#refresh();
		} else if (keys.matches(data, "app.session.togglePath")) this.#paths = !this.#paths;
		else if (
			keys.matches(data, "app.session.delete") ||
			(!this.#search.getValue() && keys.matches(data, "app.session.deleteNoninvasive"))
		) {
			if (selected?.path === this.#request.current) this.#error = "Cannot delete the current session";
			else if (selected?.busy) this.#error = "Session is open in another process";
			else if (selected) {
				this.#target = selected;
				this.#mode = "delete";
			}
		} else if (keys.matches(data, "app.session.rename") && selected) {
			this.#target = selected;
			this.#mode = "rename";
			this.#name.setValue(selected.name ?? "");
			this.focused = this.#focused;
		} else if (keys.matches(data, "tui.select.up")) this.#index = Math.max(0, this.#index - 1);
		else if (keys.matches(data, "tui.select.down")) this.#index = Math.min(this.#visible.length - 1, this.#index + 1);
		else if (keys.matches(data, "tui.select.pageUp")) this.#index = Math.max(0, this.#index - this.#limit);
		else if (keys.matches(data, "tui.select.pageDown"))
			this.#index = Math.min(this.#visible.length - 1, this.#index + this.#limit);
		else if (keys.matches(data, "tui.select.confirm") && selected) this.#done(selected.path);
		else {
			this.#search.handleInput(data);
			this.#refresh();
		}
		this.#redraw();
	}
	render(width: number): string[] {
		const clean = (text: string) => truncateToWidth(plainText(text), width);
		const header = clean(
			`Resume session · ${this.#scope === "current" ? "Current folder" : "All folders"} · ${this.#sort} · ${this.#named ? "Named" : "All names"}`,
		);
		if (this.#mode === "delete")
			return [
				header,
				"",
				clean(`Permanently delete ${sessionLabel(this.#target!)}?`),
				clean("Enter confirms · Esc cancels"),
			];
		if (this.#mode === "rename")
			return [header, "", clean("Session name"), ...this.#name.render(width), clean("Enter saves · Esc cancels")];
		const rows = [header, ...this.#search.render(width), ""];
		if (this.#busy) rows.push("Loading sessions…");
		else {
			const start = Math.max(0, this.#index - this.#limit + 1);
			for (let i = start; i < Math.min(this.#visible.length, start + this.#limit); i++) {
				const item = this.#visible[i]!;
				const label = clean(
					`${i === this.#index ? "> " : "  "}${sessionLabel(item)}${item.path === this.#request.current ? " [current]" : item.busy ? " [open]" : ""} · ${new Date(item.modified).toLocaleString()}`,
				);
				rows.push(i === this.#index ? this.#theme.selectedText(label) : label);
				if (this.#paths) rows.push(clean(`  ${item.path}`));
				else if (this.#scope === "all" && item.cwd) rows.push(clean(`  ${item.cwd}`));
			}
			if (!this.#visible.length) rows.push("No sessions found");
		}
		rows.push(
			"",
			clean(
				`${shortcut("tui.input.tab", "Tab")} scope · ${shortcut("app.session.toggleSort", "Ctrl+S")} sort · ${shortcut("app.session.toggleNamedFilter", "Ctrl+N")} named · ${shortcut("app.session.togglePath", "Ctrl+P")} paths`,
			),
			clean(
				`${shortcut("app.session.delete", "Ctrl+D")} delete · ${shortcut("app.session.rename", "Ctrl+R")} rename · Enter open · Esc cancel`,
			),
		);
		if (this.#error) rows.push(clean(this.#error));
		return rows;
	}
	dispose(): void {
		this.#disposed = true;
	}
	invalidate(): void {
		this.#search.invalidate();
		this.#name.invalidate();
	}
}
