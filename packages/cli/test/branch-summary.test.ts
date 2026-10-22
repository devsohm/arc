import { createModels, fauxProvider, fauxAssistantMessage, fauxToolCall } from "@arc/ai";
import { MemoryStorage } from "@arc/durable";
import type { EntryId, EntryRecord, ConversationId } from "@arc/durable";
import { expect, test, vi } from "vitest";
import { prepareBranch, summarizeBranch } from "../src/core/sessions/branch-summary.ts";
const identifiers = new MemoryStorage();
const owner = await identifiers.mintId<ConversationId>();
const entryIds = await Promise.all(Array.from({ length: 20 }, () => identifiers.mintId<EntryId>()));
const entry = (
	index: number,
	fields: Omit<EntryRecord, "id" | "conversationId" | "kind">,
	kind = "message",
): EntryRecord => ({ id: entryIds[index], conversationId: owner, kind, ...fields });

test("branch budgets omit tool results, retain a boundary summary, and accumulate file paths", () => {
	const records = [
		entry(2, { data: { readFiles: ["prior"], modifiedFiles: ["changed"] } }, "arc.branch-summary"),
		entry(3, {
			model: [
				fauxAssistantMessage([fauxToolCall("read", { path: "changed" }), fauxToolCall("write", { path: "new" })]),
			],
		}),
		entry(4, {
			model: [
				{
					role: "toolResult",
					toolCallId: "id",
					toolName: "read",
					content: [{ type: "text", text: "ignored" }],
					isError: false,
					timestamp: 0,
				},
			],
		}),
		entry(5, { model: [{ role: "user", content: "a".repeat(400), timestamp: 0 }] }, "arc.branch-summary"),
	];
	const prepared = prepareBranch(records, 1);
	expect(prepared.messages).toEqual(records[3].model);
	expect(prepared.readFiles).toEqual(["prior"]);
	expect(prepared.modifiedFiles).toEqual(["changed"]);
	const unlimited = prepareBranch(records, 0);
	expect(unlimited.messages.some((message) => message.role === "toolResult")).toBe(false);
	expect(unlimited.readFiles).toEqual(["prior"]);
	expect(unlimited.modifiedFiles).toEqual(["changed", "new"]);
});

test("summary retries reuse routing, disable caching, omit thinking and append file tracking", async () => {
	const models = createModels(),
		provider = fauxProvider();
	models.setProvider(provider.provider);
	const model = models.getModels("faux")[0];
	const request = vi.spyOn(models, "completeSimple");
	request
		.mockResolvedValueOnce({ ...fauxAssistantMessage(""), stopReason: "error", errorMessage: "stream was interrupted" })
		.mockResolvedValueOnce(fauxAssistantMessage("Saved work"));
	const callbacks = { onRetryScheduled: vi.fn(), onRetryAttemptStart: vi.fn(), onRetryFinished: vi.fn() };
	const record = entry(2, {
		model: [
			fauxAssistantMessage([
				{ type: "thinking", thinking: "private", thinkingSignature: "opaque" },
				fauxToolCall("read", { path: "a.ts" }),
			]),
		],
	});
	const result = await summarizeBranch(models, model, [record], new AbortController().signal, "focus", {
		retry: { enabled: true, maxRetries: 1, baseDelayMs: 0 },
		callbacks,
	});
	expect(result.summary).toBe("Saved work\n\n<read-files>\na.ts\n</read-files>");
	expect(request).toHaveBeenCalledTimes(2);
	expect(request.mock.calls[0][2]).toMatchObject({
		cacheRetention: "none",
		sessionId: request.mock.calls[1][2]?.sessionId,
	});
	expect(JSON.stringify(request.mock.calls[0][1])).not.toContain("private");
	expect(callbacks.onRetryFinished).toHaveBeenCalledWith(true, 1);
});

test("empty branches make no request and tool-calling summaries fail", async () => {
	const models = createModels(),
		provider = fauxProvider();
	models.setProvider(provider.provider);
	const model = models.getModels("faux")[0],
		signal = new AbortController().signal;
	const request = vi
		.spyOn(models, "completeSimple")
		.mockResolvedValue(fauxAssistantMessage(fauxToolCall("read", { path: "x" })));
	expect((await summarizeBranch(models, model, [], signal)).summary).toBe("No content to summarize");
	expect(request).not.toHaveBeenCalled();
	await expect(
		summarizeBranch(models, model, [entry(2, { model: [{ role: "user", content: "text", timestamp: 0 }] })], signal),
	).rejects.toThrow("attempted to call a tool");
});
