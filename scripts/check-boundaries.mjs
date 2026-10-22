import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL("..", import.meta.url));
const workspaces = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).workspaces;
for (const directory of workspaces) {
	const pkg = JSON.parse(readFileSync(join(root, directory, "package.json"), "utf8"));
	assert.equal(pkg.name, `@arc/${directory.split("/").at(-1)}`, `Unexpected workspace name in ${directory}`);
	if (pkg.name === "@arc/cli") continue;
	assert.ok(!Object.hasOwn(pkg.dependencies ?? {}, "@arc/cli"), `${pkg.name} depends on the application`);
	for (const name of readdirSync(join(root, directory, "src"), { recursive: true }).filter((name) =>
		name.endsWith(".ts"),
	)) {
		const content = readFileSync(join(root, directory, "src", name), "utf8");
		assert.doesNotMatch(
			content,
			/(?:from\s*|import\s*\(|require\s*\()\s*["'](?:@arc\/cli|(?:\.\.\/)+cli(?:\/|["']))/,
			`${pkg.name}/${name} imports the application`,
		);
	}
}
console.log("Toolkit packages have no dependency or source import on the application.");
