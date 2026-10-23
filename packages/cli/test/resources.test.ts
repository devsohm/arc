import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { expandPrompt, loadResources, promptForSkill } from "../src/core/resources/resources.ts";

const temporaryDirectories: string[] = [];
afterEach(async () => {
	for (const path of temporaryDirectories.splice(0)) await rm(path, { recursive: true, force: true });
});

async function fixture() {
	const root = await mkdtemp(join(tmpdir(), "arc-resources-"));
	temporaryDirectories.push(root);
	const home = join(root, "personal");
	const cwd = join(root, "project", "work");
	await mkdir(home, { recursive: true });
	await mkdir(cwd, { recursive: true });
	return { root, home, cwd };
}

async function put(path: string, content: string): Promise<string> {
	await mkdir(dirname(path), { recursive: true });
	await writeFile(path, content);
	return path;
}

test("instructions inherit from home and each ancestor, canonicalize duplicates, and leave child folders alone", async () => {
	const f = await fixture();
	const global = await put(join(f.home, "AGENTS.md"), "Personal instructions");
	const outer = await put(join(f.root, "AGENTS.md"), "Outer instructions");
	const project = await put(join(f.root, "project", "AGENTS.md"), "\uFEFFProject instructions");
	await symlink(project, join(f.cwd, "AGENTS.md"));
	await put(join(f.cwd, "child", "AGENTS.md"), "Child instructions");
	const result = await loadResources(f);
	expect(result.contextFiles.filter((file) => file.path.startsWith(f.root))).toEqual([
		{ path: global, content: "Personal instructions" },
		{ path: outer, content: "Outer instructions" },
		{ path: project, content: "Project instructions" },
	]);
	expect(result.skills).toEqual([]);
});

test("skills use YAML metadata, project names take precedence, and scanning stops at a skill root", async () => {
	const f = await fixture();
	const local = await put(
		join(f.cwd, ".arc", "skills", "category", "folder", "SKILL.md"),
		"---\nname: review\ndescription: >-\n  Review changes\n  with tests.\n---\nPrivate instructions",
	);
	const personal = await put(
		join(f.home, "skills", "format", "SKILL.md"),
		"---\ndescription: 'Format: the selected file'\n---\nFormat instructions",
	);
	await put(
		join(f.home, "skills", "review", "SKILL.md"),
		"---\nname: review\ndescription: Old personal review\n---\nOld instructions",
	);
	await put(
		join(f.home, "skills", "format", "nested", "SKILL.md"),
		"---\nname: hidden-child\ndescription: Must stay hidden\n---",
	);
	await put(join(f.home, "skills", ".hidden", "SKILL.md"), "---\nname: hidden\ndescription: Hidden\n---");
	await put(join(f.home, "skills", "node_modules", "SKILL.md"), "---\nname: dependency\ndescription: Dependency\n---");
	await put(join(f.cwd, "unrelated", "SKILL.md"), "---\nname: unrelated\ndescription: Outside resources\n---");
	await put(join(f.home, "skills", "notes.md"), "Not a declared skill");
	await symlink(join(f.home, "skills"), join(f.home, "skills", "loop"));
	expect((await loadResources(f)).skills).toEqual([
		{ name: "format", description: "Format: the selected file", path: personal },
		{ name: "review", description: "Review changes with tests.", path: local },
	]);
});

test("templates load direct Markdown children and resolve duplicate names and physical files", async () => {
	const f = await fixture();
	const local = await put(
		join(f.cwd, ".arc", "prompts", "review.md"),
		"\uFEFF---\r\ndescription: Review a file\r\n---\r\n\r\nInspect $1 for ${2:-defects}.\r\n",
	);
	const fallback = await put(join(f.home, "prompts", "explain.md"), "\nExplain $1.\nSecond line");
	await put(join(f.home, "prompts", "review.md"), "Personal review");
	await put(join(f.home, "prompts", "nested", "ignored.md"), "Nested template");
	await symlink(fallback, join(f.home, "prompts", "explain-alias.md"));
	const result = await loadResources(f);
	expect(result.prompts).toEqual([
		{ name: "explain-alias", description: "Explain $1.", path: fallback, content: "Explain $1.\nSecond line" },
		{ name: "review", description: "Review a file", path: local, content: "Inspect $1 for ${2:-defects}." },
	]);
	expect(expandPrompt(result.prompts[1]?.content ?? "", '"src/main.ts" security')).toBe(
		"Inspect src/main.ts for security.",
	);
});

