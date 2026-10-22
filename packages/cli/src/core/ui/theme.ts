import { systemTheme } from "./system-theme.ts";
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import {
	backgroundAnsi,
	foregroundAnsi,
	parseColor,
	styleTextWithAnsi,
	colorToHex,
	colorToRgb,
	getTerminalColorMode,
	type Color,
	type TerminalColorMode,
	type TerminalColors,
	type TextAttributes,
} from "@arc/tui";
import { readJsonFile } from "../configuration/file-storage.ts";

const defaults = {
	accent: 6,
	border: 8,
	borderAccent: 6,
	borderMuted: 8,
	success: 2,
	error: 1,
	warning: 3,
	muted: 8,
	dim: 8,
	text: "",
	thinkingText: 8,
	scrollbarTrack: 8,
	scrollbarThumb: "",
	selectedBg: 8,
	searchMatchBg: 8,
	searchMatchText: "",
	userMessageBg: "",
	userMessageText: "",
	customMessageBg: "",
	customMessageText: "",
	customMessageLabel: 6,
	toolPendingBg: "",
	toolSuccessBg: "",
	toolErrorBg: "",
	toolTitle: "",
	toolOutput: "",
	mdHeading: 6,
	mdLink: 6,
	mdLinkUrl: 8,
	mdCode: 3,
	mdCodeBlock: "",
	mdCodeBlockBorder: 8,
	mdQuote: 8,
	mdQuoteBorder: 8,
	mdHr: 8,
	mdListBullet: 6,
	toolDiffAdded: 2,
	toolDiffRemoved: 1,
	toolDiffContext: 8,
	syntaxComment: 8,
	syntaxKeyword: 5,
	syntaxFunction: 4,
	syntaxVariable: "",
	syntaxString: 2,
	syntaxNumber: 3,
	syntaxType: 6,
	syntaxOperator: "",
	syntaxPunctuation: 8,
	thinkingOff: 8,
	thinkingMinimal: 8,
	thinkingLow: 6,
	thinkingMedium: 4,
	thinkingHigh: 5,
	thinkingXhigh: 1,
	thinkingMax: 1,
	bashMode: 3,
} satisfies Record<string, string | number>;
export type ThemeToken = keyof typeof defaults;
const fallbacks = new Map<ThemeToken, ThemeToken>([
	["scrollbarTrack", "muted"],
	["scrollbarThumb", "text"],
	["searchMatchBg", "selectedBg"],
	["searchMatchText", "text"],
	["thinkingMax", "thinkingXhigh"],
]);
function isToken(key: string): key is ThemeToken {
	return Object.hasOwn(defaults, key);
}
const colorSchema = Type.Union([Type.String(), Type.Integer({ minimum: 0, maximum: 255 })]);
const schema = Type.Object(
	{
		$schema: Type.Optional(Type.String()),
		name: Type.String({ minLength: 1, pattern: "^[^/\\\\]+$" }),
		appearance: Type.Optional(Type.Union([Type.Literal("light"), Type.Literal("dark")])),
		vars: Type.Optional(Type.Record(Type.String(), colorSchema)),
		colors: Type.Record(Type.String(), colorSchema),
		export: Type.Optional(
			Type.Object(
				{ pageBg: Type.Optional(colorSchema), cardBg: Type.Optional(colorSchema), infoBg: Type.Optional(colorSchema) },
				{ additionalProperties: false },
			),
		),
	},
	{ additionalProperties: false },
);
export type ThemeJson = Static<typeof schema>;

