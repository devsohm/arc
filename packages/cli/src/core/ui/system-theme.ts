import { colorToOklch, colorToRgb, oklchColor, rgbColor, type RgbColor, type TerminalColors } from "@arc/tui";
import type { ThemeToken } from "./theme.ts";

type Appearance = "dark" | "light";
interface Ink {
	hue: number;
	chroma: number;
	slot: number;
}
const ink = {
	neutral: { hue: 220, chroma: 0.012, slot: 7 },
	accent: { hue: 215, chroma: 0.14, slot: 4 },
	positive: { hue: 150, chroma: 0.13, slot: 2 },
	negative: { hue: 355, chroma: 0.16, slot: 1 },
	caution: { hue: 70, chroma: 0.12, slot: 3 },
	detail: { hue: 285, chroma: 0.13, slot: 5 },
} satisfies Record<string, Ink>;
const white = { r: 255, g: 255, b: 255 };
const black = { r: 0, g: 0, b: 0 };
function luminance(color: RgbColor): number {
	const linear = (n: number) => (n <= 10.31475 ? n / 3294.6 : ((n / 255 + 0.055) / 1.055) ** 2.4);
	return linear(color.r) * 0.2126 + linear(color.g) * 0.7152 + linear(color.b) * 0.0722;
}
export function contrastRatio(a: RgbColor, b: RgbColor): number {
	const x = luminance(a) + 0.05,
		y = luminance(b) + 0.05;
	return x > y ? x / y : y / x;
}
export function terminalAppearance(background: RgbColor): Appearance {
	return contrastRatio(white, background) >= contrastRatio(black, background) ? "dark" : "light";
}
const rgb = (c: RgbColor) => rgbColor(c.r, c.g, c.b);
const hex = (c: RgbColor) => "#" + [c.r, c.g, c.b].map((n) => Math.round(n).toString(16).padStart(2, "0")).join("");
function colorRole(token: ThemeToken): Ink {
	if (token === "error" || token.includes("Removed") || token === "toolErrorBg") return ink.negative;
	if (token === "success" || token.includes("Added") || token === "toolSuccessBg" || token === "bashMode")
		return ink.positive;
	if (token === "warning" || token === "mdHeading" || token === "searchMatchBg") return ink.caution;
	if (
		token === "customMessageBg" ||
		token === "customMessageLabel" ||
		token === "syntaxString" ||
		token === "syntaxNumber"
	)
		return ink.detail;
	if (token.startsWith("thinking") && token !== "thinkingText") {
		const index = [
			"thinkingOff",
			"thinkingMinimal",
			"thinkingLow",
			"thinkingMedium",
			"thinkingHigh",
			"thinkingXhigh",
			"thinkingMax",
		].indexOf(token);
		return { hue: 210 + index * 25, chroma: 0.025 + index * 0.018, slot: index < 3 ? 4 : 5 };
	}
	if (
		token === "accent" ||
		token === "border" ||
		token === "borderAccent" ||
		token === "selectedBg" ||
		token === "userMessageBg" ||
		token === "mdLink" ||
		token === "mdCode" ||
		token === "mdListBullet" ||
		(token.startsWith("syntax") && !["syntaxComment", "syntaxOperator", "syntaxPunctuation"].includes(token))
	)
		return ink.accent;
	return ink.neutral;
}
function panel(token: ThemeToken): boolean {
	return token.endsWith("Bg");
}
function body(token: ThemeToken): boolean {
	return token === "text" || token === "userMessageText" || token === "toolTitle";
}
function faint(token: ThemeToken): boolean {
	return token === "dim" || token === "borderMuted" || token === "scrollbarTrack" || token === "thinkingOff";
}

export function systemTheme(
	input: TerminalColors,
	appearanceHint: Appearance,
	saturation: number,
	tokens: readonly ThemeToken[],
): {
	colors: Record<ThemeToken, string | number>;
	faint: ThemeToken[];
	appearance: Appearance;
} {
	const amount = Math.max(0, Math.min(1, saturation));
	const colors = Object.fromEntries(tokens.map((token) => [token, ""])) as Record<ThemeToken, string | number>;
	if (!input.background) {
		for (const token of tokens)
			if (!panel(token) && colorRole(token) !== ink.neutral && amount > 0) colors[token] = colorRole(token).slot;
		return {
			colors,
			faint: tokens.filter((token) => !panel(token) && !body(token) && colorRole(token) === ink.neutral),
			appearance: appearanceHint,
		};
	}
	const background = input.background,
		appearance = terminalAppearance(background);
	const dark = appearance === "dark",
		edge = dark ? white : black;
	const backgroundColor = colorToOklch(rgb(background));
	const palette = input.palette?.length === 16 ? input.palette : undefined;
	const source = (role: Ink) => {
		const reported = palette?.[role.slot];
		return reported ? colorToOklch(rgb(reported)) : { h: role.hue, c: role.chroma };
	};
	const paint = (h: number, c: number, l: number): RgbColor => {
		const value = colorToRgb(oklchColor(l, c * amount * 4 * l * (1 - l), h));
		return { r: Math.round(value.r), g: Math.round(value.g), b: Math.round(value.b) };
	};
	const surfaces: RgbColor[] = [background];
	for (const token of tokens.filter(panel)) {
		const base = source(colorRole(token));
		const lightness = Math.max(0, Math.min(1, backgroundColor.l + (dark ? 0.045 : -0.045)));
		const proposed = paint(base.h, Math.min(base.c, 0.035), lightness);
		const surface = contrastRatio(edge, proposed) >= 4.5 ? proposed : background;
		colors[token] = hex(surface);
		surfaces.push(surface);
	}
	const score = (c: RgbColor) => Math.min(...surfaces.map((surface) => contrastRatio(c, surface)));
	const available = score(edge);
	for (const token of tokens.filter((token) => !panel(token))) {
		const role = colorRole(token),
			base = source(role);
		const minimum = Math.min(available, faint(token) ? 3 : body(token) ? 7 : 4.5);
		if (body(token) && input.foreground && score(input.foreground) >= minimum) {
			colors[token] = "";
			continue;
		}
		let near = dark ? 0.72 : 0.38,
			far = dark ? 1 : 0;
		let color = paint(base.h, base.c, near);
		if (score(color) < minimum) {
			for (let step = 0; step < 24; step++) {
				const middle = (near + far) / 2;
				if (score(paint(base.h, base.c, middle)) >= minimum) far = middle;
				else near = middle;
			}
			color = paint(base.h, base.c, far);
		}
		colors[token] = hex(color);
	}
	return { colors, faint: [], appearance };
}
