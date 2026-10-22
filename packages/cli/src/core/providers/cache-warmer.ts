import { getProviderEnvValue } from "@arc/ai/utils/provider-env";
import {
	calculateCost,
	type Api,
	type Model,
	type Context,
	type Models,
	type ModelsSimpleStreamOptions,
	type Usage,
} from "@arc/ai";

export type CacheWarmingMode = "off" | "streaming" | "idle";
export interface CacheWarmingDecision {
	readonly phase: "streaming" | "idle";
	readonly warmCost: number;
	readonly missCost: number;
	readonly continuationProbability: number;
	readonly expectedSavings: number;
	readonly economicsAvailable: boolean;
	readonly action: "warm" | "stop";
}
export interface CacheWarmingStatus {
	readonly state: "inactive" | "scheduled" | "refreshing";
	readonly reason?: string;
	readonly nextWarmAt?: number;
	readonly decision?: CacheWarmingDecision;
	readonly extensionOverride?: boolean;
}
export interface CacheWarmRequest {
	readonly model: Model<Api>;
	readonly context: Context;
	readonly options: ModelsSimpleStreamOptions;
}
interface Active extends CacheWarmRequest {
	readonly current: () => boolean;
	readonly started: number;
	readonly ttl: number;
	readonly delay: number;
	readonly abort: AbortController;
	phase: "streaming" | "idle";
	at: number;
	deadline: number;
	timer?: ReturnType<typeof setTimeout>;
}
export function warmingDelay(ttl: number): number | undefined {
	return ttl > 10_000 ? Math.floor(Math.min(ttl * 0.9, ttl - 10_000)) : undefined;
}
export function warmingDecision(model: Model<Api>, tokens: number, phase: Active["phase"]): CacheWarmingDecision {
	const price = (counts: Partial<Usage>) =>
		calculateCost(model, {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			...counts,
		}).total;
	const hit = price({ cacheRead: tokens });
	const miss = price(model.cost.cacheWrite > 0 ? { cacheWrite: tokens } : { input: tokens });
	const warmCost = price({ cacheRead: tokens, output: 1 });
	const missCost = Math.max(0, miss - hit);
	const continuationProbability = phase === "streaming" ? 1 : 0.15;
	const expectedSavings = continuationProbability * missCost - warmCost;
	return {
		phase,
		warmCost,
		missCost,
		continuationProbability,
		expectedSavings,
		economicsAvailable: tokens > 0 && (hit > 0 || miss > 0),
		action: expectedSavings >= 0.05 ? "warm" : "stop",
	};
}
type CacheHost = {
	models: Pick<Models, "streamSimple">;
	mode(): CacheWarmingMode;
	tokens(): number;
	decide(decision: CacheWarmingDecision): Promise<"warm" | "stop">;
	record(request: CacheWarmRequest, usage: Usage, override: boolean): Promise<void>;
	report(error: unknown): void;
};
export class CacheWarmer {
	readonly #host: CacheHost;
	#run?: Active;
	#status: CacheWarmingStatus = { state: "inactive", reason: "waiting for first request" };
	constructor(host: CacheHost) {
		this.#host = host;
	}
	get status(): CacheWarmingStatus {
		if (this.#host.mode() === "off") return { state: "inactive", reason: "cache warming disabled" };
		return this.#status;
	}
	start(request: CacheWarmRequest, current: () => boolean): void {
		this.cancel();
		if (this.#host.mode() === "off") return this.cancel("cache warming disabled");
		if (
			request.options.reasoning &&
			request.model.api === "anthropic-messages" &&
			!(
				request.model.compat &&
				"forceAdaptiveThinking" in request.model.compat &&
				request.model.compat.forceAdaptiveThinking === true
			)
		)
			return this.cancel("request cannot be replayed safely");
		const retention =
			request.options.cacheRetention ??
			(getProviderEnvValue("ARC_CACHE_RETENTION", request.options.env) === "long" ? "long" : "short");
		const ttl = retention === "none" ? undefined : request.model.promptCache?.[retention];
		const delay = ttl === undefined ? undefined : warmingDelay(ttl * 1000);
		if (ttl === undefined || delay === undefined) return this.cancel("cache lifetime unavailable");
		const run: Active = {
			...request,
			context: structuredClone(request.context),
			options: { ...request.options },
			current,
			started: Date.now(),
			ttl: ttl * 1000,
			delay,
			abort: new AbortController(),
			phase: "streaming",
			at: 0,
			deadline: 0,
		};
		this.#run = run;
		this.#schedule(run);
	}
	settled(): void {
		if (!this.#run) return;
		if (this.#host.mode() === "streaming") return this.cancel("agent run settled");
		this.#run.phase = "idle";
		this.#valid(this.#run);
	}
	modeChanged(): void {
		if (this.#run) this.#valid(this.#run);
	}
	cancel(reason = "inactive"): void {
		const run = this.#run;
		this.#run = undefined;
		if (run?.timer) clearTimeout(run.timer);
		run?.abort.abort();
		this.#status = { state: "inactive", reason };
	}
	#valid(run: Active): boolean {
		if (this.#run !== run) return false;
		const mode = this.#host.mode();
		const limit = run.phase === "idle" ? 30 * 60_000 : 60 * 60_000;
		const reason =
			mode === "off"
				? "cache warming disabled"
				: mode === "streaming" && run.phase === "idle"
					? "agent run settled"
					: !run.current()
						? "conversation context changed"
						: Date.now() >= run.started + limit || run.at > run.started + limit
							? "cache warming age limit reached"
							: undefined;
		if (reason) {
			this.cancel(reason);
			return false;
		}
		return true;
	}
	#schedule(run: Active): void {
		run.at = Date.now() + run.delay;
		run.deadline = run.at + Math.floor((run.ttl - run.delay) / 2);
		if (!this.#valid(run)) return;
		this.#status = {
			state: "scheduled",
			nextWarmAt: run.at,
			decision: warmingDecision(run.model, this.#host.tokens(), run.phase),
		};
		run.timer = setTimeout(() => {
			void this.#refresh(run);
		}, run.delay);
		run.timer.unref?.();
	}
	async #refresh(run: Active): Promise<void> {
		run.timer = undefined;
		if (!this.#valid(run)) return;
		if (Date.now() > run.deadline) return this.cancel("cache refresh deadline missed");
		const decision = warmingDecision(run.model, this.#host.tokens(), run.phase);
		let action = decision.action;
		try {
			action = await this.#host.decide(decision);
		} catch (error) {
			this.#host.report(error);
		}
		if (!this.#valid(run)) return;
		if (Date.now() > run.deadline) return this.cancel("cache refresh deadline missed");
		const override = action !== decision.action;
		if (action === "stop") {
			this.cancel(
				override
					? "stopped by extension"
					: decision.economicsAvailable
						? "expected savings below threshold"
						: "cache economics unavailable",
			);
			this.#status = { ...this.#status, decision, extensionOverride: override };
			return;
		}
		this.#status = { state: "refreshing", decision, extensionOverride: override };
		try {
			const result = await this.#host.models
				.streamSimple(run.model, run.context, { ...run.options, maxTokens: 1, maxRetries: 0, signal: run.abort.signal })
				.result();
			if (!this.#valid(run)) return;
			if (result.stopReason !== "error" && result.stopReason !== "aborted")
				await this.#host.record(run, result.usage, override);
		} catch (error) {
			if (this.#run === run && !run.abort.signal.aborted) this.#host.report(error);
		}
		if (this.#run === run) this.#schedule(run);
	}
}