export class Theme {
	readonly name: string;
	readonly appearance: "dark" | "light";
	readonly sourcePath: string | undefined;
	readonly colors: Readonly<Partial<Record<ThemeToken, Color>>>;
	readonly definition: Readonly<ThemeJson>;
	readonly exportColors: Readonly<{
		pageBg: string | undefined;
		cardBg: string | undefined;
		infoBg: string | undefined;
	}>;
	readonly #mode: TerminalColorMode;
	readonly #faint: ReadonlySet<ThemeToken>;
	constructor(
		input: unknown,
		options: { path?: string; mode?: TerminalColorMode; builtin?: boolean; faint?: readonly ThemeToken[] } = {},
	) {
		if (!Value.Check(schema, input))
			throw new Error(`Invalid theme document${options.path ? `: ${options.path}` : ""}`);
		if (input.name === "system" && !options.builtin) throw new Error("The system theme name is reserved");
		const document = structuredClone(input);
		for (const key of Object.keys(document.colors)) if (!isToken(key)) throw new Error(`Unknown theme token: ${key}`);
		for (const key of Object.keys(defaults))
			if (isToken(key) && !fallbacks.has(key) && !Object.hasOwn(document.colors, key))
				throw new Error(`Missing theme token: ${key}`);
		const resolve = (value: string | number, seen = new Set<string>()): Color | undefined => {
			if (value === "") return undefined;
			if (typeof value === "string" && Object.hasOwn(document.vars ?? {}, value)) {
				if (seen.has(value)) throw new Error(`Circular theme variable: ${value}`);
				const next = document.vars?.[value];
				if (next !== undefined) return resolve(next, new Set([...seen, value]));
			}
			return Object.freeze(parseColor(value));
		};
		const resolveToken = (key: ThemeToken): Color | undefined => {
			const value = document.colors[key];
			if (value !== undefined) return resolve(value);
			const fallback = fallbacks.get(key);
			return fallback ? resolveToken(fallback) : undefined;
		};
		for (const value of Object.values(document.vars ?? {})) resolve(value);
		const exportColor = (value: string | number | undefined): string | undefined => {
			const color = value === undefined ? undefined : resolve(value);
			return color ? colorToHex(color) : undefined;
		};
		this.exportColors = Object.freeze({
			pageBg: exportColor(document.export?.pageBg),
			cardBg: exportColor(document.export?.cardBg),
			infoBg: exportColor(document.export?.infoBg),
		});
		const resolved = Object.fromEntries(
			Object.keys(defaults).map((key): readonly [string, Color | undefined] => [
				key,
				isToken(key) ? resolveToken(key) : undefined,
			]),
		);
		Object.setPrototypeOf(resolved, null);
		// Keeping the complete shape makes missing values mean terminal default, rather than an absent role.
		this.colors = Object.freeze(resolved);
		this.name = document.name;
		const background = this.colors.userMessageBg;
		const rgb = background ? colorToRgb(background) : undefined;
		this.appearance =
			document.appearance ?? (rgb && rgb.r * 0.2126 + rgb.g * 0.7152 + rgb.b * 0.0722 > 128 ? "light" : "dark");
		this.sourcePath = options.path;
		this.#mode = options.mode ?? "truecolor";
		this.#faint = new Set(options.faint);
		Object.freeze(document.colors);
		if (document.vars) Object.freeze(document.vars);
		if (document.export) Object.freeze(document.export);
		this.definition = Object.freeze(document);
	}
	getColorMode(): TerminalColorMode {
		return this.#mode;
	}
	getFgAnsi(token: ThemeToken): string {
		if (!Object.hasOwn(this.colors, token)) throw new Error(`Unknown theme role: ${token}`);
		const color = this.colors[token];
		return (color ? foregroundAnsi(color, this.#mode) : "\x1b[39m") + (this.#faint.has(token) ? "\x1b[2m" : "");
	}
	getBgAnsi(token: ThemeToken): string {
		if (!Object.hasOwn(this.colors, token)) throw new Error(`Unknown theme role: ${token}`);
		const color = this.colors[token];
		return color ? backgroundAnsi(color, this.#mode) : "\x1b[49m";
	}
	fg(token: ThemeToken, text: string): string {
		return styleTextWithAnsi(text, this.getFgAnsi(token), undefined, { dim: this.#faint.has(token) });
	}
	bg(token: ThemeToken, text: string): string {
		return styleTextWithAnsi(text, undefined, this.getBgAnsi(token), {});
	}
	style(text: string, options: TextAttributes & { fg?: ThemeToken; bg?: ThemeToken } = {}): string {
		return styleTextWithAnsi(
			text,
			options.fg ? this.getFgAnsi(options.fg) : undefined,
			options.bg ? this.getBgAnsi(options.bg) : undefined,
			{ ...options, dim: options.dim || (options.fg !== undefined && this.#faint.has(options.fg)) },
		);
	}
	bold(text: string): string {
		return this.style(text, { bold: true });
	}
	italic(text: string): string {
		return this.style(text, { italic: true });
	}
	underline(text: string): string {
		return this.style(text, { underline: true });
	}
	inverse(text: string): string {
		return this.style(text, { inverse: true });
	}
	strikethrough(text: string): string {
		return this.style(text, { strikethrough: true });
	}
	getThinkingBorderColor(level: string): (text: string) => string {
		const name = `thinking${level.charAt(0).toUpperCase()}${level.slice(1)}`;
		const token = isToken(name) ? name : "border";
		return (text) => this.fg(token, text);
	}
}

function builtin(
	name: "system" | "light" | "dark",
	mode: TerminalColorMode,
	terminal: TerminalColors = {},
	fallbackAppearance: "light" | "dark" = "dark",
	saturation = 1,
): Theme {
	const result = systemTheme(
		name === "system"
			? terminal
			: { background: name === "light" ? { r: 255, g: 255, b: 255 } : { r: 22, g: 25, b: 29 } },
		fallbackAppearance,
		saturation,
		Object.keys(defaults).filter(isToken),
	);
	return new Theme(
		{ name, appearance: result.appearance, colors: result.colors },
		{ mode, builtin: true, faint: result.faint },
	);
}

export class ThemeCatalog {
	#themes: Map<string, Theme>;
	#paths: readonly string[] = [];
	readonly #mode: TerminalColorMode;
	#appearance: "light" | "dark" = "dark";
	#terminal: TerminalColors = {};
	constructor(mode: TerminalColorMode = getTerminalColorMode()) {
		this.#mode = mode;
		this.#themes = new Map(
			["system", "light", "dark"].map((name) => {
				const theme = builtin(
					name === "light" ? "light" : name === "dark" ? "dark" : "system",
					mode,
					{},
					"dark",
					name === "system" ? 0 : 1,
				);
				return [theme.name, theme];
			}),
		);
	}
	get(name: string): Theme | undefined {
		return this.#themes.get(name);
	}
	all(): { name: string; path: string | undefined }[] {
		return [...this.#themes.values()].map((theme) => ({ name: theme.name, path: theme.sourcePath }));
	}
	beginTerminalColors(appearance?: "light" | "dark"): void {
		if (appearance && appearance !== this.#appearance) {
			this.#terminal = {};
			this.#appearance = appearance;
		}
		this.#themes.set("system", builtin("system", this.#mode, this.#terminal, this.#appearance, 0));
	}

	setTerminalColors(colors: TerminalColors, appearance?: "light" | "dark"): void {
		if (appearance && appearance !== this.#appearance) {
			this.#terminal = {};
			this.#appearance = appearance;
		}
		this.#terminal = {
			foreground: colors.foreground ?? this.#terminal.foreground,
			background: colors.background ?? this.#terminal.background,
			palette: colors.palette ?? this.#terminal.palette,
		};
		const theme = builtin("system", this.#mode, this.#terminal, this.#appearance);
		this.#appearance = theme.appearance;
		this.#themes.set("system", theme);
	}
	resolve(setting = "system", appearance: "dark" | "light" = this.#appearance): Theme {
		const pair = setting.split("/");
		if (pair.length > 2 || pair.some((name) => !name)) throw new Error(`Invalid theme selection: ${setting}`);
		const name = pair.length === 2 ? pair[appearance === "light" ? 0 : 1] : pair[0];
		const theme = name ? this.get(name) : undefined;
		if (!theme) throw new Error(`Unknown theme: ${name}`);
		return theme;
	}
	async reload(paths = this.#paths): Promise<void> {
		const next = new Map(
			[...this.#themes].filter(([name]) => name === "system" || name === "light" || name === "dark"),
		);
		const seen = new Set<string>();
		for (const path of paths) {
			let info;
			try {
				info = await stat(path);
			} catch (error) {
				if (error instanceof Error && "code" in error && error.code === "ENOENT") continue;
				throw error;
			}
			const files = info.isDirectory()
				? (await readdir(path))
						.filter((name) => name.endsWith(".json"))
						.sort()
						.map((name) => join(path, name))
				: [path];
			for (const file of files) {
				if (seen.has(file)) continue;
				seen.add(file);
				const theme = new Theme(await readJsonFile(file), { path: file, mode: this.#mode });
				if (next.has(theme.name)) throw new Error(`Duplicate theme name: ${theme.name}`);
				next.set(theme.name, theme);
			}
		}
		this.#themes = next;
		this.#paths = [...paths];
	}
}
