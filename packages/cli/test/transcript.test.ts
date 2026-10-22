import { fauxAssistantMessage, fauxText, fauxThinking, fauxToolCall, type Message, Type } from "@arc/ai";
import { getCurrentTools, toToolDeclaration } from "@arc/ai/utils/transcript";
import { createSession, MemoryStorage } from "@arc/durable";
import { BACKGROUND_CONTEXT as context } from "@arc/durable/context";
import { expect, test } from "vitest";
import { exportTranscript, importTranscript } from "../src/core/sessions/transcript.ts";

test("a transcript exports committed model messages while excluding local entry data", async () => {
	const session = createSession(new MemoryStorage());
	const input: Message[] = [
		{
			role: "system",
			content: "",
			sections: { guide: "Use the local instructions." },
			toolsAdded: [
				toToolDeclaration({
					name: "read",
					description: "Read the requested file",
					parameters: Type.Object({ path: Type.String() }),
				}),
			],
			timestamp: 1,
		},
		{
			role: "user",
			content: [
				{ type: "text", text: "Inspect the image", textSignature: "user-signature" },
				{ type: "image", data: "aW1hZ2U=", mimeType: "image/png" },
			],
			timestamp: 2,
		},
		fauxAssistantMessage(
			[
				fauxThinking("Read the file first"),
				fauxToolCall("read", { path: "sample.txt", nested: { enabled: true, values: [1, null] } }, { id: "read-call" }),
			],
			{ timestamp: 3, stopReason: "toolUse" },
		),
		{
			role: "toolResult",
			toolCallId: "read-call",
			toolName: "read",
			content: [{ type: "text", text: "Sample contents" }],
			isError: false,
			details: { lineCount: 1 },
			timestamp: 4,
		},
		{ role: "system", content: "", sections: { guide: null }, toolsRemoved: [{ name: "read" }], timestamp: 5 },
		fauxAssistantMessage([fauxText("The image and text are recorded.")], { timestamp: 6 }),
	];
	try {
		const conversation = await session.commit(
			(tx) => tx.createConversation({ ownership: { kind: "ownerless" } }),
			context,
		);
		const entries = await session.commit(async (tx) => {
			const local = await tx.appendEntry(conversation.id, {
				kind: "fixture.private",
				data: { privateNote: "Never export local data" },
			});
			const first = await tx.appendEntry(conversation.id, { kind: "fixture.messages", model: input.slice(0, 3) });
			const second = await tx.appendEntry(conversation.id, { kind: "fixture.messages", model: input.slice(3) });
			return [local, first, second];
		}, context);
		const source = exportTranscript(entries);
		const decoded = importTranscript(source);
		expect(JSON.parse(source)).toMatchObject({ format: "arc-transcript", version: 1 });
		expect(decoded).toEqual(input);
		expect(decoded.map((message) => message.role)).toEqual([
			"system",
			"user",
			"assistant",
			"toolResult",
			"system",
			"assistant",
		]);
		expect(getCurrentTools(decoded)).toEqual([]);
		expect(source).not.toContain("Never export local data");
		expect(source).not.toContain("fixture.private");
	} finally {
		await session.close(context);
	}
});

test("literal transcript input preserves content, timestamps, and tool declarations", () => {
	const source =
		'{"format":"arc-transcript","version":1,"messages":[{"role":"system","content":"Project","timestamp":2,"toolsAdded":[{"name":"echo","description":"Echo","parameters":{"type":"object","properties":{}}}]},{"role":"user","content":"Hello","timestamp":3}]}';
	const result = importTranscript(source);
	expect(
		result.map((message) => ({ role: message.role, content: message.content, timestamp: message.timestamp })),
	).toEqual([
		{ role: "system", content: "Project", timestamp: 2 },
		{ role: "user", content: "Hello", timestamp: 3 },
	]);
	expect(getCurrentTools(result).map((tool) => tool.name)).toEqual(["echo"]);
});

test.each([
	"{",
	"null",
	"[]",
	'{"format":"foreign","version":1,"messages":[]}',
	'{"format":"arc-transcript","version":2,"messages":[]}',
	'{"format":"arc-transcript","version":1,"messages":[],"unknown":true}',
	'{"format":"arc-transcript","version":1,"messages":[{"role":"user","content":"Missing timestamp"}]}',
	'{"format":"arc-transcript","version":1,"messages":[{"role":"unexpected","content":"Hello","timestamp":1}]}',
	'{"format":"arc-transcript","version":1,"messages":[{"role":"assistant","content":[],"timestamp":1}]}',
	'{"format":"arc-transcript","version":1,"messages":[{"role":"toolResult","toolCallId":"call","toolName":"echo","content":[],"isError":"false","timestamp":1}]}',
	'{"format":"arc-transcript","version":1,"messages":[{"role":"user","content":[{"type":"image","data":"encoded"}],"timestamp":1}]}',
	'{"format":"arc-transcript","version":1,"messages":[{"role":"user","content":"Hello","timestamp":1e999}]}',
])("malformed or unsupported transcripts are rejected at import", (source) => {
	expect(() => importTranscript(source)).toThrow();
});

test.each([
	{ toolsAdded: [null] },
	{ toolsAdded: [{ name: "missing-schema", description: "Incomplete declaration" }] },
	{ toolsRemoved: [null] },
	{ toolsRemoved: [{ name: 5 }] },
])("invalid system tool changes are rejected before they can reach a model request", (change) => {
	const source = JSON.stringify({
		format: "arc-transcript",
		version: 1,
		messages: [{ role: "system", content: "", timestamp: 1, ...change }],
	});
	expect(() => importTranscript(source)).toThrow("malformed");
});
