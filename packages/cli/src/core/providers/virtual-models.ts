import { MODEL_THINKING_LEVELS } from "@arc/ai/providers/model-schema";
import {
	clampThinkingLevel,
	isModelType,
	lazyStream,
	type Api,
	type AssistantMessage,
	type Message,
	type Model,
	type Models,
	type ModelThinkingLevel,
	type ModelTypeMap,
	type Provider,
} from "@arc/ai";
import { defineDoc, isJsonValue, GenerationTask, hook, type Extension, type JsonValue } from "@arc/durable";
export interface ModelRouteRequest {
	readonly model: Model<Api>;
	readonly thinkingLevel: ModelThinkingLevel;
	readonly messages: readonly Message[];
	readonly reason: "user" | "continuation" | "retry" | "direct";
	readonly signal?: AbortSignal;
	readonly state?: JsonValue;
	readonly previous?: { model: Model<Api>; thinkingLevel?: ModelThinkingLevel };
	readonly failed?: { model: Model<Api>; thinkingLevel?: ModelThinkingLevel; message: AssistantMessage };
}
export interface VirtualModelDefinition {
	readonly provider: string;
	readonly id: string;
	readonly name: string;
	readonly thinkingLevels?: readonly ModelThinkingLevel[];
	readonly contextWindow?: number;
	readonly maxTokens?: number;
	readonly input?: ("text" | "image")[];
	route(
		request: ModelRouteRequest,
		context: { readonly models: Models; readonly cwd: string },
	):
		| { model: Model<Api>; thinkingLevel: ModelThinkingLevel; state?: JsonValue }
		| Promise<{ model: Model<Api>; thinkingLevel: ModelThinkingLevel; state?: JsonValue }>;
}
const RouterState = defineDoc<{ routes: Record<string, JsonValue> }>({
	kind: "application.router-state",
	scope: "conversation",
	version: 1,
	history: "rewindable",
	fork: "asOf",
	initial: () => ({ routes: {} }),
	checkpointWhen: () => true,
});
const key = (provider: string, id: string) => JSON.stringify([provider, id]);
type Registration = { owner: object; definition: VirtualModelDefinition; model: Model<Api> };
export class VirtualModels {
	readonly #base: Models;
	readonly #cwd: string;
	readonly #layers = new Map<string, Registration[]>();
	readonly models: Models;
	constructor(base: Models, cwd: string) {
		this.#base = base;
		this.#cwd = cwd;
		const all: Models["getAllModels"] = (provider) => {
			const overlays = [...this.#layers.values()]
				.flatMap((layers) => layers.slice(-1).map((layer) => layer.model))
				.filter((model) => provider === undefined || model.provider === provider);
			const keys = new Set(overlays.map((model) => key(model.provider, model.id)));
			return [...base.getAllModels(provider).filter((model) => !keys.has(key(model.provider, model.id))), ...overlays];
		};
		const getModelsOfType: Models["getModelsOfType"] = (type, provider) =>
			all(provider).filter((model): model is ModelTypeMap[typeof type] => isModelType(model, type));
		const getModelOfType: Models["getModelOfType"] = (type, provider, id) =>
			getModelsOfType(type, provider).find((model) => model.id === id);
		const checkAuth: Models["checkAuth"] = (provider, options) =>
			!base.getProvider(provider) &&
			[...this.#layers.values()].some((layers) => layers.at(-1)?.model.provider === provider)
				? Promise.resolve({ type: "api_key", source: "virtual" })
				: base.checkAuth(provider, options);
		const available: Models["getAllAvailable"] = async (provider, options) => {
			const entries = all(provider);
			const auth = new Map<string, ReturnType<Models["checkAuth"]>>();
			for (const model of entries)
				if (!auth.has(model.provider)) auth.set(model.provider, checkAuth(model.provider, options));
			const results = await Promise.all(
				entries.map(async (model) => ((await auth.get(model.provider)) ? model : undefined)),
			);
			return results.filter((model) => model !== undefined);
		};
		const getAvailableOfType: Models["getAvailableOfType"] = async (type, provider, options) =>
			(await available(provider, options)).filter((model): model is ModelTypeMap[typeof type] =>
				isModelType(model, type),
			);
		const streamSimple: Models["streamSimple"] = (model, context, options) => {
			if (!this.has(model.provider, model.id)) return base.streamSimple(model, context, options);
			return lazyStream(model, async () => {
				const route = await this.resolve(
					model,
					context.messages,
					options?.reasoning ?? "off",
					"direct",
					options?.signal,
				);
				const { apiKey, headers, env, ...rest } = options ?? {};
				return base.streamSimple(route.model, context, {
					...rest,
					...(route.model.provider === model.provider ? { apiKey, headers, env } : {}),
					reasoning: route.thinkingLevel === "off" ? undefined : route.thinkingLevel,
					maxTokens:
						options?.maxTokens && route.model.maxTokens > 0
							? Math.min(options.maxTokens, route.model.maxTokens)
							: options?.maxTokens,
				});
			});
		};
		const getProvider = (id: string): Provider | undefined =>
			base.getProvider(id) ??
			(this.#layers.size && all(id).length
				? {
						id,
						name: id,
						auth: {},
						getModels: () => getModelsOfType("chat", id),
						stream: (model) =>
							lazyStream(model, async () => {
								throw new Error("Virtual models require streamSimple");
							}),
						streamSimple,
					}
				: undefined);
		this.models = new Proxy(base, {
			get(target, property) {
				if (property === "getAllModels") return all;
				if (property === "getModels") return (provider?: string) => getModelsOfType("chat", provider);
				if (property === "getModelsOfType") return getModelsOfType;
				if (property === "getModelOfType") return getModelOfType;
				if (property === "getModel") return (provider: string, id: string) => getModelOfType("chat", provider, id);
				if (property === "getAllAvailable") return available;
				if (property === "getAvailable")
					return (provider?: string, options?: Parameters<Models["getAvailable"]>[1]) =>
						getAvailableOfType("chat", provider, options);
				if (property === "getAvailableOfType") return getAvailableOfType;
				if (property === "checkAuth") return checkAuth;
				if (property === "getProvider") return getProvider;
				if (property === "getProviders")
					return () =>
						[
							...new Set(
								all()
									.map((model) => model.provider)
									.concat(base.getProviders().map((provider) => provider.id)),
							),
						].flatMap((id) => {
							const provider = getProvider(id);
							return provider ? [provider] : [];
						});
				if (property === "streamSimple") return streamSimple;
				if (property === "completeSimple")
					return (
						model: Model<Api>,
						context: Parameters<Models["streamSimple"]>[1],
						options?: Parameters<Models["streamSimple"]>[2],
					) => streamSimple(model, context, options).result();
				const value = Reflect.get(target, property, target);
				return typeof value === "function" ? value.bind(target) : value;
			},
		});
	}
	has(provider: string, id: string): boolean {
		return this.#layers.has(key(provider, id));
	}
	validate(definition: VirtualModelDefinition): void {
		if (
			!definition ||
			!definition.provider?.trim() ||
			!definition.id?.trim() ||
			!definition.name?.trim() ||
			typeof definition.route !== "function"
		)
			throw new Error("Invalid virtual model definition");
		if (this.#base.getModel(definition.provider, definition.id) && !this.has(definition.provider, definition.id))
			throw new Error("Virtual model conflicts with a physical model");
		const levels = definition.thinkingLevels ?? ["off"];
		if (!levels.length || levels.some((level) => !MODEL_THINKING_LEVELS.includes(level)))
			throw new Error("Invalid virtual thinking levels");
		for (const limit of [definition.contextWindow, definition.maxTokens])
			if (limit !== undefined && (!Number.isFinite(limit) || limit < 0)) throw new Error("Invalid virtual model limit");
		if (definition.input?.some((type) => type !== "text" && type !== "image"))
			throw new Error("Invalid virtual input modality");
	}
	set(owner: object, definition: VirtualModelDefinition): void {
		if (
			this.#layers
				.get(key(definition.provider, definition.id))
				?.some((layer) => layer.owner === owner && layer.definition === definition)
		)
			return;
		this.validate(definition);
		const levels = definition.thinkingLevels ?? ["off"];
		const thinkingLevelMap: NonNullable<Model<Api>["thinkingLevelMap"]> = {};
		for (const level of MODEL_THINKING_LEVELS) thinkingLevelMap[level] = levels.includes(level) ? level : null;
		const model: Model<Api> = {
			provider: definition.provider,
			id: definition.id,
			name: definition.name,
			api: "arc-virtual",
			baseUrl: "",
			reasoning: levels.some((level) => level !== "off"),
			thinkingLevelMap,
			input: definition.input ?? ["text", "image"],
			contextWindow: definition.contextWindow ?? 0,
			maxTokens: definition.maxTokens ?? 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		};
		const id = key(definition.provider, definition.id),
			layers = (this.#layers.get(id) ?? []).filter((value) => value.owner !== owner);
		layers.push({ owner, definition, model });
		this.#layers.set(id, layers);
	}
	retain(owners: ReadonlySet<object>): void {
		for (const layers of [...this.#layers.values()])
			for (const layer of layers) if (!owners.has(layer.owner)) this.remove(layer.owner);
	}
	remove(owner: object, provider?: string, id?: string): void {
		for (const [name, layers] of this.#layers) {
			if (provider !== undefined && name !== key(provider, id ?? "")) continue;
			const keep = layers.filter((layer) => layer.owner !== owner);
			if (keep.length) this.#layers.set(name, keep);
			else this.#layers.delete(name);
		}
	}
	async resolve(
		model: Model<Api>,
		messages: readonly Message[],
		thinkingLevel: ModelThinkingLevel,
		reason: ModelRouteRequest["reason"],
		signal?: AbortSignal,
		state?: JsonValue,
		failedResponse?: AssistantMessage,
	) {
		const registration = this.#layers.get(key(model.provider, model.id))?.at(-1);
		if (!registration) throw new Error("Virtual model is not registered");
		let previous: ModelRouteRequest["previous"], failed: ModelRouteRequest["failed"];
		for (let i = messages.length - 1; i >= 0; i--) {
			const message = messages[i];
			if (message?.role !== "assistant") continue;
			const physical = this.#base.getModel(message.provider, message.model);
			if (!physical) continue;
			if (message.stopReason === "error" || message.stopReason === "aborted") {
				if (!failed && reason === "retry") failed = { model: physical, thinkingLevel: message.thinkingLevel, message };
			} else {
				previous = { model: physical, thinkingLevel: message.thinkingLevel };
				break;
			}
		}
		if (failedResponse && reason === "retry") {
			const physical = this.#base.getModel(failedResponse.provider, failedResponse.model);
			if (physical) failed = { model: physical, thinkingLevel: failedResponse.thinkingLevel, message: failedResponse };
		}
		signal?.throwIfAborted();
		const result = await registration.definition.route(
			{ model, messages, thinkingLevel, reason, signal, state, previous, failed },
			{ models: this.models, cwd: this.#cwd },
		);
		signal?.throwIfAborted();
		if (!result?.model || this.has(result.model.provider, result.model.id))
			throw new Error("A virtual model must route to a physical catalog model");
		const target = this.#base.getModel(result.model.provider, result.model.id);
		if (!target || !(await this.#base.checkAuth(target.provider)))
			throw new Error("Routed model is unavailable or has no credentials");
		if (!MODEL_THINKING_LEVELS.includes(result.thinkingLevel)) throw new Error("Invalid routed thinking level");
		if (reason !== "direct" && result.state !== undefined && !isJsonValue(result.state))
			throw new Error("Router state must be JSON");
		return { model: target, thinkingLevel: clampThinkingLevel(target, result.thinkingLevel), state: result.state };
	}
	extension(): Extension {
		return {
			name: "application.model-routing",
			hooks: [
				hook(GenerationTask, {
					beforeModel: async (request, api, context) => {
						if (!this.has(request.model.provider, request.model.modelId)) return;
						const model = this.models.getModel(request.model.provider, request.model.modelId);
						if (!model) throw new Error("Selected virtual model is unavailable");
						const state = (await api.snapshot(RouterState, api.conversationId, context))?.routes[
							key(model.provider, model.id)
						];
						const result = await this.resolve(
							model,
							request.messages,
							request.thinkingLevel,
							request.reason,
							context.abortSignal,
							state,
							request.failed,
						);
						return {
							...(result.state === undefined || result.state === state
								? {}
								: {
										commit: async (tx: import("@arc/durable").Tx) => {
											(await tx.doc(RouterState, api.conversationId)).routes[key(model.provider, model.id)] =
												structuredClone(result.state ?? null);
										},
									}),
							model: { provider: result.model.provider, modelId: result.model.id },
							thinkingLevel: result.thinkingLevel,
						};
					},
				}),
			],
		};
	}
}
