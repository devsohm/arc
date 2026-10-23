import type { Context } from "./context/index.ts";
import type { Op } from "./state/delta/index.ts";

export type WatchEnd =
	| { readonly reason: "stopped" | "cancelled" | "ended" | "retired" }
	| { readonly reason: "listener_error"; readonly error: Error }
	| { readonly reason: "failed"; readonly error: unknown };
export interface WatchHandle<Value> {
	readonly value: Value;
	readonly closed: Promise<WatchEnd>;
	start(listener: (value: Value, ops: readonly Op[], context: Context) => Promise<void>): void;
	stop(): Promise<WatchEnd>;
}
