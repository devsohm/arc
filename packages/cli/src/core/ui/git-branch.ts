import { execFile } from "node:child_process";
import { watchFile, unwatchFile } from "node:fs";

function git(cwd: string, args: readonly string[]): Promise<string | undefined> {
	return new Promise((resolve) => {
		execFile("git", ["--no-optional-locks", ...args], { cwd, timeout: 2000, windowsHide: true }, (error, stdout) =>
			resolve(error ? undefined : stdout.trim()),
		);
	});
}

export class GitBranch {
	#value: string | null = null;
	#closed = false;
	#pending: Promise<void> | undefined;
	#again = false;
	readonly #paths = new Map<string, () => void>();
	readonly #listeners = new Set<() => void>();
	readonly cwd: string;
	private constructor(cwd: string) {
		this.cwd = cwd;
	}
	static async open(cwd: string): Promise<GitBranch> {
		const branch = new GitBranch(cwd);
		const [head, tables] = await Promise.all([
			git(cwd, ["rev-parse", "--path-format=absolute", "--git-path", "HEAD"]),
			git(cwd, ["rev-parse", "--path-format=absolute", "--git-path", "reftable/tables.list"]),
		]);
		if (!head) return branch;
		await branch.refresh();
		for (const path of [head, tables]) {
			if (!path) continue;
			const changed = () => {
				void branch.refresh();
			};
			branch.#paths.set(path, changed);
			watchFile(path, { interval: 250, persistent: false }, changed);
		}
		return branch;
	}
	get value(): string | null {
		return this.#value;
	}
	subscribe(listener: () => void): () => void {
		this.#listeners.add(listener);
		return () => {
			this.#listeners.delete(listener);
		};
	}
	refresh(): Promise<void> {
		if (this.#closed) return Promise.resolve();
		if (this.#pending) {
			this.#again = true;
			return this.#pending;
		}
		this.#pending = (async () => {
			do {
				this.#again = false;
				const next = await git(this.cwd, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
				const value = next || ((await git(this.cwd, ["rev-parse", "--verify", "HEAD"])) ? "detached" : null);
				if (this.#closed) return;
				if (value !== this.#value) {
					this.#value = value;
					for (const listener of this.#listeners) listener();
				}
			} while (this.#again);
		})().finally(() => {
			this.#pending = undefined;
		});
		return this.#pending;
	}
	close(): void {
		this.#closed = true;
		for (const [path, listener] of this.#paths) unwatchFile(path, listener);
		this.#paths.clear();
		this.#listeners.clear();
	}
}
