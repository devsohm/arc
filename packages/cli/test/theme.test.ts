import { mkdir, mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, test } from "vitest";
import { colorToHex, stripTerminalSequences } from "@arc/tui";
import { Theme, ThemeCatalog } from "../src/core/ui/theme.ts";

const directories: string[] = [];
afterEach(async () => {
	await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});
function definition() {
	const source = new ThemeCatalog("truecolor").get("dark");
	if (!source) throw new Error("Built-in theme unavailable");
	return { ...structuredClone(source.definition), name: "fixture" };
}
test("theme values resolve chained variables, optional roles, default colors and every supported color syntax", () => {
	const document = definition();
	document.vars = { main: "secondary", secondary: "#1a2", warm: "oklch(65% 0.1 35)", cool: "okhsl(240 50% 50%)" };
	document.colors.accent = "main";
	document.colors.warning = "warm";
	document.colors.success = "cool";
	document.colors.error = 196;
	document.colors.text = "";
	document.export = { pageBg: "main", cardBg: 196, infoBg: "" };
	delete document.colors.scrollbarTrack;
	delete document.colors.thinkingMax;
	const theme = new Theme(document);
	expect(theme.colors.accent && colorToHex(theme.colors.accent)).toBe("#11aa22");
	expect(theme.getFgAnsi("error")).toBe("\x1b[38;5;196m");
	expect(theme.getFgAnsi("text")).toBe("\x1b[39m");
	expect(theme.exportColors).toEqual({ pageBg: "#11aa22", cardBg: "#ff0000", infoBg: undefined });
	expect(Object.isFrozen(theme.exportColors)).toBe(true);
	expect(theme.getFgAnsi("scrollbarTrack")).toBe(theme.getFgAnsi("muted"));
	expect(theme.getFgAnsi("thinkingMax")).toBe(theme.getFgAnsi("thinkingXhigh"));
	expect(stripTerminalSequences(theme.style("value", { fg: "accent", bg: "selectedBg", bold: true }))).toBe("value");
	expect(theme.getThinkingBorderColor("high")("value")).toContain(theme.getFgAnsi("thinkingHigh"));
	expect(theme.getThinkingBorderColor("unknown")("value")).toContain(theme.getFgAnsi("border"));
	expect(Object.isFrozen(theme.definition.colors)).toBe(true);
	expect(Object.hasOwn(theme.colors, "constructor")).toBe(false);
	expect(() => Reflect.apply(theme.fg, theme, ["constructor", "text"])).toThrow("Unknown theme role");
	document.colors.accent = "#fff";
	expect(theme.colors.accent && colorToHex(theme.colors.accent)).toBe("#11aa22");
});
test("invalid and circular values, missing roles and unknown properties fail before a theme can be selected", () => {
	const document = definition();
	expect(() => new Theme({ ...document, metadata: {} })).toThrow("Invalid theme");
	expect(() => new Theme({ ...document, name: "light/dark" })).toThrow("Invalid theme");
	expect(() => new Theme({ ...document, name: "system" })).toThrow("reserved");
	expect(() => new Theme({ ...document, colors: { ...document.colors, random: "#000" } })).toThrow(
		"Unknown theme token",
	);
	const missing = structuredClone(document);
	delete missing.colors.accent;
	expect(() => new Theme(missing)).toThrow("Missing theme token: accent");
	expect(() => new Theme({ ...document, vars: { first: "second", second: "first" } })).toThrow(
		"Circular theme variable",
	);
	expect(() => new Theme({ ...document, colors: { ...document.colors, accent: "missing" } })).toThrow("Invalid color");
	expect(() => new Theme({ ...document, colors: { ...document.colors, accent: 256 } })).toThrow("Invalid theme");
	expect(() => new Theme({ ...document, export: { pageBg: "missing" } })).toThrow("Invalid color");
});
test("catalog reload is atomic, detects collisions and resolves automatic light/dark selections", async () => {
	const directory = await mkdtemp(join(tmpdir(), "arc-themes-"));
	directories.push(directory);
	await mkdir(join(directory, "themes"));
	const path = join(directory, "themes", "fixture.json");
	await writeFile(path, JSON.stringify(definition()));
	const catalog = new ThemeCatalog("256color");
	await catalog.reload([join(directory, "themes")]);
	expect(catalog.get("fixture")?.sourcePath).toBe(path);
	expect(catalog.resolve("light/dark", "light").name).toBe("light");
	expect(catalog.resolve("light/dark", "dark").name).toBe("dark");
	expect(() => catalog.resolve("missing")).toThrow("Unknown theme");
	expect(() => catalog.resolve("light/dark/system")).toThrow("Invalid theme selection");
	const previous = catalog.get("fixture");
	await writeFile(path, "{invalid");
	await expect(catalog.reload()).rejects.toThrow("Invalid JSON");
	expect(catalog.get("fixture")).toBe(previous);
	await writeFile(path, JSON.stringify(definition()));
	await writeFile(join(directory, "themes", "duplicate.json"), JSON.stringify(definition()));
	await expect(catalog.reload()).rejects.toThrow("Duplicate theme name");
	expect(catalog.get("fixture")).toBe(previous);
	catalog.setTerminalColors({
		background: { r: 250, g: 250, b: 250 },
		foreground: { r: 25, g: 25, b: 25 },
		palette: [{ r: 0, g: 0, b: 0 }],
	});
	expect(catalog.resolve().appearance).toBe("light");
	expect(catalog.get("fixture")).toBe(previous);
});

