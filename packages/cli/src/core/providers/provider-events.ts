import type { AnyModel, Models, ModelsRequestTransforms, ProviderRequestOptions } from "@arc/ai";
import type { ApplicationMode } from "../types.ts";

export interface ProviderContext {
	readonly cwd: string;
	readonly mode: ApplicationMode;
	readonly model: AnyModel;
	readonly signal: AbortSignal;
	abort(reason?: unknown): void;
}
export interface ProviderCallbacks {
	beforeProviderRequest?(context: ProviderContext, event: { readonly payload: unknown }): unknown | Promise<unknown>;
	beforeProviderHeaders?(
		context: ProviderContext,
		event: { readonly headers: import("@arc/ai").ProviderHeaders },
	): void | Promise<void>;
	afterProviderResponse?(context: ProviderContext, event: import("@arc/ai").ProviderResponse): void | Promise<void>;
	onProviderStreamEvent?(context: ProviderContext, event: { readonly data: unknown }): void | Promise<void>;
}
export interface ProviderListener {
	readonly callbacks: ProviderCallbacks;
	active(): boolean;
	report(error: unknown): void;
}
export function observeProviders(
	models: Models,
	environment: {
		readonly cwd: string;
		mode(): ApplicationMode;
		listeners(): readonly ProviderListener[];
		onSession?(sessionId: string): void;
		onRequest?(
			model: import("@arc/ai").Model<import("@arc/ai").Api>,
			context: import("@arc/ai").Context,
			options: import("@arc/ai").ModelsSimpleStreamOptions | undefined,
		): void;
	},
): Models {
	const prepare = <M extends AnyModel>(
		model: M,
		options: (ProviderRequestOptions<M> & ModelsRequestTransforms) | undefined,
	) => {
		if (options && "sessionId" in options && typeof options.sessionId === "string")
			environment.onSession?.(options.sessionId);
		const listeners = environment.listeners();
		if (!listeners.length) return undefined;
		const abort = new AbortController();
		const signal = options?.signal ? AbortSignal.any([options.signal, abort.signal]) : abort.signal;
		const context: ProviderContext = {
			cwd: environment.cwd,
			mode: environment.mode(),
			model,
			signal,
			abort: (reason) => abort.abort(reason),
		};
		const notify = async (operation: (callbacks: ProviderCallbacks) => void | Promise<void>) => {
			for (const listener of listeners)
				if (listener.active())
					try {
						await operation(listener.callbacks);
					} catch (error) {
						listener.report(error);
					}
		};
		return {
			signal,
			onPayload: async (payload: unknown, actual: M) => {
				let current = await options?.onPayload?.(payload, actual);
				if (current === undefined) current = payload;
				for (const listener of listeners)
					if (listener.active())
						try {
							const replacement = await listener.callbacks.beforeProviderRequest?.(context, { payload: current });
							if (replacement !== undefined) current = replacement;
						} catch (error) {
							listener.report(error);
						}
				return current;
			},
			transformHeaders: async (headers: import("@arc/ai").ProviderHeaders) => {
				const current = options?.transformHeaders ? await options.transformHeaders(headers) : headers;
				await notify((callbacks) => callbacks.beforeProviderHeaders?.(context, { headers: current }));
				return current;
			},
			onResponse: async (response: import("@arc/ai").ProviderResponse, actual: M) => {
				await options?.onResponse?.(response, actual);
				await notify((callbacks) => callbacks.afterProviderResponse?.(context, response));
			},
			streamEvent: async (data: unknown) => {
				await notify((callbacks) => callbacks.onProviderStreamEvent?.(context, { data }));
			},
		};
	};
	const streamSimple: Models["streamSimple"] = (model, context, options) => {
		environment.onRequest?.(model, context, options);
		const observer = prepare(model, options);
		if (!observer) return models.streamSimple(model, context, options);
		const { streamEvent, ...callbacks } = observer;
		return models.streamSimple(model, context, {
			...options,
			...callbacks,
			onProviderStreamEvent: async (data, actual) => {
				await options?.onProviderStreamEvent?.(data, actual);
				await streamEvent(data);
			},
		});
	};
	const stream: Models["stream"] = (model, context, options) => {
		const observer = prepare(model, options);
		if (!observer) return models.stream(model, context, options);
		const { streamEvent, ...callbacks } = observer;
		return models.stream(
			model,
			context,
			Object.assign({}, options, callbacks, {
				onProviderStreamEvent: async (data: unknown, actual: typeof model) => {
					await options?.onProviderStreamEvent?.(data, actual);
					await streamEvent(data);
				},
			}),
		);
	};

	const completeSimple: Models["completeSimple"] = (model, context, options) => {
		environment.onRequest?.(model, context, options);
		const observer = prepare(model, options);
		if (!observer) return models.completeSimple(model, context, options);
		const { streamEvent, ...callbacks } = observer;
		return models.completeSimple(model, context, {
			...options,
			...callbacks,
			onProviderStreamEvent: async (data, actual) => {
				await options?.onProviderStreamEvent?.(data, actual);
				await streamEvent(data);
			},
		});
	};
	const complete: Models["complete"] = (model, context, options) => {
		const observer = prepare(model, options);
		if (!observer) return models.complete(model, context, options);
		const { streamEvent, ...callbacks } = observer;
		return models.complete(
			model,
			context,
			Object.assign({}, options, callbacks, {
				onProviderStreamEvent: async (data: unknown, actual: typeof model) => {
					await options?.onProviderStreamEvent?.(data, actual);
					await streamEvent(data);
				},
			}),
		);
	};
	const common = <M extends AnyModel, O extends ProviderRequestOptions<M> & ModelsRequestTransforms>(
		model: M,
		options: O | undefined,
	) => {
		const observer = prepare(model, options);
		if (!observer) return options;
		const { streamEvent: _, ...callbacks } = observer;
		return Object.assign({}, options, callbacks);
	};
	const streamDeferred: Models["streamDeferred"] = (model, handle, options) =>
		models.streamDeferred(model, handle, common(model, options));
	const fetchDeferred: Models["fetchDeferred"] = (model, handle, options) =>
		models.fetchDeferred(model, handle, common(model, options));
	const cancelDeferred: Models["cancelDeferred"] = (model, handle, options) =>
		models.cancelDeferred(model, handle, common(model, options));
	const generateImages: Models["generateImages"] = (model, context, options) =>
		models.generateImages(model, context, common(model, options));
	const classify: Models["classify"] = (model, context, options) =>
		models.classify(model, context, common(model, options));

	return new Proxy(models, {
		get(target, key) {
			if (key === "streamSimple") return streamSimple;
			if (key === "completeSimple") return completeSimple;
			if (key === "stream") return stream;
			if (key === "complete") return complete;
			if (key === "streamDeferred") return streamDeferred;
			if (key === "fetchDeferred") return fetchDeferred;
			if (key === "cancelDeferred") return cancelDeferred;
			if (key === "generateImages") return generateImages;
			if (key === "classify") return classify;
			const value = Reflect.get(target, key, target);
			return typeof value === "function" ? value.bind(target) : value;
		},
	});
}
