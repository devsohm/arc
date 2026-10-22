import { parseArgs } from "node:util";
export const BUILTIN_FLAGS = {
	help: { type: "boolean", short: "h" },
	version: { type: "boolean" },
	print: { type: "boolean", short: "p" },
	mode: { type: "string" },
	provider: { type: "string" },
	model: { type: "string" },
	models: { type: "string" },
	thinking: { type: "string" },
	cwd: { type: "string" },
	home: { type: "string" },
	session: { type: "string" },
	continue: { type: "boolean", short: "c" },
	backend: { type: "string" },
	extension: { type: "string", multiple: true },
	"no-extensions": { type: "boolean" },
	trust: { type: "boolean" },
	"no-trust": { type: "boolean" },
	tools: { type: "string" },
	codemode: { type: "boolean" },
	fullscreen: { type: "boolean" },
	"list-models": { type: "boolean" },
	"system-prompt": { type: "string" },
	"append-system-prompt": { type: "string" },
	"tool-execution": { type: "string" },
} as const;

export function parseStartupArgs(argv: readonly string[]) {
	const initial = parseArgs({
		args: [...argv],
		allowPositionals: true,
		tokens: true,
		strict: false,
		options: BUILTIN_FLAGS,
	});
	const known = initial.tokens.flatMap((token) =>
		token.kind === "option" && Object.hasOwn(BUILTIN_FLAGS, token.name)
			? [token.value === undefined ? `--${token.name}` : `--${token.name}=${token.value}`]
			: [],
	);
	const parsed = parseArgs({ args: known, options: BUILTIN_FLAGS });
	return {
		...parsed,
		positionals: initial.positionals,
		hasUnknownOptions: initial.tokens.some(
			(token) => token.kind === "option" && !Object.hasOwn(BUILTIN_FLAGS, token.name),
		),
	};
}
