import { readFileSync, existsSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = fileURLToPath(new URL("..", import.meta.url));
const manifest = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
const lines = [
	"# Package import paths",
	"",
	"Generated from workspace package manifests. Run `node scripts/document-packages.mjs` to update this page. Run the same command with `--check` to detect stale output.",
	"",
	"Each import has a source entry and compiled TypeScript declarations. The declarations define exact signatures. The package specification describes behavior and ownership.",
	"",
];
for (const directory of manifest.workspaces) {
	const pkg = JSON.parse(readFileSync(path.join(root, directory, "package.json"), "utf8"));
	lines.push(
		`## ${pkg.name}`,
		"",
		`[README](../${directory}/README.md) · [Specification](../${directory}/docs/spec.md)`,
		"",
		"| Import | Source | Types |",
		"| --- | --- | --- |",
	);
	for (const [subpath, entry] of Object.entries(pkg.exports)) {
		if (entry === null) continue;
		if (typeof entry === "string") {
			if (!existsSync(path.resolve(root, directory, entry))) throw new Error(`Missing export file: ${entry}`);
			lines.push(
				`| \`${pkg.name}${subpath.slice(1)}\` | [\`${entry}\`](../${directory}/${entry.replace(/^\.\//, "")}) | Not applicable |`,
			);
			continue;
		}
		if (typeof entry !== "object") throw new Error(`Unexpected export: ${pkg.name}/${subpath}`);
		const source =
			entry.source ??
			(typeof entry.import === "string"
				? entry.import.replace(/^\.\/dist\//, "./src/").replace(/\.js$/, ".ts")
				: undefined);
		const types = entry.types;
		if (typeof source !== "string" || typeof types !== "string")
			throw new Error(`Missing source or types: ${pkg.name}/${subpath}`);
		if (!source.includes("*") && !existsSync(path.resolve(root, directory, source)))
			throw new Error(`Missing source: ${source}`);
		const name = pkg.name + (subpath === "." ? "" : subpath.slice(1));
		const sourceTarget = source.includes("*") ? path.posix.dirname(source) : source;
		lines.push(
			`| \`${name}\` | [\`${source}\`](../${directory}/${sourceTarget.replace(/^\.\//, "")}) | \`${types}\` |`,
		);
	}
	const blocked = Object.entries(pkg.exports)
		.filter(([, value]) => value === null)
		.map(([name]) => `\`${pkg.name}${name.slice(1)}\``);
	if (blocked.length) lines.push("", `Blocked imports: ${blocked.join(", ")}. These override wildcard exports.`);
	lines.push("");
}
const output = lines.join("\n");
const target = path.join(root, "docs/packages.md");
if (process.argv.includes("--check")) {
	if (readFileSync(target, "utf8") !== output) throw new Error("docs/packages.md is stale");
	console.log("Package documentation matches all workspace exports.");
} else writeFileSync(target, output);
