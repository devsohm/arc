import { realpath } from "node:fs/promises";
import { dirname } from "node:path";
import {
	Container,
	ProcessTerminal,
	Spacer,
	Text,
	TuiMainScreen,
	getKeybindings,
	setKeybindings,
	type Terminal,
} from "@arc/tui";
import { loadKeybindings } from "../core/configuration/keybindings.ts";
import { loadSettings } from "../core/configuration/settings.ts";
import { ThemeCatalog } from "../core/ui/theme.ts";
import { saveProjectTrust } from "../core/configuration/trust.ts";
import type { ProjectTrustDecision } from "../core/types.ts";

export async function showProjectTrust(
	cwd: string,
	home: string,
	terminal: Terminal = new ProcessTerminal(),
): Promise<ProjectTrustDecision> {
	const canonical = await realpath(cwd);
	const parent = dirname(canonical);
	const choices = [
		{ label: "Trust", trusted: true, save: true, parent: false },
		...(parent === canonical
			? []
			: [{ label: `Trust parent folder (${parent})`, trusted: true, save: true, parent: true }]),
		{ label: "Trust (this session only)", trusted: true, save: false, parent: false },
		{ label: "Do not trust", trusted: false, save: true, parent: false },
		{ label: "Do not trust (this session only)", trusted: false, save: false, parent: false },
	];
	const settings = await loadSettings({ cwd, home, projectTrusted: false });
	const theme = new ThemeCatalog().resolve(settings.theme);
	const previous = getKeybindings();
	const bindings = await loadKeybindings(home);
	const tui = new TuiMainScreen(terminal);
	let selected = 0;
	let choose: (index: number | undefined) => void = () => {};
	const result = new Promise<number | undefined>((resolve) => {
		choose = resolve;
	});
	const border = { render: (width: number) => [theme.fg("borderAccent", "─".repeat(width))], invalidate() {} };
	const list = new Container();
	const update = () => {
		list.clear();
		for (const [index, choice] of choices.entries())
			list.addChild(new Text(index === selected ? theme.fg("accent", `→ ${choice.label}`) : `  ${choice.label}`, 1, 0));
	};
	const dialog = new Container();
	dialog.addChild(border);
	dialog.addChild(new Spacer(1));
	dialog.addChild(new Text(theme.fg("accent", theme.bold("Trust project folder?")), 1, 0));
	dialog.addChild(new Text(canonical, 1, 0));
	dialog.addChild(new Spacer(1));
	dialog.addChild(new Text("Trust allows Arc to load .arc settings and resources and run project extensions.", 1, 0));
	dialog.addChild(new Spacer(1));
	dialog.addChild(list);
	dialog.addChild(new Spacer(1));
	dialog.addChild(new Text(theme.fg("dim", "↑↓ navigate · Enter select · Escape cancel"), 1, 0));
	dialog.addChild(new Spacer(1));
	dialog.addChild(border);
	update();
	tui.addChild(dialog);
	tui.addInputListener((data) => {
		if (bindings.matches(data, "tui.select.up") || data === "k") selected = Math.max(0, selected - 1);
		else if (bindings.matches(data, "tui.select.down") || data === "j")
			selected = Math.min(choices.length - 1, selected + 1);
		else if (bindings.matches(data, "tui.select.confirm") || data === "\n") choose(selected);
		else if (bindings.matches(data, "tui.select.cancel") || data === "\x03" || data === "\x04") choose(undefined);
		update();
		tui.requestRender();
		return { consume: true };
	});
	setKeybindings(bindings);
	try {
		tui.start();
		const index = await result;
		const choice = index === undefined ? undefined : choices[index];
		if (choice?.save) await saveProjectTrust(home, canonical, choice.trusted, choice.parent);
		return { trusted: choice?.trusted ? "yes" : "no", remember: false };
	} finally {
		tui.clear();
		tui.requestRender();
		await new Promise((resolve) => setTimeout(resolve, 25));
		tui.stop();
		setKeybindings(previous);
	}
}
