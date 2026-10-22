import { realpath, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { readJsonFile, withFileUpdate } from "./file-storage.ts";

const schema = Type.Record(Type.String(), Type.Boolean());
async function entries(home: string): Promise<Record<string, boolean>> {
	const data = await readJsonFile(join(home, "trust.json"));
	if (data === undefined) return {};
	if (!Value.Check(schema, data)) throw new Error("Invalid project trust store");
	return data;
}
export async function projectTrust(home: string, cwd: string): Promise<boolean | undefined> {
	const decisions = new Map(Object.entries(await entries(home)));
	for (let path = await realpath(cwd); ; path = dirname(path)) {
		if (decisions.has(path)) return decisions.get(path);
		if (dirname(path) === path) return undefined;
	}
}
export async function saveProjectTrust(home: string, cwd: string, decision: boolean, parent = false): Promise<void> {
	const canonical = await realpath(cwd);
	await withFileUpdate(join(home, "trust.json"), async () => {
		const decisions = new Map(Object.entries(await entries(home)));
		if (parent) {
			decisions.delete(canonical);
			decisions.set(dirname(canonical), decision);
		} else decisions.set(canonical, decision);
		return { result: undefined, data: Object.fromEntries(decisions) };
	});
}
export async function hasProjectResources(cwd: string): Promise<boolean> {
	try {
		await stat(join(resolve(cwd), ".arc"));
		return true;
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
		throw error;
	}
}