test("extension discovery finds supported modules and directory entries without evaluating code or dependencies", async () => {
	const f = await fixture();
	const global = await put(
		join(f.home, "extensions", "global.mjs"),
		'throw new Error("Must not execute during discovery")',
	);
	const directory = join(f.cwd, ".arc", "extensions");
	const files = [];
	for (const name of ["a.ts", "b.mts", "d.mjs", "e.js"])
		files.push(await put(join(directory, name), "export default { name: 'example' }"));
	const bundle = await put(join(directory, "bundle", "index.mts"), "export default { name: 'bundle' }");
	await put(join(directory, "bundle", "helper.ts"), "export const helper = true");
	await put(join(directory, "types.d.ts"), "declare const ignored: string");
	await put(join(directory, "types.d.mts"), "declare const ignored: string");
	await put(join(directory, "commonjs.cjs"), "module.exports = {}");
	await put(join(directory, "unsupported.tsx"), "export default <span />");
	await put(join(directory, "node_modules", "index.js"), "throw new Error('dependency')");
	await put(join(f.root, "project", ".arc", "extensions", "ancestor.ts"), "throw new Error('ancestor')");
	await symlink(global, join(directory, "z-alias.mjs"));
	await symlink(join(directory, "missing.ts"), join(directory, "broken.ts"));
	expect((await loadResources(f)).extensionFiles).toEqual([global, files[0], files[1], bundle, files[2], files[3]]);
});

test.each([
	["---\nname: sample\ndescription: [broken\n---", "Invalid frontmatter"],
	["---\n- one\n- two\n---", "must be a mapping"],
	["---\nname: 4\ndescription: Work\n---", "name must be a nonempty string"],
	["---\nname: sample\n---", "description is required"],
	["---\nname: sample", "Unclosed frontmatter"],
])("malformed skill metadata produces a path-specific error", async (content, message) => {
	const f = await fixture();
	const path = await put(join(f.home, "skills", "sample", "SKILL.md"), content);
	await expect(loadResources(f)).rejects.toThrow(message);
	await expect(loadResources(f)).rejects.toThrow(path);
});

test("absent optional folders leave an empty catalog", async () => {
	const f = await fixture();
	const result = await loadResources({ cwd: f.cwd, home: join(f.root, "missing") });
	expect({ skills: result.skills, prompts: result.prompts, extensions: result.extensionFiles }).toEqual({
		skills: [],
		prompts: [],
		extensions: [],
	});
	await put(join(f.cwd, ".arc", "prompts", "hello.md"), "Hello $1");
	expect(
		(await loadResources({ cwd: f.cwd, home: join(f.root, "missing") })).prompts.map((prompt) => prompt.name),
	).toEqual(["hello"]);
});

test("explicit roots merge their resource folders without inheriting instructions or scanning unrelated files", async () => {
	const f = await fixture();
	const extra = join(f.cwd, "extra");
	const skill = await put(
		join(extra, "skills", "review", "SKILL.md"),
		"---\nname: review\ndescription: Explicit review\n---\nUse the receipt.",
	);
	const prompt = await put(join(extra, "prompts", "review.md"), "Explicit $1");
	const extension = await put(join(extra, "extensions", "receipt.ts"), "export default { name: 'receipt' }");
	await put(join(f.cwd, ".arc", "prompts", "review.md"), "Project review");
	await put(join(extra, "AGENTS.md"), "Must not become inherited instructions");
	await put(join(extra, "unrelated", "ignored.ts"), "throw new Error('outside resources')");
	const loaded = await loadResources({ ...f, paths: ["extra", "extra"] });
	expect(loaded.skills).toEqual([{ name: "review", description: "Explicit review", path: skill }]);
	expect(loaded.prompts).toEqual([
		{ name: "review", description: "Explicit $1", path: prompt, content: "Explicit $1" },
	]);
	expect(loaded.extensionFiles).toEqual([extension]);
	expect(loaded.contextFiles.some((file) => file.path === join(extra, "AGENTS.md"))).toBe(false);
});

test.each([
	["[$1][$2][$3]", '"first file" second', "[first file][second][]"],
	["$1|$2|$3", 'one" two" \'three four\' ""', "one two|three four|"],
	["$1|$2", "one\\ two three", "one two|three"],
	["$@|$ARGUMENTS", 'alpha "beta gamma"', "alpha beta gamma|alpha beta gamma"],
	["${1:-fallback}|${2:-next}", '"" value', "fallback|value"],
	["${@:-none}|${ARGUMENTS:-also none}", "", "none|also none"],
	["${@:2}|${@:2:1}|${@:0:2}", "alpha beta gamma", "beta gamma|beta|alpha beta"],
	["$1 ${2:-$ARGUMENTS}", "'$@'", "$@ $ARGUMENTS"],
	["$0 $3 ${HOME}", "one two", "  ${HOME}"],
])("prompt expansion uses argument values once", (template, args, expected) => {
	expect(expandPrompt(template, args)).toBe(expected);
});

test("unfinished quoting fails before a template is submitted", () => {
	expect(() => expandPrompt("Inspect $1", '"unfinished')).toThrow("unfinished quote");
	expect(expandPrompt("Inspect $1", '"finished"')).toBe("Inspect finished");
});

test("explicit skill requests name the file without eagerly loading its body or expanding the request", () => {
	const result = promptForSkill(
		{ name: "review", description: "Review files", path: "/skills/review/SKILL.md" },
		"Check $1\nKeep this request literal.",
	);
	expect(result).toContain('Read "/skills/review/SKILL.md" before doing the work.');
	expect(result).toContain('from "/skills/review".');
	expect(result).toContain("Check $1\nKeep this request literal.");
});
