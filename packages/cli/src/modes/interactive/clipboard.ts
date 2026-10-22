import { spawn } from "node:child_process";
import { getNativeClipboard } from "@arc/tui";
import type { ImageContent } from "@arc/ai";
import { detectSupportedImageMimeType } from "@arc/durable/tools";

export type ClipboardContent =
	| { readonly type: "text"; readonly text: string }
	| { readonly type: "image"; readonly image: ImageContent };

export function runClipboardReader(
	command: string,
	args: readonly string[],
	timeout = 3000,
	signal?: AbortSignal,
): Promise<Buffer | undefined> {
	if (signal?.aborted) return Promise.resolve(undefined);
	return new Promise((resolve) => {
		const child = spawn(command, args, {
			stdio: ["ignore", "pipe", "ignore"],
			detached: process.platform !== "win32",
			windowsHide: true,
		});
		const chunks: Buffer[] = [];
		let size = 0;
		let settled = false;
		const finish = (result: Buffer | undefined) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			signal?.removeEventListener("abort", stop);
			resolve(result);
		};
		const stop = () => {
			child.kill("SIGKILL");
			child.stdout.destroy();
			finish(undefined);
		};
		const timer = setTimeout(stop, timeout);
		child.stdout.on("data", (bytes: Buffer) => {
			size += bytes.length;
			if (size > 16 * 1024 * 1024) stop();
			else chunks.push(bytes);
		});
		child.once("error", () => finish(undefined));
		child.stdout.once("error", stop);
		child.once("close", (code) => finish(code === 0 ? Buffer.concat(chunks) : undefined));
		signal?.addEventListener("abort", stop, { once: true });
		if (signal?.aborted) stop();
	});
}

function clipboardImage(bytes: Uint8Array): ClipboardContent | undefined {
	const mimeType = detectSupportedImageMimeType(bytes);
	return mimeType
		? { type: "image", image: { type: "image", mimeType, data: Buffer.from(bytes).toString("base64") } }
		: undefined;
}

async function readLinuxClipboard(
	command: "wl-paste" | "xclip",
	signal?: AbortSignal,
): Promise<ClipboardContent | null | undefined> {
	const args = command === "wl-paste" ? ["--list-types"] : ["-selection", "clipboard", "-o", "-t", "TARGETS"];
	signal?.throwIfAborted();
	const listed = await runClipboardReader(command, args, 1000, signal);
	signal?.throwIfAborted();
	if (listed === undefined) return undefined;
	const types = listed
		.toString("utf8")
		.split(/\r?\n/)
		.map((type) => type.trim());
	const selected = [
		"image/png",
		"image/jpeg",
		"image/webp",
		"image/gif",
		"image/bmp",
		"text/plain;charset=utf-8",
		"UTF8_STRING",
		"text/plain",
	].find((type) => types.includes(type));
	if (!selected) return null;
	const bytes = await runClipboardReader(
		command,
		command === "wl-paste" ? ["--type", selected, "--no-newline"] : ["-selection", "clipboard", "-o", "-t", selected],
		3000,
		signal,
	);
	signal?.throwIfAborted();
	if (bytes === undefined) return undefined;
	if (!bytes.length) return null;
	return selected.startsWith("image/")
		? (clipboardImage(bytes) ?? null)
		: { type: "text", text: bytes.toString("utf8") };
}

export async function readClipboard(signal?: AbortSignal): Promise<ClipboardContent | undefined> {
	signal?.throwIfAborted();
	if (process.platform === "linux") {
		if (process.env.WAYLAND_DISPLAY || process.env.XDG_SESSION_TYPE === "wayland") {
			const value = await readLinuxClipboard("wl-paste", signal);
			if (value !== undefined) return value ?? undefined;
		}
		if (process.env.DISPLAY) {
			const value = await readLinuxClipboard("xclip", signal);
			if (value !== undefined) return value ?? undefined;
		}
	}
	const native = getNativeClipboard();
	if (!native) return undefined;
	const bytes = await native.getImage();
	signal?.throwIfAborted();
	if (bytes?.length) {
		const image = clipboardImage(bytes);
		if (image) return image;
	}
	const text = await native.getText();
	signal?.throwIfAborted();
	return text ? { type: "text", text } : undefined;
}

export function runClipboardWriter(
	command: string,
	args: readonly string[],
	text: string,
	timeout = 5000,
): Promise<boolean> {
	return new Promise((resolve) => {
		const child = spawn(command, args, {
			stdio: ["pipe", "ignore", "ignore"],
			detached: process.platform !== "win32",
			windowsHide: true,
		});
		let settled = false;
		const finish = (success: boolean) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolve(success);
		};
		const timer = setTimeout(() => {
			child.kill("SIGKILL");
			child.stdin.destroy();
			finish(false);
		}, timeout);
		child.once("error", () => finish(false));
		child.once("close", (code) => finish(code === 0));
		child.stdin.on("error", () => {});
		child.stdin.end(
			process.platform === "win32" && command === "clip" ? Buffer.from("\ufeff" + text, "utf16le") : text,
		);
	});
}

export async function copyText(text: string, write: (data: string) => void): Promise<void> {
	let copied = false;
	if (process.platform !== "linux") {
		try {
			const clipboard = getNativeClipboard();
			if (clipboard?.setText) {
				await clipboard.setText(text);
				copied = true;
			}
		} catch {
			/* Try the platform command when its native helper is unavailable. */
		}
	}
	const commands: [string, string[]][] =
		process.platform === "darwin"
			? [["pbcopy", []]]
			: process.platform === "win32"
				? [["clip", []]]
				: [
						...(process.env.TERMUX_VERSION ? [["termux-clipboard-set", []] satisfies [string, string[]]] : []),
						...(process.env.WAYLAND_DISPLAY ? [["wl-copy", []] satisfies [string, string[]]] : []),
						...(process.env.DISPLAY
							? [
									["xclip", ["-selection", "clipboard"]] satisfies [string, string[]],
									["xsel", ["--clipboard", "--input"]] satisfies [string, string[]],
								]
							: []),
					];
	for (const [command, args] of commands) {
		if (copied) break;
		copied = await runClipboardWriter(command, args, text);
	}
	const remote =
		process.env.SSH_CONNECTION ||
		process.env.SSH_CLIENT ||
		process.env.MOSH_CONNECTION ||
		process.env.ARC_CLIPBOARD_OSC52 === "1";
	const headless =
		process.platform === "linux" && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY && !process.env.TERMUX_VERSION;
	if (remote || (!copied && headless)) {
		const encoded = Buffer.from(text).toString("base64");
		if (encoded.length <= 100_000) {
			write(`\x1b]52;c;${encoded}\x07`);
			copied = true;
		} else if (!copied) throw new Error("Clipboard text exceeds the terminal transfer limit");
	}
	if (!copied)
		throw new Error("Clipboard unavailable. Install a platform clipboard utility or enable terminal OSC 52 support.");
}
