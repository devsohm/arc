import { randomUUID } from "node:crypto";
import { realpath } from "node:fs/promises";
import { registerHooks } from "node:module";
import { extname, isAbsolute } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { Extension, Registry } from "../harness/types.ts";

const generationKey = "arc-extension";
let registered = false;
function register(): void {
	if (registered) return;
	registerHooks({
		resolve(specifier, context, nextResolve) {
			const generation = context.parentURL?.startsWith("file:")
				? new URL(context.parentURL).searchParams.get(generationKey)
				: undefined;
			let resolved;
			try {
				resolved = nextResolve(specifier, context);
			} catch (error) {
				if (
					!generation ||
					!specifier.startsWith("@arc/") ||
					!(error instanceof Error) ||
					!("code" in error) ||
					error.code !== "ERR_MODULE_NOT_FOUND"
				)
					throw error;
				resolved = nextResolve(specifier, { ...context, parentURL: import.meta.url });
			}
			if (!context.parentURL || !resolved.url.startsWith("file:")) return resolved;
			if (!generation || !(specifier.startsWith(".") || specifier.startsWith("file:") || isAbsolute(specifier)))
				return resolved;
			const url = new URL(resolved.url);
			url.searchParams.set(generationKey, generation);
			return { ...resolved, url: url.href };
		},
		load(url, context, nextLoad) {
			if (!url.startsWith("file:") || !new URL(url).searchParams.has(generationKey)) return nextLoad(url, context);
			const filename = fileURLToPath(url);
			const extension = extname(filename);
			const loaded = nextLoad(url, {
				...context,
				...([".ts", ".mts"].includes(extension) ? { format: "module-typescript" } : {}),
			});
			if (loaded.format === "commonjs" || loaded.format === "commonjs-typescript")
				throw new TypeError(`Extension modules must use ESM: ${filename}`);
			return loaded;
		},
	});
	registered = true;
}

/** Loads trusted ESM definitions into an existing Durable registry. */
export class ExtensionLoader {
	readonly #registry: Registry;
	readonly #validate: ((extension: Extension) => void) | undefined;
	readonly #loaded = new Map<string, Extension>();
	#pending: Promise<unknown> = Promise.resolve();
	#closing: Promise<void> | undefined;

	constructor(registry: Registry, validate?: (extension: Extension) => void) {
		this.#registry = registry;
		this.#validate = validate;
	}

	#enqueue<T>(operation: () => Promise<T>): Promise<T> {
		if (this.#closing) return Promise.reject(new Error("Extension loader is closed"));
		const result = this.#pending.then(operation);
		this.#pending = result.catch(() => {});
		return result;
	}

	load(filename: string): Promise<Extension> {
		return this.#enqueue(async () => {
			const path = await realpath(filename);
			register();
			const url = pathToFileURL(path);
			url.searchParams.set(generationKey, randomUUID());
			const module: { default?: Extension } = await import(url.href);
			const extension = module.default;
			if (!extension || typeof extension !== "object" || typeof extension.name !== "string" || !extension.name)
				throw new TypeError("An extension module must default-export an Extension with a nonempty name");
			this.#validate?.(extension);
			const previous = this.#loaded.get(path);
			if (previous && previous.name !== extension.name)
				throw new Error(`Reload cannot rename extension ${previous.name} to ${extension.name}`);
			const installed = this.#registry.snapshot().extension(extension.name);
			if (installed && installed !== previous)
				throw new Error(`Extension ${extension.name} belongs to another registration`);
			try {
				this.#registry.install(extension);
			} finally {
				if (this.#registry.snapshot().extension(extension.name) === extension) this.#loaded.set(path, extension);
			}
			return extension;
		});
	}

	unload(filename: string): Promise<boolean> {
		return this.#enqueue(async () => {
			const path = fileURLToPath(pathToFileURL(filename));
			const canonical = this.#loaded.has(path) ? path : await realpath(path);
			const extension = this.#loaded.get(canonical);
			if (!extension) return false;
			this.#remove(canonical, extension);
			return true;
		});
	}

	#remove(path: string, extension: Extension): void {
		try {
			if (this.#registry.snapshot().extension(extension.name) === extension) this.#registry.uninstall(extension);
		} finally {
			if (this.#registry.snapshot().extension(extension.name) !== extension) this.#loaded.delete(path);
		}
	}

	close(): Promise<void> {
		if (this.#closing) return this.#closing;
		this.#closing = this.#pending.then(() => {
			const errors: unknown[] = [];
			for (const [path, extension] of this.#loaded) {
				try {
					this.#remove(path, extension);
				} catch (error) {
					errors.push(error);
				}
			}
			if (errors.length) throw new AggregateError(errors, "Failed to remove extensions");
		});
		return this.#closing;
	}
}
