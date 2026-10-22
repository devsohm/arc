import { randomUUID } from "node:crypto";
import { createUnavailableUI, type ApplicationUI, type UIDialogOptions } from "../../core/ui/ui.ts";

export function createRpcUI(send: (record: unknown) => Promise<void>) {
	const pending = new Map<string, { answer(value: unknown): void; cancel(): void }>();
	let closed = false;
	const notify = (method: string, params: object) => {
		if (closed) throw new Error("The RPC UI is closed");
		void send({ jsonrpc: "2.0", method: "extension_ui_request", params: { method, ...params } }).catch(() => {});
	};
	function dialog<T>(
		method: string,
		params: object,
		cancelled: T,
		parse: (value: unknown) => T,
		options?: UIDialogOptions,
	): Promise<T> {
		if (closed || options?.signal?.aborted) return Promise.resolve(cancelled);
		return new Promise<T>((resolve, reject) => {
			const requestId = randomUUID();
			let timer: ReturnType<typeof setTimeout> | undefined;
			const cleanup = () => {
				pending.delete(requestId);
				if (timer !== undefined) clearTimeout(timer);
				options?.signal?.removeEventListener("abort", cancel);
			};
			const cancel = () => {
				cleanup();
				resolve(cancelled);
			};
			pending.set(requestId, {
				answer(value) {
					const answer = parse(value);
					cleanup();
					resolve(answer);
				},
				cancel,
			});
			options?.signal?.addEventListener("abort", cancel, { once: true });
			if (options?.timeout && options.timeout > 0) timer = setTimeout(cancel, options.timeout);
			void send({
				jsonrpc: "2.0",
				method: "extension_ui_request",
				params: { requestId, method, ...params, ...(options?.timeout ? { timeout: options.timeout } : {}) },
			}).catch((error) => {
				cleanup();
				reject(error);
			});
		});
	}
	const text = (value: unknown): string | undefined => {
		if (value === undefined || typeof value === "string") return value;
		throw new Error("UI response value must be a string");
	};
	const ui: ApplicationUI = createUnavailableUI();
	Object.assign(ui, {
		capabilities: {
			...ui.capabilities,
			select: true,
			confirm: true,
			input: true,
			notifications: true,
			status: true,
			title: true,
		},
		select: (
			title: string,
			items: Parameters<ApplicationUI["select"]>[1],
			options?: Parameters<ApplicationUI["select"]>[2],
		) =>
			dialog(
				"select",
				{ title, items, initialValue: options?.initialValue, initialSearch: options?.initialSearch },
				undefined,
				(value) => {
					const selected = text(value);
					if (selected !== undefined && !items.some((item) => item.value === selected))
						throw new Error("Unknown UI selection");
					return selected;
				},
				options,
			),
		confirm: (title: string, message: string, options?: UIDialogOptions) =>
			dialog(
				"confirm",
				{ title, message },
				false,
				(value) => {
					if (typeof value !== "boolean") throw new Error("UI response value must be a boolean");
					return value;
				},
				options,
			),
		input: (title: string, initial = "", options?: Parameters<ApplicationUI["input"]>[2]) =>
			dialog("input", { title, initial, secret: options?.secret ?? false }, undefined, text, options),
		editor: (title: string, initial = "") => dialog("editor", { title, initial }, undefined, text),
		notify: (message: string, kind?: Parameters<ApplicationUI["notify"]>[1]) => notify("notify", { message, kind }),
		setStatus: (key: string, text?: string) => notify("set_status", { key, text }),
		setTitle: (title: string) => notify("set_title", { title }),
		setEditorText: (text: string) => notify("set_editor_text", { text }),
		pasteToEditor: (text: string) => notify("set_editor_text", { text }),
		getEditorText: () => "",
	} satisfies Partial<ApplicationUI>);
	Object.defineProperty(ui, "supported", { get: () => !closed });
	return {
		ui,
		respond(params: Record<string, unknown>): boolean {
			if (typeof params.requestId !== "string") throw new Error("requestId must be a string");
			if (params.cancelled !== undefined && typeof params.cancelled !== "boolean")
				throw new Error("cancelled must be a boolean");
			const request = pending.get(params.requestId);
			if (!request) return false;
			if (params.cancelled) request.cancel();
			else request.answer(params.value);
			return true;
		},
		close() {
			if (closed) return;
			closed = true;
			for (const request of pending.values()) request.cancel();
		},
	};
}
