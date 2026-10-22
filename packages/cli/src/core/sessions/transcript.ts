import { Type, type Message } from "@arc/ai";
import { Value } from "typebox/value";
import { copyJson, type EntryRecord } from "@arc/durable";
const text = Type.Object({
	type: Type.Literal("text"),
	text: Type.String(),
	textSignature: Type.Optional(Type.String()),
});
const image = Type.Object({ type: Type.Literal("image"), data: Type.String(), mimeType: Type.String() });
const object = Type.Record(Type.String(), Type.Unknown());
const cost = Type.Object({
	input: Type.Number(),
	output: Type.Number(),
	cacheRead: Type.Number(),
	cacheWrite: Type.Number(),
	total: Type.Number(),
});
const usage = Type.Object({
	input: Type.Number(),
	output: Type.Number(),
	cacheRead: Type.Number(),
	cacheWrite: Type.Number(),
	totalTokens: Type.Number(),
	cost,
});
const declaration = Type.Object({
	name: Type.String(),
	description: Type.String(),
	parameters: object,
	constrainedSampling: Type.Optional(Type.Union([Type.Literal(false), object])),
});
const messages = Type.Array(
	Type.Unsafe<Message>(
		Type.Union([
			Type.Object({
				role: Type.Literal("user"),
				content: Type.Union([Type.String(), Type.Array(Type.Union([text, image]))]),
				timestamp: Type.Number(),
			}),
			Type.Object({
				role: Type.Literal("system"),
				content: Type.Union([Type.String(), Type.Array(text)]),
				timestamp: Type.Number(),
				sections: Type.Optional(Type.Record(Type.String(), Type.Union([Type.String(), Type.Null()]))),
				toolsAdded: Type.Optional(Type.Array(declaration)),
				toolsRemoved: Type.Optional(Type.Array(Type.Object({ name: Type.String() }))),
			}),
			Type.Object({
				role: Type.Literal("assistant"),
				content: Type.Array(
					Type.Union([
						text,
						Type.Object({
							type: Type.Literal("thinking"),
							thinking: Type.String(),
							thinkingSignature: Type.Optional(Type.String()),
							redacted: Type.Optional(Type.Boolean()),
						}),
						Type.Object({
							type: Type.Literal("toolCall"),
							id: Type.String(),
							name: Type.String(),
							arguments: object,
							thoughtSignature: Type.Optional(Type.String()),
							namespace: Type.Optional(Type.String()),
							argumentsError: Type.Optional(Type.String()),
						}),
					]),
				),
				api: Type.String(),
				provider: Type.String(),
				model: Type.String(),
				usage,
				stopReason: Type.Union(
					["pending", "stop", "length", "toolUse", "error", "aborted", "deferred"].map((reason) =>
						Type.Literal(reason),
					),
				),
				timestamp: Type.Number(),
			}),
			Type.Object({
				role: Type.Literal("toolResult"),
				toolCallId: Type.String(),
				toolName: Type.String(),
				content: Type.Array(Type.Union([text, image])),
				isError: Type.Boolean(),
				timestamp: Type.Number(),
			}),
		]),
	),
);
const schema = Type.Object(
	{ format: Type.Literal("arc-transcript"), version: Type.Literal(1), messages },
	{ additionalProperties: false },
);
export function exportTranscript(entries: readonly EntryRecord[]): string {
	return (
		JSON.stringify(
			{ format: "arc-transcript", version: 1, messages: entries.flatMap((entry) => entry.model ?? []) },
			null,
			2,
		) + "\n"
	);
}
export function importTranscript(source: string): readonly Message[] {
	let data: unknown;
	try {
		data = JSON.parse(source);
	} catch {
		throw new Error("Transcript is not valid JSON");
	}
	if (!Value.Check(schema, data)) throw new Error("Unsupported or malformed Arc transcript");
	copyJson(data);
	return data.messages;
}
