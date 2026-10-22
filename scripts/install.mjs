import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { copyFile, lstat, mkdir, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const owner = "arc-archive-install-v1";
const markerName = ".arc-install.json";
const cliEntry = "app/node_modules/@arc/cli/dist/cli.js";

export function requireNode() {
	const [major, minor] = process.versions.node.split(".").map(Number);
	if (major < 22 || (major === 22 && minor < 19)) throw new Error("Arc requires Node.js 22.19.0 or newer.");
}

export function resolvePrefix(prefix) {
	const result = path.resolve(prefix);
	const dataPath = path.relative(result, path.join(homedir(), ".arc"));
	if (dataPath === "" || (!dataPath.startsWith(`..${path.sep}`) && dataPath !== ".." && !path.isAbsolute(dataPath)))
		throw new Error("The install prefix must not contain the Arc data directory ~/.arc.");
	return result;
}

function isObject(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function readJson(filename) {
	try {
		return JSON.parse(await readFile(filename, "utf8"));
	} catch {
		throw new Error(`Cannot read valid JSON from ${filename}`);
	}
}

export async function readInstallation(prefix) {
	let directory;
	try {
		directory = await lstat(prefix);
	} catch (error) {
		if (error.code === "ENOENT") return undefined;
		throw error;
	}
	if (!directory.isDirectory() || directory.isSymbolicLink())
		throw new Error(`Refusing a prefix that is not an owned directory: ${prefix}`);
	let metadata;
	try {
		metadata = await readJson(path.join(prefix, markerName));
	} catch {
		throw new Error(`Refusing a prefix without valid Arc ownership metadata: ${prefix}`);
	}
	if (
		!isObject(metadata) ||
		metadata.owner !== owner ||
		metadata.prefix !== prefix ||
		typeof metadata.version !== "string" ||
		typeof metadata.sourceHash !== "string" ||
		!/^[a-f0-9]{64}$/.test(metadata.sourceHash)
	)
		throw new Error(`Refusing a prefix without valid Arc ownership metadata: ${prefix}`);
	return metadata;
}

export async function findNpmCli() {
	const nodeDirectory = path.dirname(process.execPath);
	const candidates = [
		process.env.npm_execpath,
		path.join(nodeDirectory, "node_modules/npm/bin/npm-cli.js"),
		path.resolve(nodeDirectory, "../lib/node_modules/npm/bin/npm-cli.js"),
		path.resolve(nodeDirectory, "../share/nodejs/npm/bin/npm-cli.js"),
	];
	for (const directory of (process.env.PATH ?? "").split(path.delimiter)) {
		if (!directory) continue;
		candidates.push(path.join(directory, "npm"), path.join(directory, "node_modules/npm/bin/npm-cli.js"));
	}
	for (const candidate of candidates) {
		if (!candidate) continue;
		try {
			const filename = await realpath(candidate);
			if (path.basename(filename) === "npm-cli.js" && (await lstat(filename)).isFile()) return filename;
		} catch {}
	}
	throw new Error("Cannot find npm-cli.js. Install a Node.js distribution that includes npm.");
}

function runNpm(npm, args, cwd) {
	return new Promise((resolve, reject) => {
		const child = spawn(process.execPath, [npm, ...args], { cwd, stdio: "inherit", windowsHide: true });
		child.once("error", reject);
		child.once("close", (code) => {
			if (code === 0) resolve();
			else reject(new Error(`npm install failed with exit code ${code ?? "unknown"}.`));
		});
	});
}

async function inspectRelease(source) {
	const manifestText = await readFile(path.join(source, "package.json"), "utf8");
	const manifest = await readJson(path.join(source, "package.json"));
	const release = await readJson(path.join(source, "release.json"));
	if (
		!isObject(manifest) ||
		typeof manifest.version !== "string" ||
		!manifest.version ||
		!isObject(manifest.dependencies) ||
		!Object.hasOwn(manifest.dependencies, "@arc/cli") ||
		!isObject(release) ||
		release.version !== manifest.version
	)
		throw new Error("The source is not a prepared Arc application release.");
	const nativeTarget = `${process.platform === "win32" ? "windows" : process.platform}-${process.arch}`;
	const terminalTarget = `${process.platform}-${process.arch}`;
	if (!Array.isArray(release.nativeTargets) || !release.nativeTargets.includes(nativeTarget))
		throw new Error(`The release does not contain an environment daemon for ${nativeTarget}.`);
	if (!Array.isArray(release.terminalTargets) || !release.terminalTargets.includes(terminalTarget))
		throw new Error(`The release does not contain a terminal helper for ${terminalTarget}.`);
	const sumsText = await readFile(path.join(source, "SHA256SUMS"), "utf8");
	const checksums = new Map();
	for (const line of sumsText.trim().split(/\r?\n/)) {
		const match = /^([a-fA-F0-9]{64})  (packages\/[^/\\]+\.tgz)$/.exec(line);
		if (!match || checksums.has(match[2])) throw new Error("Invalid release SHA256SUMS.");
		checksums.set(match[2], match[1].toLowerCase());
	}
	const archives = [];
	for (const specifier of Object.values(manifest.dependencies)) {
		const match = typeof specifier === "string" && /^file:\.\/(packages\/[^/\\]+\.tgz)$/.exec(specifier);
		if (!match) throw new Error("Release dependencies must use local package archives.");
		const filename = match[1];
		const archive = path.join(source, filename);
		if (!(await lstat(archive)).isFile()) throw new Error(`Release archive is not a regular file: ${filename}`);
		const hash = createHash("sha256")
			.update(await readFile(archive))
			.digest("hex");
		if (checksums.get(filename) !== hash) throw new Error(`Release checksum mismatch: ${filename}`);
		archives.push(filename);
	}
	if (checksums.size !== new Set(archives).size) throw new Error("Release checksums do not match its dependencies.");
	const sourceHash = createHash("sha256").update(manifestText).update("\0").update(sumsText).digest("hex");
	return { manifest, archives, sourceHash };
}

async function checkInstalled(prefix) {
	const entry = await lstat(path.join(prefix, cliEntry));
	if (!entry.isFile()) throw new Error("The installed Arc CLI entrypoint is missing.");
	if (!(await stat(path.join(prefix, "bin", process.platform === "win32" ? "arc.cmd" : "arc"))).isFile())
		throw new Error("The installed Arc launcher is missing.");
}

export async function install({ source, prefix, offline = false }) {
	requireNode();
	source = path.resolve(source);
	prefix = resolvePrefix(prefix);
	const { manifest, archives, sourceHash } = await inspectRelease(source);
	const previous = await readInstallation(prefix);
	if (previous) {
		if (previous.sourceHash !== sourceHash || previous.version !== manifest.version)
			throw new Error("The prefix contains a different Arc release. Uninstall it before installing another release.");
		await checkInstalled(prefix);
		console.log(`Arc ${manifest.version} is already installed at ${prefix}`);
		return;
	}
	const npm = await findNpmCli();
	await mkdir(path.dirname(prefix), { recursive: true });
	await mkdir(prefix);
	try {
		const application = path.join(prefix, "app");
		await mkdir(path.join(application, "packages"), { recursive: true });
		for (const filename of archives) await copyFile(path.join(source, filename), path.join(application, filename));
		await writeFile(
			path.join(application, "package.json"),
			`${JSON.stringify({ private: true, type: "module", dependencies: manifest.dependencies }, null, 2)}\n`,
		);
		await runNpm(
			npm,
			[
				"install",
				"--ignore-scripts",
				"--no-audit",
				"--no-fund",
				"--omit=dev",
				"--package-lock=false",
				...(offline ? ["--offline"] : []),
			],
			application,
		);
		await mkdir(path.join(prefix, "bin"));
		if (process.platform === "win32") {
			await writeFile(
				path.join(prefix, "bin/arc.cmd"),
				'@echo off\r\nnode "%~dp0..\\app\\node_modules\\@arc\\cli\\dist\\cli.js" %*\r\n',
			);
		} else {
			await symlink("../app/node_modules/.bin/arc", path.join(prefix, "bin/arc"));
		}
		await checkInstalled(prefix);
		await writeFile(
			path.join(prefix, markerName),
			`${JSON.stringify({ owner, prefix, version: manifest.version, sourceHash }, null, 2)}\n`,
			{ flag: "wx" },
		);
	} catch (error) {
		await rm(prefix, { recursive: true, force: true });
		throw error;
	}
	console.log(`Installed Arc ${manifest.version} at ${prefix}`);
	console.log(`Add ${path.join(prefix, "bin")} to PATH to run arc.`);
}

async function main(args) {
	if (args.includes("--help")) {
		console.log("Usage: node install.mjs --source <release-folder> --prefix <owned-install-folder> [--offline]");
		return;
	}
	const options = {};
	for (let index = 0; index < args.length; index++) {
		const flag = args[index];
		if (flag === "--offline") options.offline = true;
		else if ((flag === "--source" || flag === "--prefix") && args[index + 1] && !args[index + 1].startsWith("--")) {
			const key = flag.slice(2);
			if (options[key] !== undefined) throw new Error(`Duplicate option: ${flag}`);
			options[key] = args[++index];
		} else throw new Error(`Unknown option or missing value: ${flag}`);
	}
	if (!options.source || !options.prefix) throw new Error("Both --source and --prefix are required.");
	await install(options);
}

const invokedScript = process.argv[1] && (await realpath(process.argv[1]).catch(() => undefined));
if (invokedScript && pathToFileURL(invokedScript).href === import.meta.url) {
	main(process.argv.slice(2)).catch((error) => {
		console.error(error instanceof Error ? error.message : "Arc installation failed.");
		process.exitCode = 1;
	});
}
