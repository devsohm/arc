import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels, fauxProvider } from "@arc/ai";
import { afterEach, expect, test } from "vitest";
import { hasProjectResources, projectTrust, saveProjectTrust } from "../src/core/configuration/trust.ts";
import { createApplication } from "../src/core/application.ts";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
async function fixture() {
	const root = await realpath(await mkdtemp(join(tmpdir(), "arc-trust-")));
	cleanups.push(() => rm(root, { recursive: true, force: true }));
	const home = join(root, "home"),
		cwd = join(root, "project"),
		child = join(cwd, "child");
	await mkdir(child, { recursive: true });
	return { root, home, cwd, child };
}

test("trust uses the nearest canonical path and atomically preserves decisions", async () => {
	const f = await fixture();
	expect(await projectTrust(f.home, f.child)).toBeUndefined();
	await saveProjectTrust(f.home, f.cwd, true);
	expect(await projectTrust(f.home, f.child)).toBe(true);
	await saveProjectTrust(f.home, f.child, false);
	expect(await projectTrust(f.home, f.child)).toBe(false);
	expect(await projectTrust(f.home, f.cwd)).toBe(true);
	await saveProjectTrust(f.home, f.child, true, true);
	expect(await projectTrust(f.home, f.child)).toBe(true);
	const other = join(f.root, "other");
	await mkdir(other);
	await Promise.all([saveProjectTrust(f.home, f.cwd, true), saveProjectTrust(f.home, other, false)]);
	expect(await projectTrust(f.home, other)).toBe(false);
	expect(await projectTrust(f.home, f.cwd)).toBe(true);
});

test.skipIf(process.platform === "win32")("trust decisions apply to symlink aliases", async () => {
	const f = await fixture();
	const alias = join(f.root, "alias");
	await symlink(f.cwd, alias);
	await saveProjectTrust(f.home, alias, true);
	expect(await projectTrust(f.home, f.cwd)).toBe(true);
});

test("malformed trust data fails before loading project code", async () => {
	const f = await fixture();
	await mkdir(f.home);
	await writeFile(join(f.home, "trust.json"), '{"/project":"yes"}');
	await expect(projectTrust(f.home, f.cwd)).rejects.toThrow("Invalid project trust store");
});

test("untrusted startup excludes project settings and executable extensions until a saved decision is applied", async () => {
	const f = await fixture();
	await mkdir(join(f.cwd, ".arc", "extensions"), { recursive: true });
	await writeFile(join(f.cwd, ".arc", "settings.json"), JSON.stringify({ toolExecution: "sequential" }));
	await writeFile(
		join(f.cwd, ".arc", "extensions", "project.ts"),
		'export default {name:"project",commands:[{name:"project-action",description:"Project action",execute(){return {message:"project action"};}}]};',
	);
	const models = createModels();
	models.setProvider(fauxProvider().provider);
	const options = {
		cwd: f.cwd,
		home: f.home,
		models,
		backend: "memory" as const,
		model: { provider: "faux", modelId: "faux-1" },
	};
	expect(await hasProjectResources(f.cwd)).toBe(true);
	expect(await hasProjectResources(f.child)).toBe(false);
	const app = await createApplication(options);
	try {
		expect(app.commands().map((command) => command.name)).not.toContain("project-action");
		expect(JSON.parse((await app.command("/settings")).message ?? "{}").toolExecution).toBe("parallel");
		await app.command("/trust yes");
		await app.reload();
		expect(app.commands().map((command) => command.name)).not.toContain("project-action");
	} finally {
		await app.close();
	}
	const next = await createApplication(options);
	try {
		expect(await next.command("/project-action")).toEqual({ message: "project action" });
		expect(JSON.parse((await next.command("/settings")).message ?? "{}").toolExecution).toBe("sequential");
		await next.command("/trust no");
	} finally {
		await next.close();
	}
	const denied = await createApplication(options);
	try {
		expect(denied.commands().map((command) => command.name)).not.toContain("project-action");
	} finally {
		await denied.close();
	}
	expect(JSON.parse(await readFile(join(f.home, "trust.json"), "utf8"))[f.cwd]).toBe(false);
});

