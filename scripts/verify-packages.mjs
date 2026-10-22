import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
	copyFileSync,
	existsSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const directory = path.resolve(process.argv[2] ?? "");
const manifest = JSON.parse(readFileSync(path.join(directory, "package.json"), "utf8"));
const npm = process.env.npm_execpath;
if (!npm) throw new Error("Run this script with npm run verify:packages.");
const consumer = mkdtempSync(path.join(tmpdir(), "arc-packages-"));
function run(args, cwd) {
	const result = spawnSync(process.execPath, args, { cwd, stdio: "inherit" });
	if (result.error) throw result.error;
	if (result.status !== 0) throw new Error(`Verification failed with exit code ${result.status}.`);
}
try {
	for (const line of readFileSync(path.join(directory, "SHA256SUMS"), "utf8").trim().split("\n")) {
		const [expected, filename] = line.split("  ");
		assert.equal(
			createHash("sha256")
				.update(readFileSync(path.join(directory, filename)))
				.digest("hex"),
			expected,
			filename,
		);
	}
	const dependencies = Object.fromEntries(
		Object.entries(manifest.dependencies).map(([name, file]) => [
			name,
			"file:" + path.resolve(directory, file.slice(5)),
		]),
	);
	const nodeTypes = JSON.parse(readFileSync(path.join(root, "package.json"))).devDependencies["@types/node"];
	writeFileSync(
		path.join(consumer, "package.json"),
		JSON.stringify({ private: true, type: "module", dependencies, devDependencies: { "@types/node": nodeTypes } }),
	);
	run([npm, "install", "--ignore-scripts", "--no-audit", "--no-fund"], consumer);
	for (const workspace of JSON.parse(readFileSync(path.join(root, "package.json"))).workspaces) {
		const pkg = JSON.parse(readFileSync(path.join(root, workspace, "package.json")));
		const installed = path.join(consumer, "node_modules", pkg.name);
		assert.ok(realpathSync(installed).startsWith(realpathSync(consumer) + path.sep));
		const entrypoints = JSON.parse(readFileSync(path.join(installed, "package.json")));
		assert.deepEqual(entrypoints.exports, pkg.exports, `${pkg.name}: package exports changed`);
		for (const field of ["main", "types"]) {
			assert.equal(typeof entrypoints[field], "string", `${pkg.name}: missing ${field} entrypoint`);
			assert.ok(existsSync(path.resolve(installed, entrypoints[field])), `${pkg.name}: missing ${field} file`);
		}
		for (const file of readdirSync(path.join(root, workspace, "dist"), { recursive: true })) {
			if (/\.(?:js|d\.ts|json|map)$/.test(file))
				assert.deepEqual(
					readFileSync(path.join(installed, "dist", file)),
					readFileSync(path.join(root, workspace, "dist", file)),
					`${pkg.name}/${file}`,
				);
		}
		if (pkg.files.includes("native")) {
			for (const file of readdirSync(path.join(root, workspace, "native"), { recursive: true })) {
				if (/\.(?:c|m|h|mjs|md|node)$/.test(file))
					assert.deepEqual(
						readFileSync(path.join(installed, "native", file)),
						readFileSync(path.join(root, workspace, "native", file)),
						`${pkg.name}/native/${file}`,
					);
			}
		}
		if (pkg.files.includes("docs")) {
			for (const file of readdirSync(path.join(root, workspace, "docs"), { recursive: true })) {
				if (file.endsWith(".md"))
					assert.deepEqual(
						readFileSync(path.join(installed, "docs", file)),
						readFileSync(path.join(root, workspace, "docs", file)),
						`${pkg.name}/docs/${file}`,
					);
			}
		}
		for (const file of readdirSync(installed, { recursive: true })) {
			if (!file.endsWith(".md") || (file !== "README.md" && !["docs", "examples"].includes(file.split(path.sep)[0])))
				continue;
			const markdown = readFileSync(path.join(installed, file), "utf8");
			for (const [, target] of markdown.matchAll(/\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) {
				if (target.startsWith("#") || /^[a-z][a-z\d+.-]*:/i.test(target)) continue;
				const destination = path.resolve(installed, path.dirname(file), target.split("#")[0]);
				assert.ok(existsSync(destination), `${pkg.name}/${file}: missing linked file ${target}`);
			}
		}
	}
	copyFileSync(path.join(root, "scripts/package-smoke.mjs"), path.join(consumer, "smoke.mjs"));
	run([path.join(consumer, "smoke.mjs")], consumer);
	const appCli = path.join(consumer, "node_modules/@arc/cli/dist/cli.js");
	const appHelp = spawnSync(process.execPath, [appCli, "--help"], { cwd: consumer, encoding: "utf8" });
	assert.equal(appHelp.status, 0, appHelp.stderr);
	assert.match(appHelp.stdout, /Usage: arc/);
	const appVersion = spawnSync(process.execPath, [appCli, "--version"], { cwd: consumer, encoding: "utf8" });
	assert.equal(appVersion.status, 0, appVersion.stderr);
	assert.equal(appVersion.stdout.trim(), manifest.version);
	const cliFixture = path.join(consumer, "provider.mjs");
	writeFileSync(
		cliFixture,
		`import {fauxProvider,fauxAssistantMessage,fauxToolCall} from '@arc/ai';
console.log('Extension diagnostic');
const f=fauxProvider();f.setResponses([fauxAssistantMessage([fauxToolCall('write',{path:'cli-saved.txt',content:'saved by the installed CLI'},{id:'write'})],{stopReason:'toolUse'}),fauxAssistantMessage('Installed CLI answer')]);
export default {name:'installed-provider',providers:[f.provider],flags:{profile:{type:'string',default:'default'},trace:{type:'boolean',default:false}},commands:[{name:'inspect-flags',description:'Inspect flags',execute(_args,_app,context){return {message:JSON.stringify([context.getFlag('profile'),context.getFlag('trace')])};}}]};
`,
	);
	const commonArgs = [
		appCli,
		"--home",
		path.join(consumer, "arc-home"),
		"--cwd",
		consumer,
		"--backend",
		"memory",
		"--no-extensions",
		"--extension",
		cliFixture,
		"--provider",
		"faux",
		"--model",
		"faux-1",
	];
	for (const mode of ["text", "json", "rpc"]) {
		const result = spawnSync(
			process.execPath,
			[...commonArgs, "--mode", mode, ...(mode === "rpc" ? [] : ["write a file"])],
			{
				cwd: consumer,
				encoding: "utf8",
				input:
					mode === "rpc"
						? JSON.stringify({ jsonrpc: "2.0", id: 1, method: "prompt", params: { message: "write a file" } }) + "\n"
						: "",
				timeout: 15000,
			},
		);
		assert.equal(result.status, 0, result.stderr);
		assert.match(result.stderr, /Extension diagnostic/);
		assert.doesNotMatch(result.stdout, /Extension diagnostic/);
		if (mode === "text") assert.equal(result.stdout, "Installed CLI answer\n");
		else {
			const records = result.stdout
				.trim()
				.split("\n")
				.map((line) => JSON.parse(line));
			assert.ok(
				records.some((record) =>
					mode === "json"
						? record.type === "result" && record.text === "Installed CLI answer"
						: record.id === 1 && record.result?.text === "Installed CLI answer",
				),
			);
		}
		assert.equal(readFileSync(path.join(consumer, "cli-saved.txt"), "utf8"), "saved by the installed CLI");
	}

	const image = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==";
	writeFileSync(path.join(consumer, "image.png"), Buffer.from(image, "base64"));
	writeFileSync(path.join(consumer, "notes.md"), "Read these notes");
	const visionFixture = path.join(consumer, "vision.mjs");
	writeFileSync(
		visionFixture,
		`import {fauxProvider,fauxAssistantMessage} from '@arc/ai';
const f=fauxProvider({models:[{id:'vision',input:['text','image']}]});
f.setResponses([(ctx)=>{const user=ctx.messages.find(m=>m.role==='user');if(!Array.isArray(user?.content)||!user.content.some(b=>b.type==='image'&&b.data===${JSON.stringify(image)})||!user.content.some(b=>b.type==='text'&&b.text.includes('Read these notes'))||!user.content.some(b=>b.type==='text'&&b.text.includes('Piped context')))throw new Error('Attachments did not reach provider');return fauxAssistantMessage('Attachments received');}]);
export default {name:'vision',providers:[f.provider]};`,
	);
	const attached = spawnSync(
		process.execPath,
		[
			appCli,
			"--home",
			path.join(consumer, "vision-home"),
			"--cwd",
			consumer,
			"--backend",
			"memory",
			"--no-extensions",
			"--extension",
			visionFixture,
			"--model",
			"faux/vision",
			"--print",
			"@notes.md",
			"@image.png",
			"Describe",
			"both",
		],
		{ cwd: consumer, encoding: "utf8", input: "Piped context", timeout: 15000 },
	);
	assert.equal(attached.status, 0, attached.stderr);
	assert.equal(attached.stdout, "Attachments received\n");

	const flagResult = spawnSync(
		process.execPath,
		[...commonArgs, "--mode", "text", "--profile", "fast", "--trace", "/inspect-flags"],
		{ cwd: consumer, encoding: "utf8", input: "", timeout: 15000 },
	);
	assert.equal(flagResult.status, 0, flagResult.stderr);
	assert.equal(flagResult.stdout, '["fast",true]\n');
	const invalidRpc = spawnSync(process.execPath, [...commonArgs, "--mode", "rpc", "@notes.md"], {
		cwd: consumer,
		encoding: "utf8",
		input: "",
		timeout: 15000,
	});
	assert.notEqual(invalidRpc.status, 0);
	assert.match(invalidRpc.stderr, /RPC mode reads requests from stdin/);
	assert.doesNotMatch(invalidRpc.stderr, /Extension diagnostic/);

	for (const name of ["install.mjs", "uninstall.mjs", "install.sh", "uninstall.sh"])
		assert.ok(existsSync(path.join(directory, "scripts", name)), `Missing installer ${name}`);
	const durableDocs = path.join(consumer, "node_modules/@arc/durable/docs");
	assert.ok(readFileSync(path.join(durableDocs, "shared.md"), "utf8").length > 0);
	const tutorial = readFileSync(path.join(durableDocs, "shared.md"), "utf8");
	const examples = [...tutorial.matchAll(/```ts\n([\s\S]*?)\n```/g)];
	assert.ok(examples.length > 0);
	writeFileSync(path.join(consumer, "tutorial.ts"), examples.map((example) => example[1]).join("\n\n"));
	const extensionDoc = readFileSync(path.join(consumer, "node_modules/@arc/cli/docs/extensions.md"), "utf8");
	const extensionExamples = [...extensionDoc.matchAll(/```ts\n([\s\S]*?)\n```/g)];
	assert.ok(extensionExamples.length > 0);
	writeFileSync(
		path.join(consumer, "extension-example.ts"),
		extensionExamples.map((example) => example[1]).join("\n\n"),
	);
	run([path.join(consumer, "tutorial.ts")], consumer);
	const cli = spawnSync(process.execPath, [path.join(consumer, "node_modules/@arc/ai/dist/cli.js"), "--help"], {
		cwd: consumer,
		encoding: "utf8",
	});
	assert.equal(cli.status, 0, cli.stderr);
	assert.match(cli.stdout, /Usage: arc-ai/);
	assert.match(cli.stdout, /openai-codex/);
	assert.equal(existsSync(path.join(consumer, "auth.json")), false);
	writeFileSync(
		path.join(consumer, "types.ts"),
		`
import * as ai from "@arc/ai";
import * as shared from "@arc/durable/context";
import * as codemode from "@arc/codemode";
import * as durable from "@arc/durable";
import * as extensions from "@arc/durable/extensions/node";
import * as env from "@arc/env";
import * as mcp from "@arc/mcp";
import * as telemetry from "@arc/telemetry";
import * as tui from "@arc/tui";
import * as application from "@arc/cli";
import type { SummaryRequest, BlockedReason } from "@arc/durable";
export const packages = [ai, shared, codemode, durable, extensions, env, mcp, telemetry, tui, application];
export const reasons = ["missing_task", "task_too_old", "migration_failed", "restart_limit"] satisfies BlockedReason[];
export const summaryModel = (request: SummaryRequest) => request.model.modelId;
`,
	);
	run(
		[
			path.join(path.dirname(fileURLToPath(import.meta.resolve("typescript/package.json"))), "bin/tsc"),
			"--noEmit",
			"--strict",
			"--skipLibCheck",
			"false",
			"--module",
			"NodeNext",
			"--target",
			"ES2024",
			"--types",
			"node",
			"types.ts",
			"tutorial.ts",
			"extension-example.ts",
		],
		consumer,
	);
	run([npm, "uninstall", ...Object.keys(dependencies), "--no-audit", "--no-fund"], consumer);
	for (const name of Object.keys(dependencies))
		assert.equal(existsSync(path.join(consumer, "node_modules", name)), false, name);
} finally {
	rmSync(consumer, { recursive: true, force: true });
}
