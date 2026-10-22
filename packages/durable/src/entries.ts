import type { JsonValue } from "./shared/json.ts";
import type { Entry, EntryRecord, TypedEntry } from "./types.ts";
import type { CompactionReason, ToolDiagnostic } from "./harness/types.ts";

export function defineEntry<Value extends JsonValue = never>(kind: string): Entry<Value> {
	if (typeof kind !== "string" || !kind.length) throw new TypeError("Entry kind must be a non-empty string");
	return {
		kind,
		is(entry: EntryRecord | undefined): entry is TypedEntry<Value> {
			return entry?.kind === kind;
		},
	};
}

export const UserEntry = defineEntry("arc.user");
export const AssistantEntry = defineEntry("arc.assistant");
export const SystemEntry = defineEntry("arc.system");
export const ToolResultEntry = defineEntry<{ diagnostics: ToolDiagnostic[] }>("arc.tool-result");
export const ResetEntry = defineEntry("arc.reset");
export const CompactionEntry = defineEntry<{ reason: CompactionReason }>("arc.compaction");