async function policyFixture() {
	const f = await fixture();
	await mkdir(join(f.home, "extensions"), { recursive: true });
	await mkdir(join(f.cwd, ".arc", "extensions"), { recursive: true });
	const marker = join(f.root, "loaded.log");
	await writeFile(
		join(f.home, "extensions", "global.ts"),
		`import {appendFileSync} from "node:fs"; appendFileSync(${JSON.stringify(marker)},"global\\n"); export default {name:"global"};`,
	);
	await writeFile(
		join(f.cwd, ".arc", "extensions", "project.ts"),
		`import {appendFileSync} from "node:fs"; appendFileSync(${JSON.stringify(marker)},"project\\n"); export default {name:"project",commands:[{name:"project-action",description:"Project action",execute(){return {message:"loaded"};}}]};`,
	);
	await writeFile(join(f.cwd, ".arc", "settings.json"), JSON.stringify({ toolExecution: "sequential" }));
	const models = createModels();
	models.setProvider(fauxProvider().provider);
	return {
		...f,
		marker,
		options: {
			cwd: f.cwd,
			home: f.home,
			models,
			backend: "memory" as const,
			model: { provider: "faux", modelId: "faux-1" },
		},
	};
}

test("trusted bootstrap policies run before project code and retain global module ownership", async () => {
	const f = await policyFixture();
	const app = await createApplication({
		...f.options,
		extensions: [
			{
				name: "policy",
				async onProjectTrust(context) {
					expect(context.cwd).toBe(f.cwd);
					expect(context.hasUI).toBe(false);
					expect(await readFile(f.marker, "utf8")).toBe("global\n");
					return { trusted: "yes", remember: true };
				},
			},
		],
		resolveProjectTrust() {
			throw new Error("Fallback must not run");
		},
	});
	try {
		expect(await readFile(f.marker, "utf8")).toBe("global\nproject\n");
		expect((await app.command("/project-action")).message).toBe("loaded");
		expect(JSON.parse((await app.command("/settings")).message ?? "{}").toolExecution).toBe("sequential");
		expect(await projectTrust(f.home, f.cwd)).toBe(true);
	} finally {
		await app.close();
	}
});

test("undecided and failed policies fall through without executing untrusted project code", async () => {
	const f = await policyFixture();
	const reports: unknown[] = [];
	let fallbacks = 0;
	const app = await createApplication({
		...f.options,
		onReport: (error) => reports.push(error),
		extensions: [
			{
				name: "broken",
				onProjectTrust() {
					throw new Error("policy failed");
				},
			},
			{
				name: "undecided",
				onProjectTrust() {
					return { trusted: "undecided" };
				},
			},
		],
		resolveProjectTrust() {
			fallbacks++;
			return { trusted: "no", remember: true };
		},
	});
	try {
		expect(fallbacks).toBe(1);
		expect(reports).toHaveLength(1);
		expect(await readFile(f.marker, "utf8")).toBe("global\n");
		expect(app.commands().some((command) => command.name === "project-action")).toBe(false);
		expect(await projectTrust(f.home, f.cwd)).toBe(false);
	} finally {
		await app.close();
	}
});

test("saved and explicit trust decisions bypass policies and command-line settings retain precedence", async () => {
	const f = await policyFixture();
	await saveProjectTrust(f.home, f.cwd, true);
	const policy = {
		name: "unused",
		onProjectTrust() {
			throw new Error("Stored decisions must skip policies");
		},
	};
	const reports: unknown[] = [];
	const saved = await createApplication({
		...f.options,
		extensions: [policy],
		onReport: (error) => reports.push(error),
		settings: { toolExecution: "parallel" },
		resolveProjectTrust() {
			throw new Error("Unused fallback");
		},
	});
	try {
		expect((await saved.command("/project-action")).message).toBe("loaded");
		expect(JSON.parse((await saved.command("/settings")).message ?? "{}").toolExecution).toBe("parallel");
		expect(reports).toEqual([]);
	} finally {
		await saved.close();
	}
	const denied = await createApplication({
		...f.options,
		projectTrusted: false,
		extensions: [policy],
		onReport: (error) => reports.push(error),
		resolveProjectTrust() {
			throw new Error("Unused fallback");
		},
	});
	try {
		expect(denied.commands().some((command) => command.name === "project-action")).toBe(false);
		expect(reports).toEqual([]);
	} finally {
		await denied.close();
	}
});
