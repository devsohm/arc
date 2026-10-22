import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import type { EntryRecord } from "@arc/durable";

export const BASH_ENTRY = "application.bash";
const resultSchema = Type.Object({
	output: Type.String(),
	exitCode: Type.Optional(Type.Number()),
	cancelled: Type.Boolean(),
	truncated: Type.Boolean(),
	fullOutputPath: Type.Optional(Type.String()),
});
const entrySchema = Type.Object({
	id: Type.String(),
	command: Type.String(),
	timestamp: Type.Number(),
	excludeFromContext: Type.Boolean(),
	result: resultSchema,
});
export type UserBashResult = Static<typeof resultSchema>;
export type UserBashEntry = Static<typeof entrySchema>;
export type UserBashProgress = Omit<UserBashEntry, "result"> & { readonly output: string };

export function parseBashResult(value: unknown): UserBashResult {
	if (!Value.Check(resultSchema, value)) throw new Error("Invalid user shell result");
	return structuredClone(value);
}
export function userBashEntry(entry: EntryRecord): UserBashEntry | undefined {
	if (entry.kind === BASH_ENTRY && Value.Check(entrySchema, entry.data)) return entry.data;
}
export function bashContext(command: string, result: UserBashResult): string {
	return [
		`Shell command: ${command}`,
		result.output || "No output.",
		result.cancelled ? "Command cancelled." : result.exitCode ? `Exit code: ${result.exitCode}` : "",
		result.truncated
			? `Output truncated.${result.fullOutputPath ? ` Complete output: ${result.fullOutputPath}` : ""}`
			: "",
	]
		.filter(Boolean)
		.join("\n");
}
