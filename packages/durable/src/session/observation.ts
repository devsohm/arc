import type { Context } from "../shared/context/index.ts";
import type { JsonValue } from "../shared/json.ts";
import { withoutAbortSignal } from "../shared/context/index.ts";
import type { Op } from "../shared/state/delta/index.ts";
import { errorMessage } from "../errors.ts";
import type { JsonObject, WatchEnd, WatchHandle } from "../types.ts";
export type ObservedDocumentValue = Readonly<JsonObject> | null;

type WatchFrame<Value> = {
	readonly value: Value;
	readonly ops: readonly Op[];
	readonly context: Context;
	readonly retires?: true;
};
export class CommittedWatch<Value = ObservedDocumentValue> implements WatchHandle<Value> {
	readonly #end = Promise.withResolvers<WatchEnd>();
	#detach: (() => void) | undefined;
	#report: ((error: unknown) => void) | undefined;
	#replacement: (() => Value) | undefined;
	readonly #queue: WatchFrame<Value>[] = [];
	#value: Value;
	#listener: ((value: Value, ops: readonly Op[], context: Context) => Promise<void>) | undefined;
	#started = false;
	#scheduled = false;
	#running = false;
	#retired = false;
	#terminal = false;
	#cancel: { signal: AbortSignal; callback: () => void } | undefined;
	constructor(value: Value, detach: () => void, report: (error: unknown) => void, replacement?: () => Value) {
		this.#value = value;
		this.#detach = detach;
		this.#report = report;
		this.#replacement = replacement;
	}
	get value(): Value {
		return this.#value;
	}
	get closed(): Promise<WatchEnd> {
		return this.#end.promise;
	}
	start(listener: (value: Value, ops: readonly Op[], context: Context) => Promise<void>): void {
		if (this.#started) throw new Error("Watch is already started");
		if (this.#terminal) throw new Error("Watch is stopped");
		this.#started = true;
		this.#listener = listener;
		if (this.#queue.length) this.#schedule();
	}
	stop(): Promise<WatchEnd> {
		this.#finish({ reason: "stopped" });
		return this.closed;
	}
	cancel(): void {
		this.#finish({ reason: "cancelled" });
	}
	observeCancellation(signal: AbortSignal): void {
		if (this.#cancel) throw new Error("Watch cancellation is already installed");
		if (this.#terminal) return;
		const callback = () => this.cancel();
		this.#cancel = { signal, callback };
		signal.addEventListener("abort", callback, { once: true });
		if (signal.aborted) callback();
	}
	end(failure?: { readonly error: unknown }): void {
		this.#finish(failure ? { reason: "failed", error: failure.error } : { reason: "ended" });
	}
	advance(value: Value, ops: readonly Op[], context: Context): void {
		if (this.#terminal || this.#retired) return;
		if (this.#queue.length >= 100) {
			this.#queue.length = 0;
			const replacement = this.#replacement?.() ?? value;
			this.#queue.push({ value: replacement, ops: [["r", replacement as JsonValue]], context });
		} else this.#queue.push({ value, ops, context });
		if (this.#started) this.#schedule();
	}
	retire(this: CommittedWatch<ObservedDocumentValue>, context: Context): void {
		if (this.#terminal || this.#retired) return;
		this.#retired = true;
		if (this.#queue.length >= 100) this.#queue.length = 0;
		this.#queue.push({ value: null, ops: [["r", null]], context, retires: true });
		if (this.#started) this.#schedule();
	}

	#schedule(): void {
		if (this.#terminal || this.#running || this.#scheduled) return;
		this.#scheduled = true;
		queueMicrotask(() => {
			this.#scheduled = false;
			void this.#deliver();
		});
	}
	async #deliver(): Promise<void> {
		if (this.#terminal || this.#running || !this.#listener) return;
		this.#running = true;
		try {
			while (!this.#terminal && this.#queue.length) {
				const frame = this.#queue.shift()!;
				this.#value = frame.value;
				try {
					await this.#listener(frame.value, frame.ops, withoutAbortSignal(frame.context));
				} catch (error) {
					if (!this.#terminal) {
						this.#report?.(error);
						this.#finish({
							reason: "listener_error",
							error: error instanceof Error ? error : new Error(errorMessage(error)),
						});
					}
					break;
				}
				if (frame.retires) this.#finish({ reason: "retired" });
			}
		} finally {
			this.#running = false;
			if (!this.#terminal && this.#queue.length) this.#schedule();
		}
	}
	#finish(end: WatchEnd): void {
		if (this.#terminal) return;
		this.#terminal = true;
		const detach = this.#detach;
		this.#detach = undefined;
		this.#report = undefined;
		this.#replacement = undefined;
		this.#listener = undefined;
		this.#queue.length = 0;
		if (this.#cancel) this.#cancel.signal.removeEventListener("abort", this.#cancel.callback);
		this.#cancel = undefined;
		detach?.();
		this.#end.resolve(end);
	}
}
