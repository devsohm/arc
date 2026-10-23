import { readdir, readFile, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { isMap, parseDocument } from "yaml";

export interface ContextFile {
	readonly path: string;
	readonly content: string;
}

export interface Skill {
	readonly name: string;
	readonly description: string;
	readonly path: string;
}

export interface PromptTemplate extends Skill {
	readonly content: string;
}

export interface Resources {
	readonly contextFiles: readonly ContextFile[];
	readonly skills: readonly Skill[];
	readonly prompts: readonly PromptTemplate[];
	readonly extensionFiles: readonly string[];
}

function missing(error: unknown): boolean {
	return error instanceof Error && "code" in error && (error.code === "ENOENT" || error.code === "ENOTDIR");
}

async function entries(directory: string) {
	try {
		return (await readdir(directory, { withFileTypes: true })).sort((a, b) => compare(a.name, b.name));
	} catch (error) {
		if (missing(error)) return [];
		throw error;
	}
}

async function filePath(path: string): Promise<string | undefined> {
	try {
		return (await stat(path)).isFile() ? await realpath(path) : undefined;
	} catch (error) {
		if (missing(error)) return undefined;
		throw error;
	}
}

function compare(a: string, b: string): number {
	return a < b ? -1 : a > b ? 1 : 0;
}

function metadata(text: string, path: string) {
	const normalized = text.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
	const lines = normalized.split("\n");
	if (lines[0]?.trimEnd() !== "---") return { name: undefined, description: undefined, content: normalized.trim() };
	const end = lines.findIndex((line, index) => index > 0 && line.trimEnd() === "---");
	if (end < 0) throw new SyntaxError(`Unclosed frontmatter in ${path}`);
	const document = parseDocument(lines.slice(1, end).join("\n"));
	if (document.errors.length) throw new SyntaxError(`Invalid frontmatter in ${path}: ${document.errors[0]?.message}`);
	if (document.contents !== null && !isMap(document.contents))
		throw new TypeError(`Frontmatter must be a mapping in ${path}`);
	const name: unknown = document.get("name");
	const description: unknown = document.get("description");
	if (name !== undefined && (typeof name !== "string" || !name.trim()))
		throw new TypeError(`Frontmatter name must be a nonempty string in ${path}`);
	if (description !== undefined && (typeof description !== "string" || !description.trim()))
		throw new TypeError(`Frontmatter description must be a nonempty string in ${path}`);
	return {
		name: typeof name === "string" ? name.trim() : undefined,
		description: typeof description === "string" ? description.trim() : undefined,
		content: lines
			.slice(end + 1)
			.join("\n")
			.trim(),
	};
}

async function skillFiles(directory: string, visited = new Set<string>()): Promise<string[]> {
	let canonical: string;
	try {
		canonical = await realpath(directory);
	} catch (error) {
		if (missing(error)) return [];
		throw error;
	}
	if ((await stat(canonical)).isFile()) return canonical.endsWith(".md") ? [canonical] : [];
	if (visited.has(canonical)) return [];
	visited.add(canonical);
	const children = await entries(canonical);
	const declared = await filePath(join(canonical, "SKILL.md"));
	if (declared !== undefined) return [declared];
	const found: string[] = [];
	for (const child of children) {
		if (child.name.startsWith(".") || child.name === "node_modules") continue;
		if (child.isDirectory() || child.isSymbolicLink())
			found.push(...(await skillFiles(join(canonical, child.name), visited)));
	}
	return found;
}

const moduleSuffixes = [".ts", ".mts", ".mjs", ".js"];

async function extensionFiles(directory: string): Promise<string[]> {
	const found: string[] = [];
	for (const child of await entries(directory)) {
		if (child.name.startsWith(".") || child.name === "node_modules") continue;
		const path = join(directory, child.name);
		if (moduleSuffixes.some((suffix) => child.name.endsWith(suffix)) && !/\.d\.(?:ts|mts)$/.test(child.name)) {
			const file = await filePath(path);
			if (file !== undefined) found.push(file);
		} else if (child.isDirectory() || child.isSymbolicLink()) {
			for (const suffix of moduleSuffixes) {
				const file = await filePath(join(path, `index${suffix}`));
				if (file === undefined) continue;
				found.push(file);
				break;
			}
		}
	}
	return found;
}

export async function loadResourcePaths(
	skillPaths: readonly string[],
	promptPaths: readonly string[],
): Promise<Pick<Resources, "skills" | "prompts">> {
	const skills = new Map<string, Skill>(),
		prompts = new Map<string, PromptTemplate>();
	const seenPrompts = new Set<string>();
	for (const directory of skillPaths)
		for (const path of await skillFiles(directory)) {
			const parsed = metadata(await readFile(path, "utf8"), path);
			if (parsed.description === undefined) throw new TypeError(`Skill description is required in ${path}`);
			const name = parsed.name ?? basename(dirname(path));
			if (/\s|\//.test(name)) throw new TypeError(`Skill name must be a command name in ${path}`);
			if (!skills.has(name)) skills.set(name, { name, description: parsed.description, path });
		}
	for (const input of promptPaths) {
		const file = await filePath(input);
		const files = file
			? [input]
			: (await entries(input))
					.filter((child) => !child.name.startsWith(".") && child.name.endsWith(".md"))
					.map((child) => join(input, child.name));
		for (const candidate of files) {
			const path = await filePath(candidate);
			if (!path || seenPrompts.has(path)) continue;
			seenPrompts.add(path);
			const parsed = metadata(await readFile(path, "utf8"), path),
				name = basename(candidate, ".md");
			if (/\s/.test(name)) throw new TypeError(`Prompt filename must be a command name in ${path}`);
			if (!prompts.has(name))
				prompts.set(name, {
					name,
					description: parsed.description ?? parsed.content.split("\n").find((line) => line.trim()) ?? "",
					path,
					content: parsed.content,
				});
		}
	}
	return {
		skills: [...skills.values()].sort((a, b) => compare(a.name, b.name)),
		prompts: [...prompts.values()].sort((a, b) => compare(a.name, b.name)),
	};
}

export async function loadResources(options: {
	readonly cwd: string;
	readonly home?: string;
	readonly paths?: readonly string[];
	readonly projectTrusted?: boolean;
}): Promise<Resources> {
	const cwd = resolve(options.cwd);
	const home = resolve(options.home ?? join(homedir(), ".arc"));
	const additional = (options.paths ?? []).map((path) => resolve(cwd, path));
	const project = options.projectTrusted === false ? [] : [join(cwd, ".arc")];
	const ancestors: string[] = [];
	for (let directory = cwd; ; directory = dirname(directory)) {
		ancestors.unshift(directory);
		if (directory === dirname(directory)) break;
	}
	const contextFiles: ContextFile[] = [];
	const seenContext = new Set<string>();
	for (const directory of [home, ...ancestors]) {
		const path = await filePath(join(directory, "AGENTS.md"));
		if (path === undefined || seenContext.has(path)) continue;
		seenContext.add(path);
		contextFiles.push({ path, content: (await readFile(path, "utf8")).replace(/^\uFEFF/, "") });
	}
	const locations = [...additional, ...project, home];
	const discovered = await loadResourcePaths(
		locations.map((directory) => join(directory, "skills")),
		locations.map((directory) => join(directory, "prompts")),
	);

	const extensions = new Set<string>();
	for (const directory of [home, ...project, ...additional])
		for (const path of await extensionFiles(join(directory, "extensions"))) extensions.add(path);
	return {
		contextFiles,
		skills: discovered.skills,
		prompts: discovered.prompts,
		extensionFiles: [...extensions],
	};
}

function commandArguments(input: string): string[] {
	const lexer = /\s+|'([^']*)'|"((?:\\[\s\S]|[^"\\])*)"|\\([\s\S])|([^\s'"\\]+)/gy;
	const result: string[] = [];
	let word: string | undefined;
	while (lexer.lastIndex < input.length) {
		const match = lexer.exec(input);
		if (match === null) throw new SyntaxError("Prompt arguments contain an unfinished quote or escape");
		if (/^\s/.test(match[0])) {
			if (word !== undefined) result.push(word);
			word = undefined;
		} else {
			const part = match[1] ?? match[2]?.replace(/\\([\s\S])/g, "$1") ?? match[3] ?? match[4] ?? "";
			word = (word ?? "") + part;
		}
	}
	if (word !== undefined) result.push(word);
	return result;
}

