import {
	TuiAltScreen,
	TuiMainScreen,
	type Component,
	type Terminal,
	type TUI,
	type TuiInputListener,
	type TuiMainScreenRenderState,
	type OverlayHandle,
	type TuiAltScreenOptions,
} from "@arc/tui";

type ColorListener = Parameters<TUI["onTerminalColorSchemeChange"]>[0];

export class InteractiveRenderer {
	readonly ui: TUI;
	#active: TuiMainScreen | TuiAltScreen;
	#layout: Component | undefined;
	#mainState: TuiMainScreenRenderState | undefined;
	#started = false;
	#notifications = false;
	readonly #inputs = new Set<TuiInputListener>();
	readonly #colors = new Map<ColorListener, () => void>();
	readonly #overlays = new Set<OverlayHandle>();
	readonly #fullscreenOptions: TuiAltScreenOptions;

	constructor(terminal: Terminal, fullscreen: boolean, fullscreenOptions: TuiAltScreenOptions = {}) {
		this.#fullscreenOptions = fullscreenOptions;
		this.#active = fullscreen
			? new TuiAltScreen(terminal, undefined, undefined, fullscreenOptions)
			: new TuiMainScreen(terminal);
		const addInput: TUI["addInputListener"] = (listener) => {
			this.#inputs.add(listener);
			this.#active.addInputListener(listener);
			return () => removeInput(listener);
		};
		const removeInput: TUI["removeInputListener"] = (listener) => {
			this.#inputs.delete(listener);
			this.#active.removeInputListener(listener);
		};
		const colors: TUI["onTerminalColorSchemeChange"] = (listener) => {
			this.#colors.get(listener)?.();
			this.#colors.set(listener, this.#active.onTerminalColorSchemeChange(listener));
			return () => {
				this.#colors.get(listener)?.();
				this.#colors.delete(listener);
			};
		};
		const notifications: TUI["setTerminalColorSchemeNotifications"] = (enabled) => {
			this.#notifications = enabled;
			this.#active.setTerminalColorSchemeNotifications(enabled);
		};
		const start: TUI["start"] = () => {
			this.#active.start();
			this.#started = true;
		};
		const stop: TUI["stop"] = (options) => {
			this.#active.stop(options);
			this.#started = false;
		};
		const showOverlay: TUI["showOverlay"] = (component, options) => {
			const handle = this.#active.showOverlay(component, options);
			const tracked: OverlayHandle = {
				...handle,
				hide: () => {
					handle.hide();
					this.#overlays.delete(tracked);
				},
			};
			this.#overlays.add(tracked);
			return tracked;
		};
		const hideOverlay: TUI["hideOverlay"] = () => {
			const handle = [...this.#overlays].at(-1);
			if (handle) handle.hide();
			else this.#active.hideOverlay();
		};
		const methods = {
			addInputListener: addInput,
			removeInputListener: removeInput,
			onTerminalColorSchemeChange: colors,
			setTerminalColorSchemeNotifications: notifications,
			showOverlay,
			hideOverlay,
			start,
			stop,
		};
		this.ui = new Proxy(this.#active, {
			get: (_target, key) => {
				if (Object.hasOwn(methods, key)) return Reflect.get(methods, key);
				const member: unknown = Reflect.get(this.#active, key, this.#active);
				if (typeof member !== "function") return member;
				return (...args: unknown[]) => {
					const receiver = this.#active;
					const method: unknown = Reflect.get(receiver, key, receiver);
					if (typeof method !== "function") throw new TypeError(`Terminal method is unavailable: ${String(key)}`);
					return Reflect.apply(method, receiver, args);
				};
			},
			set: (_target, key, value) => Reflect.set(this.#active, key, value, this.#active),
			has: (_target, key) => Reflect.has(this.#active, key),
			getPrototypeOf: () => Object.getPrototypeOf(this.#active),
		});
	}

	setLayoutRoot(component: Component): void {
		this.#layout = component;
		if (this.#active instanceof TuiAltScreen) this.#active.setLayoutRoot(component);
	}

	switchMode(fullscreen: boolean): void {
		if ((this.#active.mode === "fullscreen") === fullscreen) return;
		const previous = this.#active;
		if (this.#overlays.size || previous.hasOverlay())
			throw new Error("Close terminal overlays before changing screen mode");
		const children = [...previous.children];
		const focus = previous.getFocusedComponent();
		if (previous instanceof TuiMainScreen) this.#mainState = previous.captureRenderState();
		const next = fullscreen
			? new TuiAltScreen(previous.terminal, previous.getShowHardwareCursor(), undefined, this.#fullscreenOptions)
			: new TuiMainScreen(previous.terminal, previous.getShowHardwareCursor());
		next.setClearOnShrink(previous.getClearOnShrink());
		next.onDebug = previous.onDebug;
		if (next instanceof TuiMainScreen && this.#mainState) next.restoreRenderState(this.#mainState);
		for (const child of children) next.addChild(child);
		if (next instanceof TuiAltScreen) next.setLayoutRoot(this.#layout);
		for (const listener of this.#inputs) {
			previous.removeInputListener(listener);
			next.addInputListener(listener);
		}
		for (const [listener, remove] of this.#colors) {
			remove();
			this.#colors.set(listener, next.onTerminalColorSchemeChange(listener));
		}
		next.setTerminalColorSchemeNotifications(this.#notifications);
		if (this.#started) previous.stop({ preserveScreen: true });
		previous.setFocus(null);
		previous.clear();
		if (previous instanceof TuiAltScreen) previous.setLayoutRoot(undefined);
		this.#active = next;
		next.invalidate();
		next.setFocus(focus);
		if (this.#started) next.start();
	}
}