test("system fallback leaves panel backgrounds to the terminal and keeps neutral hints faint", () => {
	const catalog = new ThemeCatalog("truecolor");
	const pending = catalog.get("system");
	expect(pending?.getFgAnsi("accent")).toBe("\x1b[39m");
	catalog.setTerminalColors({});
	const theme = catalog.get("system");
	if (!theme) throw new Error("Missing system theme");
	expect(theme.getBgAnsi("userMessageBg")).toBe("\x1b[49m");
	expect(theme.getFgAnsi("accent")).toBe("\x1b[38;5;4m");
	expect(theme.fg("muted", "hint")).toContain("\x1b[2m");
	expect(theme.fg("text", "text")).not.toContain("\x1b[2m");
	expect(stripTerminalSequences(theme.fg("muted", "hint"))).toBe("hint");
});

function ratio(a: { r: number; g: number; b: number }, b: { r: number; g: number; b: number }): number {
	const linear = (value: number) => {
		const x = value / 255;
		return x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
	};
	const brightness = (value: typeof a) =>
		0.2126 * linear(value.r) + 0.7152 * linear(value.g) + 0.0722 * linear(value.b);
	const x = brightness(a),
		y = brightness(b);
	return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

test("adaptive colors keep body text readable on every panel across dark, light and middle backgrounds", async () => {
	const { colorToRgb } = await import("@arc/tui");
	for (let gray = 0; gray <= 255; gray += 5) {
		const catalog = new ThemeCatalog("truecolor"),
			background = { r: gray, g: gray, b: gray };
		catalog.setTerminalColors({ background });
		const theme = catalog.resolve();
		const surfaces = [
			background,
			...Object.entries(theme.colors)
				.filter(([name]) => name.endsWith("Bg"))
				.map(([, value]) => {
					if (!value) throw new Error("Missing adaptive panel");
					return colorToRgb(value);
				}),
		];
		for (const name of ["text", "userMessageText", "toolTitle"] as const) {
			const color = theme.colors[name];
			if (!color) throw new Error("Missing adaptive body color");
			for (const surface of surfaces) expect(ratio(colorToRgb(color), surface)).toBeGreaterThanOrEqual(4.5);
		}
	}
});

test("adaptive colors use terminal palette hues, preserve a readable reported foreground and reject incomplete palettes", async () => {
	const { colorToRgb } = await import("@arc/tui");
	const background = { r: 18, g: 22, b: 28 },
		foreground = { r: 255, g: 255, b: 255 };
	const palette = Array.from({ length: 16 }, () => ({ r: 100, g: 160, b: 220 }));
	palette[4] = { r: 220, g: 80, b: 150 };
	const catalog = new ThemeCatalog("truecolor");
	catalog.setTerminalColors({ background, foreground, palette });
	const theme = catalog.resolve();
	expect(theme.getFgAnsi("text")).toBe("\x1b[39m");
	const accent = theme.colors.accent;
	if (!accent) throw new Error("Missing accent");
	const value = colorToRgb(accent);
	expect(value.r).toBeGreaterThan(value.g);
	expect(value.b).toBeGreaterThan(value.g);
	const incomplete = new ThemeCatalog("truecolor"),
		unreported = new ThemeCatalog("truecolor");
	incomplete.setTerminalColors({ background, palette: palette.slice(0, 1) });
	unreported.setTerminalColors({ background });
	expect(incomplete.resolve().definition.colors).toEqual(unreported.resolve().definition.colors);
});

test("appearance changes discard old palette reports and show grayscale until the next report", () => {
	const catalog = new ThemeCatalog("truecolor");
	catalog.setTerminalColors({ background: { r: 15, g: 15, b: 15 } });
	expect(catalog.resolve().getFgAnsi("accent")).not.toBe("\x1b[39m");
	catalog.beginTerminalColors("light");
	expect(catalog.resolve().appearance).toBe("light");
	expect(catalog.resolve().getFgAnsi("accent")).toBe("\x1b[39m");
	expect(catalog.resolve().getBgAnsi("userMessageBg")).toBe("\x1b[49m");
	catalog.setTerminalColors({ background: { r: 250, g: 250, b: 250 } });
	expect(catalog.resolve().getFgAnsi("accent")).not.toBe("\x1b[39m");
});
