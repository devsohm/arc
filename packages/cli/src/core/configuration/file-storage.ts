import { randomUUID } from "node:crypto";
import { chmod, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import lockfile from "proper-lockfile";

function errorCode(error: unknown): string | undefined {
	return error instanceof Error && "code" in error && typeof error.code === "string" ? error.code : undefined;
}

function storageError(action: string, path: string, error: unknown): Error {
	const code = errorCode(error);
	return new Error(`Cannot ${action} ${path}${code ? ` (${code})` : ""}`);
}

export async function readJsonFile(path: string, signal?: AbortSignal): Promise<unknown> {
	signal?.throwIfAborted();
	let content: string;
	try {
		content = await readFile(path, { encoding: "utf8", signal });
	} catch (error) {
		signal?.throwIfAborted();
		if (errorCode(error) === "ENOENT") return undefined;
		throw storageError("read", path, error);
	}
	signal?.throwIfAborted();
	try {
		return JSON.parse(content.replace(/^\uFEFF/, ""));
	} catch {
		throw new Error(`Invalid JSON in ${path}`);
	}
}

async function writeJsonFile(path: string, data: unknown, check: () => void): Promise<void> {
	let content: string | undefined;
	try {
		content = JSON.stringify(data, null, 2);
	} catch {
		throw new Error(`Cannot serialize ${path}`);
	}
	if (content === undefined) throw new Error(`Cannot serialize ${path}`);
	const temporary = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);
	try {
		const file = await open(temporary, "wx", 0o600);
		try {
			await file.writeFile(`${content}\n`, "utf8");
			await file.sync();
		} finally {
			await file.close();
		}
		check();
		await rename(temporary, path);
	} catch (error) {
		check();
		throw storageError("write", path, error);
	} finally {
		await unlink(temporary).catch((error: unknown) => {
			if (errorCode(error) !== "ENOENT") throw storageError("remove temporary file for", path, error);
		});
	}
}

async function updateFile<T>(
	path: string,
	fn: () => Promise<{ result: T; data?: unknown }>,
	signal?: AbortSignal,
): Promise<T> {
	signal?.throwIfAborted();
	try {
		await mkdir(dirname(path), { recursive: true, mode: 0o700 });
		await chmod(dirname(path), 0o700);
	} catch (error) {
		throw storageError("create storage directory for", path, error);
	}
	let compromised = false;
	const check = () => {
		signal?.throwIfAborted();
		if (compromised) throw new Error(`Storage lock lost for ${path}`);
	};
	let release: (() => Promise<void>) | undefined;
	const deadline = Date.now() + 30_000;
	for (let attempt = 0; !release; attempt++) {
		check();
		try {
			release = await lockfile.lock(path, {
				realpath: false,
				stale: 30_000,
				onCompromised: () => {
					compromised = true;
				},
			});
		} catch (error) {
			check();
			if (errorCode(error) !== "ELOCKED" || Date.now() >= deadline) throw storageError("lock", path, error);
			await sleep(Math.min(10 * 2 ** Math.min(attempt, 4), 100), undefined, { signal });
		}
	}
	try {
		check();
		const { result, data } = await fn();
		check();
		if (data !== undefined) await writeJsonFile(path, data, check);
		check();
		return result;
	} finally {
		try {
			await release();
		} catch (error) {
			if (!compromised) throw storageError("unlock", path, error);
		}
	}
}

export function withFileUpdate<T>(
	path: string,
	fn: () => Promise<{ result: T; data?: unknown }>,
	signal?: AbortSignal,
): Promise<T> {
	const operation = updateFile(path, fn, signal);
	if (!signal) return operation;
	return new Promise<T>((resolve, reject) => {
		const abort = () => {
			signal.removeEventListener("abort", abort);
			reject(signal.reason);
		};
		signal.addEventListener("abort", abort, { once: true });
		void operation.then(
			(result) => {
				signal.removeEventListener("abort", abort);
				resolve(result);
			},
			(error) => {
				signal.removeEventListener("abort", abort);
				reject(error);
			},
		);
		if (signal.aborted) abort();
	});
}
