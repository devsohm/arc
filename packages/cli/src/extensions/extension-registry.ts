import { createRegistry, type Extension, type Registry, type RegistrySnapshot } from "@arc/durable";
import type { ApplicationExtension } from "../core/types.ts";

export class ApplicationRegistry implements Registry {
	readonly source = createRegistry();
	readonly #changes = new Map<Extension, ApplicationExtension>();
	readonly #owners = new WeakMap<Extension, Extension>();
	readonly #listeners = new Set<() => void>();
	#snapshot: RegistrySnapshot = this.source.snapshot();
	constructor() {
		this.source.subscribe(() => {
			for (const owner of this.#changes.keys()) if (!this.owns(owner)) this.#changes.delete(owner);
			this.#publish();
		});
	}
	owner(definition: Extension): ApplicationExtension {
		return this.#owners.get(definition) ?? definition;
	}
	owns(definition: Extension): boolean {
		const owner = this.owner(definition);
		return this.source.snapshot().extension(owner.name) === owner;
	}
	effective(definition: Extension): ApplicationExtension {
		const owner = this.owner(definition);
		return this.#changes.get(owner) ?? owner;
	}
	amend(owner: Extension, change: (current: ApplicationExtension) => ApplicationExtension): void {
		owner = this.owner(owner);
		if (!this.owns(owner)) throw new Error("Extension is no longer loaded");
		const next = change(this.effective(owner));
		if (next.name !== owner.name) throw new Error("Dynamic registration cannot rename its extension");
		this.#owners.set(next, owner);
		this.#changes.set(owner, next);
		this.#publish();
	}
	clear(owner: Extension): void {
		if (this.#changes.delete(this.owner(owner))) this.#publish();
	}
	#publish(): void {
		const source = this.source.snapshot();
		const installed = source.installed().map((definition) => this.effective(definition));
		const names = new Map(installed.map((definition) => [definition.name, definition]));
		this.#snapshot = {
			...source,
			installed: () => installed,
			extension: (name) => names.get(name),
			tools: () => installed.flatMap((extension) => (extension.tools ?? []).map((tool) => ({ extension, tool }))),
			sections: () =>
				installed.flatMap((extension) => (extension.sections ?? []).map((section) => ({ extension, section }))),
		};
		for (const listener of [...this.#listeners]) listener();
	}
	snapshot(): RegistrySnapshot {
		return this.#snapshot;
	}
	subscribe(listener: () => void): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}
	install(extension: Extension): void {
		this.source.install(extension);
	}
	uninstall(extension: Extension): void {
		this.source.uninstall(extension);
	}
}
