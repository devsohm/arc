import { mkdtemp, rm, writeFile, symlink, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSession } from "@arc/durable";
import { BACKGROUND_CONTEXT as context } from "@arc/durable/context";
import { openNodeSqliteStorage } from "@arc/durable/storage/sqlite/node";
import { openNodeJsonlStorage } from "@arc/durable/storage/jsonl/node";
import { expect, test } from "vitest";
import { newSessionFile, lockSession, listSessions } from "../src/core/sessions/sessions.ts";
import { savedSessions, removeSavedSession, renameSavedSession } from "../src/core/sessions/session-actions.ts";
import { SessionInfo } from "../src/core/sessions/info.ts";

test.each(["sqlite", "jsonl"] as const)(
	"session actions persist names and protect current, locked and external %s sessions",
	async (backend) => {
		const directory = await mkdtemp(join(tmpdir(), "arc-session-actions-"));
		try {
			const home = join(directory, "home"),
				cwd = join(directory, "work"),
				other = join(directory, "other");
			const file = await newSessionFile(home, cwd, backend),
				sibling = await newSessionFile(home, other, backend);
			for (const path of [file, sibling]) {
				const storage =
					backend === "sqlite" ? await openNodeSqliteStorage(path) : await openNodeJsonlStorage(path, context);
				const session = createSession(storage);
				await session.commit(async (tx) => {
					(await tx.doc(SessionInfo)).name = "Original";
				}, context);
				await session.close(context);
			}
			expect((await savedSessions(home, cwd, "current")).map((x) => x.path)).toEqual([file]);
			expect((await savedSessions(home, cwd, "all")).map((x) => x.path).sort()).toEqual([file, sibling].sort());
			await renameSavedSession(home, file, "Renamed");
			expect((await savedSessions(home, cwd, "current"))[0]?.name).toBe("Renamed");
			await expect(removeSavedSession(home, file, file)).rejects.toThrow("current session");
			const release = await lockSession(file);
			try {
				expect((await savedSessions(home, cwd, "current"))[0]?.busy).toBe(true);
				await expect(removeSavedSession(home, file)).rejects.toThrow("already open");
				await expect(renameSavedSession(home, file, "Bad")).rejects.toThrow("already open");
			} finally {
				await release();
			}
			const external = join(directory, "outside.sqlite");
			await writeFile(external, "untouched");
			await expect(removeSavedSession(home, external)).rejects.toThrow("outside");
			await access(external);
			const alias = join(file.substring(0, file.lastIndexOf("/")), "alias.sqlite");
			await symlink(external, alias);
			expect((await listSessions(home, cwd)).some((x) => x.path === alias)).toBe(false);
			await expect(removeSavedSession(home, alias)).rejects.toThrow("managed");
			await removeSavedSession(home, file);
			await expect(access(file)).rejects.toThrow();
			expect(await listSessions(home, cwd)).toEqual([]);
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	},
);
