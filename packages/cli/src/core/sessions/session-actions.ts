import { lstat, readdir, realpath, rm } from "node:fs/promises";
import { join, relative, resolve, isAbsolute, basename } from "node:path";
import { createSession, AgentDoc, ROOT_CONVERSATION_ID } from "@arc/durable";
import { BACKGROUND_CONTEXT as context } from "@arc/durable/context";
import { openNodeSqliteStorage } from "@arc/durable/storage/sqlite/node";
import { openNodeJsonlStorage } from "@arc/durable/storage/jsonl/node";
import { lockSession, listSessions, type SessionLocation } from "./sessions.ts";
import { SessionInfo } from "./info.ts";

export interface SavedSession extends SessionLocation {
	readonly name?: string;
	readonly cwd?: string;
	readonly busy?: boolean;
}
export type SessionScope = "current" | "all";
export interface SessionPickerRequest {
	readonly current?: string;
	load(scope: SessionScope): Promise<readonly SavedSession[]>;
	remove(path: string): Promise<void>;
	rename(path: string, name: string): Promise<void>;
}
async function managedPath(home: string, path: string): Promise<string> {
	const root = await realpath(join(home, "sessions"));
	const entry = await lstat(path);
	if (
		entry.isSymbolicLink() ||
		!((entry.isFile() && path.endsWith(".sqlite")) || (entry.isDirectory() && path.endsWith(".jsonl")))
	)
		throw new Error("Not a managed session");
	const canonical = await realpath(path),
		offset = relative(root, canonical);
	if (offset.startsWith("..") || isAbsolute(offset)) throw new Error("Session is outside the session directory");
	return canonical;
}
async function open(path: string) {
	return createSession(
		path.endsWith(".jsonl") ? await openNodeJsonlStorage(path, context) : await openNodeSqliteStorage(path),
	);
}
export async function savedSessions(
	home: string,
	cwd: string,
	scope: SessionScope,
	active?: { path: string; name?: string },
): Promise<SavedSession[]> {
	let paths: SessionLocation[];
	if (scope === "current") paths = await listSessions(home, cwd);
	else {
		let directories;
		try {
			directories = await readdir(join(home, "sessions"), { withFileTypes: true });
		} catch (error) {
			if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
			throw error;
		}
		paths = [];
		for (const directory of directories) {
			if (!directory.isDirectory() || directory.name.startsWith(".")) continue;
			const folder = join(home, "sessions", directory.name);
			for (const name of await readdir(folder)) {
				const path = join(folder, name),
					stat = await lstat(path);
				if (
					!stat.isSymbolicLink() &&
					((stat.isFile() && name.endsWith(".sqlite")) || (stat.isDirectory() && name.endsWith(".jsonl")))
				)
					paths.push({ path, modified: stat.mtimeMs });
			}
		}
	}
	const results: SavedSession[] = [];
	for (const item of paths) {
		if (active && resolve(item.path) === resolve(active.path)) {
			results.push({ ...item, name: active.name, cwd });
			continue;
		}
		let release;
		try {
			release = await lockSession(item.path);
		} catch {
			results.push({ ...item, busy: true });
			continue;
		}
		try {
			const session = await open(item.path);
			try {
				const info = await session.snapshot(SessionInfo, context);
				const agent = await session.snapshot(AgentDoc, ROOT_CONVERSATION_ID, context);
				results.push({ ...item, name: info?.name, cwd: agent?.cwd });
			} finally {
				await session.close(context);
			}
		} catch {
			results.push(item);
		} finally {
			await release();
		}
	}
	return results.sort((a, b) => b.modified - a.modified || a.path.localeCompare(b.path));
}
export async function removeSavedSession(home: string, path: string, active?: string): Promise<void> {
	const canonical = await managedPath(home, path);
	if (active && canonical === (await realpath(active))) throw new Error("Cannot delete the current session");
	const release = await lockSession(canonical);
	try {
		await rm(canonical, { recursive: canonical.endsWith(".jsonl"), force: false });
		if (canonical.endsWith(".sqlite"))
			for (const suffix of ["-wal", "-shm"]) await rm(canonical + suffix, { force: true });
	} finally {
		await release();
	}
}
export async function renameSavedSession(home: string, path: string, name: string): Promise<void> {
	const canonical = await managedPath(home, path),
		release = await lockSession(canonical);
	try {
		const session = await open(canonical);
		try {
			await session.commit(async (tx) => {
				(await tx.doc(SessionInfo)).name = name.trim();
			}, context);
		} finally {
			await session.close(context);
		}
	} finally {
		await release();
	}
}
export const sessionLabel = (session: SavedSession): string => session.name?.trim() || basename(session.path);
