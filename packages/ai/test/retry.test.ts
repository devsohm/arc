import { getEventListeners } from "node:events";
import { expect, it } from "vitest";
import { fauxAssistantMessage } from "../src/providers/faux.ts";
import { retryAssistantCall } from "../src/utils/retry.ts";

it("keeps a completed backoff cancellation listener until the operation aborts", async () => {
	const controller = new AbortController();
	const response = fauxAssistantMessage([]);
	let calls = 0;
	try {
		const result = await retryAssistantCall(
			async () =>
				++calls === 1 ? fauxAssistantMessage([], { stopReason: "error", errorMessage: "server_busy" }) : response,
			{ enabled: true, maxRetries: 1, baseDelayMs: 0 },
			controller.signal,
		);
		expect(result).toBe(response);
		expect(calls).toBe(2);
		expect(getEventListeners(controller.signal, "abort")).toHaveLength(1);
	} finally {
		controller.abort();
	}
	expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
});

it("does not retry an administrative workspace usage limit even when a rate-limit status is present", async () => {
	let calls = 0;
	const limited = fauxAssistantMessage([], {
		stopReason: "error",
		errorMessage: "429 subscription_sharing_workplace_individual_usage_limit_exceeded",
	});
	expect(
		await retryAssistantCall(
			async () => {
				calls++;
				return limited;
			},
			{ enabled: true, maxRetries: 3, baseDelayMs: 0 },
			undefined,
		),
	).toBe(limited);
	expect(calls).toBe(1);
});
