import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { expect, test, vi } from "vitest";
import { copyText, runClipboardWriter, runClipboardReader, readClipboard } from "../src/modes/interactive/clipboard.ts";

test("clipboard subprocess receives exact Unicode text and failures are bounded", async () => {
	const directory = await mkdtemp(join(tmpdir(), "arc-clipboard-"));
	try {
		const file = join(directory, "text");
		const script =
			'const fs=require("node:fs");let text="";process.stdin.setEncoding("utf8");process.stdin.on("data",chunk=>text+=chunk);process.stdin.on("end",()=>fs.writeFileSync(process.argv[1],text));';
		expect(await runClipboardWriter(process.execPath, ["-e", script, file], "雪\nexact text")).toBe(true);
		expect(await readFile(file, "utf8")).toBe("雪\nexact text");
		expect(await runClipboardWriter(process.execPath, ["-e", "process.exit(2)"], "text")).toBe(false);
		expect(await runClipboardWriter(process.execPath, ["-e", "setInterval(()=>{},1000)"], "text", 30)).toBe(false);
		expect(await runClipboardWriter(join(directory, "missing"), [], "text")).toBe(false);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test.skipIf(process.platform !== "linux")("remote clipboard writes bounded OSC 52 to the terminal edge", async () => {
	vi.stubEnv("SSH_CONNECTION", "fixture");
	vi.stubEnv("DISPLAY", "");
	vi.stubEnv("WAYLAND_DISPLAY", "");
	vi.stubEnv("TERMUX_VERSION", "");
	const output: string[] = [];
	try {
		await copyText("Snow 雪", (data) => output.push(data));
		expect(output).toEqual([`\x1b]52;c;${Buffer.from("Snow 雪").toString("base64")}\x07`]);
		await expect(copyText("x".repeat(100_001), (data) => output.push(data))).rejects.toThrow("transfer limit");
	} finally {
		vi.unstubAllEnvs();
	}
});

test("clipboard reads preserve binary output and bound missing or stalled subprocesses", async () => {
	expect(await runClipboardReader(process.execPath, ["-e", "process.stdout.write(Buffer.from([0,255,1]))"])).toEqual(
		Buffer.from([0, 255, 1]),
	);
	expect(await runClipboardReader("arc-no-such-clipboard-program", [])).toBeUndefined();
	expect(await runClipboardReader(process.execPath, ["-e", "setInterval(()=>{},1000)"], 20)).toBeUndefined();
});

test.skipIf(process.platform !== "linux")(
	"Wayland image reads use the selected MIME type and an empty clipboard does not fall back to X11",
	async () => {
		const directory = await mkdtemp(join(tmpdir(), "arc-clipboard-read-"));
		const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==";
		try {
			const command = join(directory, "wl-paste");
			await writeFile(
				command,
				`#!${process.execPath}\nif(process.argv.includes('--list-types'))process.stdout.write(process.env.ARC_TEST_CLIP_EMPTY?'':'image/png');else process.stdout.write(Buffer.from('${png}','base64'));`,
			);
			await chmod(command, 0o700);
			const fallback = join(directory, "xclip");
			await writeFile(
				fallback,
				`#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(join(directory, "xclip-used"))},'used');`,
			);
			await chmod(fallback, 0o700);
			vi.stubEnv("PATH", directory + delimiter + (process.env.PATH ?? ""));
			vi.stubEnv("WAYLAND_DISPLAY", "fixture");
			vi.stubEnv("DISPLAY", "fixture");
			expect(await readClipboard()).toEqual({
				type: "image",
				image: { type: "image", mimeType: "image/png", data: png },
			});
			vi.stubEnv("ARC_TEST_CLIP_EMPTY", "1");
			expect(await readClipboard()).toBeUndefined();
			await expect(readFile(join(directory, "xclip-used"))).rejects.toMatchObject({ code: "ENOENT" });
		} finally {
			vi.unstubAllEnvs();
			await rm(directory, { recursive: true, force: true });
		}
	},
);

test("clipboard readers cancel on host shutdown without waiting for their timeout", async () => {
	const controller = new AbortController();
	const reading = runClipboardReader(process.execPath, ["-e", "setInterval(()=>{},1000)"], 10_000, controller.signal);
	controller.abort();
	expect(await reading).toBeUndefined();
	expect(await runClipboardReader("never-started", [], 10_000, controller.signal)).toBeUndefined();
});
