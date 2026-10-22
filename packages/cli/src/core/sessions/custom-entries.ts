import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import {
	defineDoc,
	isJsonValue,
	type Conversation,
	type Context,
	type EntryRecord,
	type DocumentReader,
	type JsonValue,
	type Submission,
} from "@arc/durable";
import { randomUUID } from "node:crypto";
import { inputContentSchema } from "../input.ts";

export const MESSAGE_KIND = "application.message";
export const ENTRY_KIND = "application.entry";
const messageSchema = Type.Object(
	{
		customType: Type.String({ minLength: 1 }),
		content: inputContentSchema,
		display: Type.Boolean(),
		details: Type.Optional(Type.Unknown()),
	},
	{ additionalProperties: false },
);
export type CustomMessage = Omit<Static<typeof messageSchema>, "details"> & { readonly details?: JsonValue };
export interface CustomEntry {
	readonly customType: string;
	readonly data?: JsonValue;
}
export function parseCustomMessage(value: unknown): CustomMessage {
	if (!Value.Check(messageSchema, value)) throw new Error("Invalid custom message");
	if (value.details !== undefined && !isJsonValue(value.details))
		throw new Error("Custom message details must be JSON");
	return {
		customType: value.customType,
		content: value.content,
		display: value.display,
		...(value.details === undefined ? {} : { details: value.details }),
	};
}
export function customMessage(entry: EntryRecord): CustomMessage | undefined {
	if (entry.kind !== MESSAGE_KIND) return;
	try {
		return parseCustomMessage(entry.data);
	} catch {
		return;
	}
}
export function customEntry(entry: EntryRecord): CustomEntry | undefined {
	const value = entry.data;
	if (
		entry.kind !== ENTRY_KIND ||
		!value ||
		Array.isArray(value) ||
		typeof value !== "object" ||
		typeof value.customType !== "string"
	)
		return;
	return { customType: value.customType, ...(value.data === undefined ? {} : { data: value.data }) };
}
const pending = defineDoc<{ messages: { id: string; message: CustomMessage }[] }>({
	kind: "application.pending-messages",
	scope: "conversation",
	version: 1,
	history: "latest",
	fork: "initial",
	initial: () => ({ messages: [] }),
	checkpointWhen: (state) => state.messages.length === 0,
});
export async function queueCustomMessage(
	conversation: Conversation,
	message: CustomMessage,
	context: Context,
): Promise<void> {
	await conversation.commit(async (tx) => {
		(await tx.doc(pending, conversation.id)).messages.push({ id: randomUUID(), message });
	}, context);
}
export async function flushCustomMessages(
	conversation: Conversation,
	reader: DocumentReader,
	context: Context,
): Promise<void> {
	const messages = (await reader.snapshot(pending, conversation.id, context))?.messages ?? [];
	for (const { id, message } of messages)
		await conversation.submit(
			{
				type: "write",
				requestId: `custom-message:${id}`,
				entry: {
					kind: MESSAGE_KIND,
					data: message,
					model: [{ role: "user", content: message.content, timestamp: Date.now() }],
				},
			},
			context,
		);
	if (messages.length) {
		const ids = new Set(messages.map((item) => item.id));
		await conversation.commit(async (tx) => {
			const doc = await tx.doc(pending, conversation.id);
			doc.messages = doc.messages.filter((item) => !ids.has(item.id));
		}, context);
	}
}
export async function sendCustomMessage(
	conversation: Conversation,
	message: CustomMessage,
	options: { triggerTurn?: boolean; deliverAs?: "steer" | "followUp" | "nextTurn" } | undefined,
	busy: boolean,
	reader: DocumentReader,
	context: Context,
): Promise<Submission | undefined> {
	if (options?.deliverAs === "nextTurn") {
		await queueCustomMessage(conversation, message, context);
		return;
	}
	if (options?.triggerTurn || (busy && options?.triggerTurn !== false)) {
		await flushCustomMessages(conversation, reader, context);
		return conversation.submit(
			{
				type: "input",
				content: message.content,
				whenBusy: options?.deliverAs === "followUp" ? "followUp" : "steer",
				entry: { kind: MESSAGE_KIND, data: message },
			},
			context,
		);
	}
	return conversation.submit(
		{
			type: "write",
			entry: {
				kind: MESSAGE_KIND,
				data: message,
				model: [{ role: "user", content: message.content, timestamp: Date.now() }],
			},
		},
		context,
	);
}
