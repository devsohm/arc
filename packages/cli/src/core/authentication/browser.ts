import { execFile } from "node:child_process";

export function openBrowser(url: string): Promise<boolean> {
	try {
		if (!["https:", "http:"].includes(new URL(url).protocol)) return Promise.resolve(false);
	} catch {
		return Promise.resolve(false);
	}
	const [command, args] =
		process.platform === "darwin"
			? ["open", [url]]
			: process.platform === "win32"
				? ["rundll32.exe", ["url.dll,FileProtocolHandler", url]]
				: ["xdg-open", [url]];
	return new Promise((resolve) => {
		execFile(command, args, { timeout: 5000, windowsHide: true }, (error) => resolve(!error));
	});
}
