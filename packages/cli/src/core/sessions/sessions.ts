import { createHash, randomUUID } from "node:crypto";
import { mkdir, readdir, stat, realpath, mkdtemp, cp, rename, rm, chmod } from "node:fs/promises";
import { dirname, join, resolve, basename } from "node:path";
import lockfile from "proper-lockfile";

export type SessionBackend = "sqlite" | "jsonl" | "memory";
export interface SessionLocation {
	readonly path: string;
	readonly modified: number;
}
export function sessionDirectory(home: string, cwd: string): string {
	const key = createHash("sha256").update(resolve(cwd)).digest("hex").slice(0, 20);
	return join(home, "sessions", key);
}
export async function listSessions(home: string, cwd: string): Promise<SessionLocation[]> {
	const directory = sessionDirectory(home, cwd);
	let names: string[];
	try {
		names = await readdir(directory);
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
		throw error;
	}
	const locations = await Promise.all(
		names
			.filter((name) => /\.(sqlite|jsonl)$/.test(name))
			.map(async (name) => {
				const path = join(directory, name);
				return { path, modified: (await stat(path)).mtimeMs };
			}),
	);
	return locations.sort((a, b) => b.modified - a.modified || a.path.localeCompare(b.path));
}
export async function newSessionFile(
	home: string,
	cwd: string,
	backend: Exclude<SessionBackend, "memory">,
): Promise<string> {
	const directory = sessionDirectory(home, cwd);
	await mkdir(directory, { recursive: true, mode: 0o700 });
	return join(directory, `${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID()}.${backend}`);
}

export async function copySession(source: string, destination: string): Promise<void> {
	const staging = await mkdtemp(join(dirname(destination), ".clone-"));
	try {
		const snapshot = join(staging, "snapshot");
		if (source.endsWith(".jsonl")) {
			await cp(await realpath(source), snapshot, {
				recursive: true,
				dereference: true,
				force: false,
				errorOnExist: true,
			});
		} else {
			const { DatabaseSync, backup } = await import("node:sqlite");
			const database = new DatabaseSync(source, { readOnly: true });
			try {
				await backup(database, snapshot);
				await chmod(snapshot, 0o600);
			} finally {
				database.close();
			}
		}
		await rename(snapshot, destination);
	} finally {
		await rm(staging, { recursive: true, force: true });
	}
}
export async function lockSession(path: string): Promise<() => Promise<void>> {
	await mkdir(dirname(path), { recursive: true, mode: 0o700 });
	let canonical: string;
	try {
		canonical = await realpath(path);
	} catch (error) {
		if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
		canonical = join(await realpath(dirname(path)), basename(path));
	}
	try {
		const release = await lockfile.lock(canonical, { realpath: false, stale: 30_000, update: 10_000, retries: 0 });
		let released = false;
		return async () => {
			if (released) return;
			released = true;
			await release();
		};
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ELOCKED")
			throw new Error(`Session is already open: ${path}`);
		throw error;
	}
}
