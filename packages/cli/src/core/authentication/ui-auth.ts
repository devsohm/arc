import { linkifyUrls } from "../ui/text.ts";
import { Text } from "@arc/tui";
import type { Models, ModelsRefreshResult } from "@arc/ai";
import type { ApplicationUI } from "../ui/ui.ts";
import { loginProvider } from "./auth.ts";
import { openBrowser } from "./browser.ts";

export async function loginWithUI(
	models: Models,
	ui: ApplicationUI,
	provider: string,
	signal: AbortSignal,
): Promise<ModelsRefreshResult> {
	const controller = new AbortController();
	const cancel = () => controller.abort(signal.reason);
	signal.addEventListener("abort", cancel, { once: true });
	if (signal.aborted) cancel();
	let finish = () => {};
	const progress = new Text(`Signing in to ${provider}\nEscape cancels`, 1, 0);
	const waiting = ui.capabilities.custom
		? ui.custom<void>((_tui, _theme, _keybindings, done) => {
				finish = done;
				return progress;
			})
		: Promise.resolve();
	void waiting.catch((error: unknown) => controller.abort(error));
	try {
		await loginProvider(models, provider, {
			signal: controller.signal,
			async prompt(prompt) {
				const promptSignal = prompt.signal ? AbortSignal.any([controller.signal, prompt.signal]) : controller.signal;
				promptSignal.throwIfAborted();
				const value =
					prompt.type === "select"
						? await ui.select(
								prompt.message,
								prompt.options.map((option) => ({ ...option, value: option.id })),
								{ signal: promptSignal },
							)
						: await ui.input(prompt.message, "", { secret: prompt.type === "secret", signal: promptSignal });
				promptSignal.throwIfAborted();
				if (value === undefined) {
					controller.abort(new DOMException("Login cancelled", "AbortError"));
					controller.signal.throwIfAborted();
				}
				return value ?? "";
			},
			notify(event) {
				if (event.type === "auth_url" && ui.capabilities.custom) {
					void openBrowser(event.url).then((opened) => {
						if (!opened && !controller.signal.aborted)
							ui.notify("Could not open the browser. Copy the complete login URL into your browser.", "warning");
					});
				}
				const message =
					event.type === "auth_url"
						? [event.instructions, event.url].filter(Boolean).join("\n")
						: event.type === "device_code"
							? `${event.verificationUri}\nCode: ${event.userCode}`
							: [event.message, ...(event.type === "info" ? (event.links?.map((link) => link.url) ?? []) : [])].join(
									"\n",
								);
				// Provider messages are external text, not terminal escape instructions.
				progress.setText(linkifyUrls(message) + "\nEscape cancels");
				ui.notify(message);
			},
		});
		progress.setText(`Signed in to ${provider}\nRefreshing models…\nEscape cancels`);
		return await models.refresh({
			providers: [provider],
			force: true,
			signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15_000)]),
		});
	} finally {
		controller.abort();
		finish();
		await waiting.catch(() => {});
		signal.removeEventListener("abort", cancel);
	}
}
