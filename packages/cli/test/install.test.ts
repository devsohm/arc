import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

const run = promisify(execFile);
const installScript = fileURLToPath(new URL("../../../scripts/install.mjs", import.meta.url));
const uninstallScript = fileURLToPath(new URL("../../../scripts/uninstall.mjs", import.meta.url));
const installShell = fileURLToPath(new URL("../../../scripts/install.sh", import.meta.url));
const uninstallShell = fileURLToPath(new URL("../../../scripts/uninstall.sh", import.meta.url));

describe.skipIf(process.platform === "win32")("archive installation", () => {
	let directory: string;
	let source: string;
	let fixture: string;
	let prefix: string;
	let environment: NodeJS.ProcessEnv;

	beforeAll(async () => {
		directory = await mkdtemp(join(tmpdir(), "arc install test "));
		source = join(directory, "release with spaces");
		await mkdir(join(source, "packages"), { recursive: true });
		environment = {
			...process.env,
			npm_config_cache: join(directory, "npm-cache"),
			npm_config_userconfig: join(directory, "user-npmrc"),
			npm_config_globalconfig: join(directory, "global-npmrc"),
		};
		const npm = process.env.npm_execpath;
		if (!npm) throw new Error("Run installer tests with npm test or npx vitest.");
		for (const name of ["fixture-helper", "cli"]) {
			const packageDirectory = join(directory, name);
			await mkdir(join(packageDirectory, "dist"), { recursive: true });
			const manifest = {
				name: `@arc/${name}`,
				version: "1.2.3",
				type: "module",
				files: ["dist"],
				scripts: { postinstall: 'node -e "process.exit(91)"' },
				...(name === "cli"
					? { bin: { arc: "./dist/cli.js" }, dependencies: { "@arc/fixture-helper": "1.2.3" } }
					: { exports: "./dist/index.js" }),
			};
			await writeFile(join(packageDirectory, "package.json"), JSON.stringify(manifest));
			await writeFile(
				join(packageDirectory, "dist", name === "cli" ? "cli.js" : "index.js"),
				name === "cli"
					? '#!/usr/bin/env node\nimport { message } from "@arc/fixture-helper";\nconsole.log(JSON.stringify({ message, args: process.argv.slice(2) }));\n'
					: 'export const message = "archive fixture installed";\n',
			);
			await run(
				process.execPath,
				[npm, "pack", packageDirectory, "--ignore-scripts", "--pack-destination", join(source, "packages")],
				{ env: environment },
			);
		}
		const dependencies: Record<string, string> = {};
		const sums: string[] = [];
		for (const filename of (await readdir(join(source, "packages"))).sort()) {
			const name = filename.startsWith("arc-cli-") ? "@arc/cli" : "@arc/fixture-helper";
			dependencies[name] = `file:./packages/${filename}`;
			sums.push(
				`${createHash("sha256")
					.update(await readFile(join(source, "packages", filename)))
					.digest("hex")}  packages/${filename}`,
			);
		}
		await writeFile(
			join(source, "package.json"),
			JSON.stringify({ name: "arc-release-fixture", private: true, version: "1.2.3", dependencies }),
		);
		await writeFile(join(source, "SHA256SUMS"), `${sums.join("\n")}\n`);
		await writeFile(
			join(source, "release.json"),
			JSON.stringify({
				version: "1.2.3",
				nativeTargets: [`${process.platform}-${process.arch}`],
				terminalTargets: [`${process.platform}-${process.arch}`],
			}),
		);
	}, 30_000);

	afterAll(async () => {
		await rm(directory, { recursive: true, force: true });
	});

	beforeEach(async () => {
		fixture = await mkdtemp(join(directory, "case "));
		prefix = join(fixture, "installed arc & fixture");
	});

	afterEach(async () => {
		await rm(fixture, { recursive: true, force: true });
	});

	async function install(release = source, extra: string[] = []) {
		return run(process.execPath, [installScript, "--source", release, "--prefix", prefix, "--offline", ...extra], {
			env: environment,
		});
	}

	it("installs actual local archives, runs the command, reruns, and preserves application data on uninstall", async () => {
		const personal = join(fixture, "personal", ".arc");
		await mkdir(join(personal, "sessions"), { recursive: true });
		await writeFile(join(personal, "auth.json"), "fixture-credential-content");
		await writeFile(join(personal, "sessions", "fixture.jsonl"), "fixture-session-content");
		expect((await install()).stdout).toContain("Installed Arc 1.2.3");
		const args = ["--fixture", "argument with spaces", "; touch unexpected-file"];
		const command = await run(join(prefix, "bin", "arc"), args, { cwd: fixture });
		expect(JSON.parse(command.stdout)).toEqual({ message: "archive fixture installed", args });
		await expect(stat(join(fixture, "unexpected-file"))).rejects.toMatchObject({ code: "ENOENT" });
		expect((await install()).stdout).toContain("already installed");
		expect(JSON.parse(await readFile(join(prefix, ".arc-install.json"), "utf8"))).toMatchObject({
			owner: "arc-archive-install-v1",
			prefix,
			version: "1.2.3",
		});
		await run(process.execPath, [uninstallScript, "--prefix", prefix], { env: environment });
		await expect(stat(prefix)).rejects.toMatchObject({ code: "ENOENT" });
		expect(await readFile(join(personal, "auth.json"), "utf8")).toBe("fixture-credential-content");
		expect(await readFile(join(personal, "sessions", "fixture.jsonl"), "utf8")).toBe("fixture-session-content");
		expect((await run(process.execPath, [uninstallScript, "--prefix", prefix], { env: environment })).stdout).toContain(
			"not installed",
		);
	}, 20_000);

	it("keeps installed archives and runtime files independent of the release source", async () => {
		const release = join(fixture, "temporary release");
		await cp(source, release, { recursive: true });
		await install(release);
		await rm(release, { recursive: true });
		expect(JSON.parse((await run(join(prefix, "bin", "arc"), ["--help"])).stdout)).toEqual({
			message: "archive fixture installed",
			args: ["--help"],
		});
	});

	it("finds npm without npm_execpath and supports the POSIX shell wrappers", async () => {
		const childEnvironment = { ...environment };
		delete childEnvironment.npm_execpath;
		await run("sh", [installShell, "--source", source, "--prefix", prefix, "--offline"], { env: childEnvironment });
		expect(JSON.parse((await run(join(prefix, "bin", "arc"))).stdout).message).toBe("archive fixture installed");
		const installAlias = join(fixture, "install alias.mjs");
		await symlink(installScript, installAlias);
		expect(
			(
				await run(process.execPath, [installAlias, "--source", source, "--prefix", prefix, "--offline"], {
					env: childEnvironment,
				})
			).stdout,
		).toContain("already installed");
		await run("sh", [uninstallShell, "--prefix", prefix], { env: childEnvironment });
		await expect(stat(prefix)).rejects.toMatchObject({ code: "ENOENT" });
	});

	it("refuses an existing unowned prefix for both installation and removal", async () => {
		await mkdir(prefix);
		await writeFile(join(prefix, "keep.txt"), "unrelated file");
		await expect(install()).rejects.toThrow();
		await expect(run(process.execPath, [uninstallScript, "--prefix", prefix], { env: environment })).rejects.toThrow();
		expect(await readFile(join(prefix, "keep.txt"), "utf8")).toBe("unrelated file");
	});

	it("refuses a symlink prefix and preserves its target", async () => {
		const target = join(fixture, "unrelated target");
		await mkdir(target);
		await writeFile(join(target, "keep.txt"), "unrelated file");
		await symlink(target, prefix, "dir");
		await expect(install()).rejects.toThrow(/not an owned directory/);
		await expect(run(process.execPath, [uninstallScript, "--prefix", prefix], { env: environment })).rejects.toThrow(
			/not an owned directory/,
		);
		expect(await readFile(join(target, "keep.txt"), "utf8")).toBe("unrelated file");
	});

	it("refuses a marker that does not identify an Arc-owned installation", async () => {
		await mkdir(prefix);
		await writeFile(join(prefix, "keep.txt"), "unrelated file");
		await writeFile(
			join(prefix, ".arc-install.json"),
			JSON.stringify({ owner: "different-application", prefix, version: "1.2.3", sourceHash: "0".repeat(64) }),
		);
		await expect(run(process.execPath, [uninstallScript, "--prefix", prefix], { env: environment })).rejects.toThrow(
			/without valid Arc ownership/,
		);
		expect(await readFile(join(prefix, "keep.txt"), "utf8")).toBe("unrelated file");
	});

	it("refuses to use the default application data directory as an installation prefix", async () => {
		const dataDirectory = join(homedir(), ".arc");
		await expect(
			run(process.execPath, [installScript, "--source", source, "--prefix", dataDirectory], { env: environment }),
		).rejects.toThrow(/must not contain the Arc data directory/);
		await expect(
			run(process.execPath, [uninstallScript, "--prefix", dataDirectory], { env: environment }),
		).rejects.toThrow(/must not contain the Arc data directory/);
	});

	it("rejects archive tampering before creating the prefix", async () => {
		const release = join(fixture, "corrupt release");
		await cp(source, release, { recursive: true });
		const [archive] = await readdir(join(release, "packages"));
		await writeFile(join(release, "packages", archive), "tampered archive");
		await expect(install(release)).rejects.toThrow(/checksum mismatch/);
		await expect(stat(prefix)).rejects.toMatchObject({ code: "ENOENT" });
	});

	it("rejects unsupported native release targets", async () => {
		const release = join(fixture, "unsupported release");
		await cp(source, release, { recursive: true });
		await writeFile(
			join(release, "release.json"),
			JSON.stringify({ version: "1.2.3", nativeTargets: [], terminalTargets: [] }),
		);
		await expect(install(release)).rejects.toThrow(/does not contain an environment daemon/);
		await expect(stat(prefix)).rejects.toMatchObject({ code: "ENOENT" });
	});

	it("removes only the new installation tree if npm rejects an archive", async () => {
		const release = join(fixture, "invalid package release");
		await cp(source, release, { recursive: true });
		const [archive] = await readdir(join(release, "packages"));
		const contents = "not a package archive";
		await writeFile(join(release, "packages", archive), contents);
		const sums = await readFile(join(release, "SHA256SUMS"), "utf8");
		const hash = createHash("sha256").update(contents).digest("hex");
		await writeFile(
			join(release, "SHA256SUMS"),
			sums
				.split("\n")
				.map((line) => (line.endsWith(`  packages/${archive}`) ? `${hash}  packages/${archive}` : line))
				.join("\n"),
		);
		await writeFile(join(fixture, "keep.txt"), "outside installation");
		await expect(install(release)).rejects.toThrow(/npm install failed/);
		await expect(stat(prefix)).rejects.toMatchObject({ code: "ENOENT" });
		expect(await readFile(join(fixture, "keep.txt"), "utf8")).toBe("outside installation");
	});

	it("refuses a different release in an already owned prefix", async () => {
		await install();
		const release = join(fixture, "other release");
		await cp(source, release, { recursive: true });
		const manifest = JSON.parse(await readFile(join(release, "package.json"), "utf8"));
		await writeFile(join(release, "package.json"), JSON.stringify({ ...manifest, version: "2.0.0" }));
		await writeFile(
			join(release, "release.json"),
			JSON.stringify({
				version: "2.0.0",
				nativeTargets: [`${process.platform}-${process.arch}`],
				terminalTargets: [`${process.platform}-${process.arch}`],
			}),
		);
		await expect(install(release)).rejects.toThrow(/different Arc release/);
		expect(JSON.parse((await run(join(prefix, "bin", "arc"))).stdout).message).toBe("archive fixture installed");
	});
});
