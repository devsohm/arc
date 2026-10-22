import { afterEach, expect, test, vi } from "vitest";
import { createModels, fauxProvider, fauxAssistantMessage, type Model, type Api } from "@arc/ai";
import {
	CacheWarmer,
	warmingDelay,
	warmingDecision,
	type CacheWarmingMode,
} from "../src/core/providers/cache-warmer.ts";
afterEach(() => vi.useRealTimers());
function fixture() {
	vi.useFakeTimers();
	const models = createModels();
	const provider = fauxProvider();
	models.setProvider(provider.provider);
	const base = models.getModels()[0];
	if (!base) throw new Error("Missing fixture model");
	const model: Model<Api> = {
		...base,
		promptCache: { short: 20 },
		cost: { input: 20, output: 10, cacheRead: 1, cacheWrite: 25 },
	};
	let mode: CacheWarmingMode = "idle",
		current = true;
	const record = vi.fn(async () => {}),
		report = vi.fn(),
		decide = vi.fn(async (d: { action: "warm" | "stop" }) => d.action);
	const warmer = new CacheWarmer({ models, mode: () => mode, tokens: () => 100_000, decide, record, report });
	const request = {
		model,
		context: { messages: [{ role: "user" as const, content: "original", timestamp: 1 }] },
		options: { sessionId: "stable" },
	};
	return {
		models,
		provider,
		model,
		request,
		warmer,
		record,
		report,
		decide,
		setMode(value: CacheWarmingMode) {
			mode = value;
			warmer.modeChanged();
		},
		start() {
			warmer.start(request, () => current);
		},
		invalidate() {
			current = false;
		},
	};
}
test("warming delay preserves a ten second margin and economics use cache read plus one output token", () => {
	expect(warmingDelay(10_000)).toBeUndefined();
	expect(warmingDelay(20_000)).toBe(10_000);
	expect(warmingDelay(300_000)).toBe(270_000);
	const f = fixture();
	const decision = warmingDecision(f.model, 100_000, "idle");
	expect(decision.warmCost).toBeCloseTo(0.10001);
	expect(decision.missCost).toBeCloseTo(2.4);
	expect(decision.expectedSavings).toBeCloseTo(0.25999);
	expect(decision.action).toBe("warm");
	f.warmer.cancel();
});
test("replays an owned request with one output token and records usage without changing the request", async () => {
	const f = fixture();
	const calls: unknown[] = [];
	f.provider.setResponses([
		(context, options) => {
			calls.push({
				text: context.messages[0],
				maxTokens: options?.maxTokens,
				maxRetries: options?.maxRetries,
				sessionId: options?.sessionId,
			});
			return fauxAssistantMessage("x");
		},
	]);
	f.start();
	f.request.context.messages[0].content = "changed";
	f.warmer.settled();
	await vi.advanceTimersByTimeAsync(10_000);
	expect(calls).toEqual([
		{ text: { role: "user", content: "original", timestamp: 1 }, maxTokens: 1, maxRetries: 0, sessionId: "stable" },
	]);
	expect(f.record).toHaveBeenCalledTimes(1);
	expect(f.warmer.status.state).toBe("scheduled");
	expect(f.report).not.toHaveBeenCalled();
	f.warmer.cancel();
	expect(vi.getTimerCount()).toBe(0);
});
test("settling cancels streaming-only warming and switching off cancels an idle timer", async () => {
	const f = fixture();
	f.setMode("streaming");
	f.start();
	f.warmer.settled();
	expect(f.warmer.status.reason).toBe("agent run settled");
	f.setMode("idle");
	f.start();
	f.setMode("off");
	await vi.advanceTimersByTimeAsync(30_000);
	expect(f.record).not.toHaveBeenCalled();
	expect(vi.getTimerCount()).toBe(0);
});
test("changed context cancels replay before a provider call", async () => {
	const f = fixture();
	f.start();
	f.invalidate();
	await vi.advanceTimersByTimeAsync(10_000);
	expect(f.record).not.toHaveBeenCalled();
	expect(f.warmer.status.reason).toBe("conversation context changed");
});
test("a delayed extension decision cannot dispatch past the expiry margin", async () => {
	const f = fixture();
	let release: (action: "warm") => void = () => {};
	f.decide.mockImplementation(
		() =>
			new Promise((resolve) => {
				release = resolve;
			}),
	);
	f.start();
	await vi.advanceTimersByTimeAsync(10_000);
	vi.setSystemTime(Date.now() + 6000);
	release("warm");
	await vi.advanceTimersByTimeAsync(0);
	expect(f.record).not.toHaveBeenCalled();
	expect(f.warmer.status.reason).toBe("cache refresh deadline missed");
});
test("an extension may override unavailable economics and errors fall back to the default decision", async () => {
	const f = fixture();
	f.model.cost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
	f.decide.mockResolvedValue("warm");
	f.provider.setResponses([fauxAssistantMessage("x")]);
	f.start();
	await vi.advanceTimersByTimeAsync(10_000);
	expect(f.record).toHaveBeenCalledWith(expect.anything(), expect.anything(), true);
	f.warmer.cancel();
	f.decide.mockRejectedValue(new Error("decision failed"));
	f.start();
	await vi.advanceTimersByTimeAsync(10_000);
	expect(f.report).toHaveBeenCalledTimes(1);
	expect(f.warmer.status.reason).toBe("cache economics unavailable");
});
test("nonadaptive Anthropic thinking and disabled caching do not arm timers", () => {
	const f = fixture();
	f.warmer.start(
		{ ...f.request, model: { ...f.model, api: "anthropic-messages" }, options: { reasoning: "high" } },
		() => true,
	);
	expect(f.warmer.status.reason).toBe("request cannot be replayed safely");
	f.warmer.start({ ...f.request, options: { cacheRetention: "none" } }, () => true);
	expect(vi.getTimerCount()).toBe(0);
});
test("idle warming never extends its original thirty minute horizon", async () => {
	const f = fixture();
	f.provider.setResponses(Array.from({ length: 180 }, () => fauxAssistantMessage("x")));
	f.start();
	f.warmer.settled();
	await vi.advanceTimersByTimeAsync(1_800_000);
	expect(f.warmer.status.reason).toBe("cache warming age limit reached");
	expect(vi.getTimerCount()).toBe(0);
});
