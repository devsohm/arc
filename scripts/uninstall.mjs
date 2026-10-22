import { realpath, rm } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { readInstallation, requireNode, resolvePrefix } from "./install.mjs";

export async function uninstall(prefix) {
	requireNode();
	prefix = resolvePrefix(prefix);
	if (!(await readInstallation(prefix))) {
		console.log(`Arc is not installed at ${prefix}`);
		return;
	}
	await rm(prefix, { recursive: true });
	console.log(`Uninstalled Arc from ${prefix}`);
}

async function main(args) {
	if (args.length === 1 && args[0] === "--help") {
		console.log("Usage: node uninstall.mjs --prefix <owned-install-folder>");
		return;
	}
	if (args.length !== 2 || args[0] !== "--prefix" || !args[1] || args[1].startsWith("--"))
		throw new Error("Usage: node uninstall.mjs --prefix <owned-install-folder>");
	await uninstall(args[1]);
}

const invokedScript = process.argv[1] && (await realpath(process.argv[1]).catch(() => undefined));
if (invokedScript && pathToFileURL(invokedScript).href === import.meta.url) {
	main(process.argv.slice(2)).catch((error) => {
		console.error(error instanceof Error ? error.message : "Arc uninstallation failed.");
		process.exitCode = 1;
	});
}