export function expandPrompt(template: string, args: string): string {
	const values = commandArguments(args);
	const argument = (name: string): string | undefined => {
		if (name === "@" || name === "ARGUMENTS") return values.join(" ");
		return /^\d+$/.test(name) ? (values[Number(name) - 1] ?? "") : undefined;
	};
	return template.replace(
		/\$(?:\{([^{}]*)\}|(ARGUMENTS|@|\d+))/g,
		(original, braced: string | undefined, bare: string | undefined) => {
			const expression = braced ?? bare ?? "";
			const fallback = expression.indexOf(":-");
			if (fallback >= 0) {
				const value = argument(expression.slice(0, fallback));
				return value === undefined ? original : value || expression.slice(fallback + 2);
			}
			const slice = /^@:(\d+)(?::(\d+))?$/.exec(expression);
			if (slice !== null) {
				const start = Math.max(0, Number(slice[1]) - 1);
				return values.slice(start, slice[2] === undefined ? undefined : start + Number(slice[2])).join(" ");
			}
			return argument(expression) ?? original;
		},
	);
}

export function promptForSkill(skill: Skill, args: string): string {
	const instruction = `Apply the ${JSON.stringify(skill.name)} skill. Read ${JSON.stringify(skill.path)} before doing the work. Resolve its relative references from ${JSON.stringify(dirname(skill.path))}.`;
	return args.trim() ? `${instruction}\n\n${args}` : instruction;
}
