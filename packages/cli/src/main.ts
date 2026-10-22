import { BUILTIN_FLAGS, parseStartupArgs } from "./cli/args.ts";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { createInterface } from "node:readline/promises";
import { once } from "node:events";
import { Writable } from "node:stream";
import type { AuthInteraction, AuthPrompt, ModelThinkingLevel } from "@arc/ai";
import { MODEL_THINKING_LEVELS } from "@arc/ai/providers/model-schema";
import { createApplication } from "./core/application.ts";
import { createApplicationModels, loginProvider, logoutProvider } from "./core/authentication/auth.ts";
import { openBrowser } from "./core/authentication/browser.ts";
import { hasProjectResources } from "./core/configuration/trust.ts";
import { showProjectTrust } from "./cli/project-trust.ts";
import type { ApplicationSettings } from "./core/configuration/settings.ts";
import { processFileArguments } from "./cli/file-processor.ts";
import { runInteractive } from "./modes/interactive/interactive-mode.ts";
import { runPrint } from "./modes/print-mode.ts";
import { runJson } from "./modes/json-mode.ts";
import { runRpc } from "./modes/rpc/rpc-mode.ts";

export const HELP = `Arc\n\nUsage: arc [options] [@file...] [prompt...]\n       arc login <provider>\n       arc logout <provider>\n\nOptions:\n  -p, --print                Print the final response\n  --mode interactive|text|json|rpc\n  --provider <id> --model <id>\n  --thinking <level>\n  --models <patterns>        Ordered comma-separated model patterns\n  --cwd <directory>\n  --home <directory>          Application data directory, defaults to ~/.arc\n  --session <path>            Open a SQLite file or .jsonl session directory\n  -c, --continue              Open the latest session for this directory\n  --backend sqlite|jsonl|memory\n  --extension <file>          Load an extension, repeatable\n  --no-extensions             Disable discovered extension files\n  --trust | --no-trust        Allow or deny project resources for this run\n  --system-prompt <text>      Replace the base system prompt\n  --append-system-prompt <text>\n  --tool-execution parallel|sequential\n  --tools read,write,edit,bash\n  --codemode                 Enable Code Mode independently of MCP\n  --fullscreen               Use the alternate terminal screen\n  --list-models              List available provider/model IDs\n  -h, --help\n  --version\n`;
async function interaction(): Promise<{ auth: AuthInteraction; close: () => void }> {
	let silent = false;
	const output = new Writable({
		write(chunk, _encoding, done) {
			if (!silent) process.stderr.write(chunk);
			done();
		},
	});
	const rl = createInterface({ input: process.stdin, output, terminal: process.stdin.isTTY });
	const ask = async (prompt: AuthPrompt): Promise<string> => {
		if (prompt.type === "select") {
			process.stderr.write(prompt.options.map((o, i) => `${i + 1}. ${o.label}`).join("\n") + "\n");
			const answer = await rl.question(`${prompt.message}: `, { signal: prompt.signal });
			const selected = prompt.options[Number(answer) - 1];
			if (!selected) throw new Error("Invalid selection");
			return selected.id;
		}
		if (prompt.type === "secret") {
			process.stderr.write(`${prompt.message}: `);
			silent = true;
			try {
				return await rl.question("", { signal: prompt.signal });
			} finally {
				silent = false;
				process.stderr.write("\n");
			}
		}
		return rl.question(`${prompt.message}${prompt.placeholder ? ` (${prompt.placeholder})` : ""}: `, {
			signal: prompt.signal,
		});
	};
	return {
		auth: {
			prompt: ask,
			notify(event) {
				switch (event.type) {
					case "auth_url":
						process.stderr.write(`${event.url}\n${event.instructions ?? ""}\n`);
						void openBrowser(event.url).then((opened) => {
							if (!opened)
								process.stderr.write("Could not open the browser. Copy the complete login URL into your browser.\n");
						});
						break;
					case "device_code":
						process.stderr.write(`${event.verificationUri}\nCode: ${event.userCode}\n`);
						break;
					case "info":
					case "progress":
						process.stderr.write(event.message + "\n");
						break;
				}
			},
		},
		close: () => rl.close(),
	};
}
async function readInput(): Promise<string> {
	let result = "";
	for await (const chunk of process.stdin) {
		result += chunk.toString();
		if (Buffer.byteLength(result) > 16 * 1024 * 1024) throw new Error("Input exceeds 16 MiB");
	}
	return result.trim();
}
export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<number> {
	const { values, positionals, hasUnknownOptions } = parseStartupArgs(argv);
	if (values.help) {
		process.stdout.write(HELP);
		return 0;
	}
	if (values.version) {
		process.stdout.write("0.1.0-rc.1\n");
		return 0;
	}
	const cwd = resolve(values.cwd ?? process.cwd()),
		home = resolve(values.home ?? process.env.ARC_HOME ?? join(homedir(), ".arc"));
	const models = createApplicationModels({ home });
	if (positionals[0] === "login" || positionals[0] === "logout") {
		const provider = positionals[1];
		if (!provider) throw new Error("Specify a provider ID");
		if (positionals[0] === "logout") {
			await logoutProvider(models, provider);
			return 0;
		}
		const ui = await interaction();
		try {
			await loginProvider(models, provider, ui.auth);
		} finally {
			ui.close();
		}
		process.stderr.write("Credentials saved\n");
		return 0;
	}
	if (values["list-models"]) {
		process.stdout.write(
			models
				.getModels(values.provider)
				.map((m) => `${m.provider}/${m.id}`)
				.join("\n") + "\n",
		);
		return 0;
	}
	let model;
	if (values.model) {
		const slash = values.model.indexOf("/");
		const provider = values.provider ?? (slash > 0 ? values.model.slice(0, slash) : undefined),
			id = values.provider ? values.model : slash > 0 ? values.model.slice(slash + 1) : values.model;
		if (!provider) throw new Error("Specify --provider with --model, or use provider/model");

		model = { provider, modelId: id };
	}
	let thinkingLevel: ModelThinkingLevel | undefined;
	if (values.thinking) {
		thinkingLevel = MODEL_THINKING_LEVELS.find((v) => v === values.thinking);
		if (!thinkingLevel) throw new Error("Unknown thinking level");
	}
	const backend = values.backend ?? "sqlite";
	if (backend !== "sqlite" && backend !== "jsonl" && backend !== "memory")
		throw new Error("Backend must be sqlite, jsonl or memory");
	const mode = values.mode ?? (values.print || !process.stdin.isTTY ? "text" : "interactive");
	if (mode !== "interactive" && mode !== "text" && mode !== "json" && mode !== "rpc")
		throw new Error(`Unknown mode: ${mode}`);
	if (mode === "rpc" && positionals.length && !hasUnknownOptions)
		throw new Error("RPC mode reads requests from stdin; positional prompts and attachments are not accepted");

	const rawOutput = process.stdout.write.bind(process.stdout);
	const originalWrite = process.stdout.write;
	if (mode !== "interactive") process.stdout.write = process.stderr.write.bind(process.stderr);
	try {
		if (values.trust && values["no-trust"]) throw new Error("Choose either --trust or --no-trust");
		const projectTrusted = values.trust ? true : values["no-trust"] ? false : undefined;
		const settings: Partial<ApplicationSettings> = {
			...(values.models === undefined
				? {}
				: {
						enabledModels: values.models
							.split(",")
							.map((pattern) => pattern.trim())
							.filter(Boolean),
					}),
			...(values.codemode === undefined ? {} : { codemode: values.codemode }),
		};

		if (
			values["tool-execution"] &&
			values["tool-execution"] !== "parallel" &&
			values["tool-execution"] !== "sequential"
		)
			throw new Error("Tool execution must be parallel or sequential");
		const toolExecution = values["tool-execution"];
		if (toolExecution === "parallel" || toolExecution === "sequential") Object.assign(settings, { toolExecution });

		const app = await createApplication({
			extensionArgs: argv,
			mode,
			projectTrusted,
			resolveProjectTrust: async () => {
				if (mode !== "interactive" || !process.stdin.isTTY || !(await hasProjectResources(cwd)))
					return { trusted: "undecided" };
				return showProjectTrust(cwd, home);
			},
			provider: values.provider,
			cwd,
			home,
			models,
			model,
			thinkingLevel,
			backend,
			sessionFile: values.session ? resolve(cwd, values.session) : undefined,
			continueSession: values.continue,
			systemPrompt: values["system-prompt"],
			appendSystemPrompt: values["append-system-prompt"],
			extensionFiles: values.extension,
			settings,
			...(values["no-extensions"]
				? {
						extensionFiles: values.extension,
						settings: {
							...settings,
							extensionFiles: [],
						},
						disableDiscoveredExtensions: true,
					}
				: {}),
			onReport: (error) => {
				process.stderr.write(`Runtime: ${error instanceof Error ? error.message : String(error)}\n`);
			},
		});
		const stopping = new AbortController();
		const interrupt = () => {
			void app.abort().catch(() => {});
		};
		process.on("SIGINT", interrupt);
		const terminate = () => {
			if (mode !== "interactive") interrupt();
			stopping.abort();
		};
		process.on("SIGTERM", terminate);
		const writeRecord = async (record: unknown) => {
			if (!rawOutput(JSON.stringify(record) + "\n")) await once(process.stdout, "drain");
		};
		try {
			const resolved = parseArgs({
				args: [...argv],
				allowPositionals: true,
				options: { ...BUILTIN_FLAGS, ...app.flags() },
			});
			if (mode === "rpc" && resolved.positionals.length)
				throw new Error("RPC mode reads requests from stdin; positional prompts and attachments are not accepted");
			if (values.tools) await app.command(`/tools ${values.tools}`);
			if (mode === "rpc") {
				await runRpc(app, process.stdin, writeRecord, stopping.signal);
				return 0;
			}
			const prompts = await processFileArguments(resolved.positionals, cwd);
			if (mode !== "interactive" && !process.stdin.isTTY) {
				const input = await readInput();
				if (input) {
					const first = prompts[0];
					if (first === undefined) prompts.push(input);
					else
						prompts[0] = typeof first === "string" ? `${input}\n\n${first}` : [{ type: "text", text: input }, ...first];
				}
			}
			if (mode === "interactive") {
				if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error("Interactive mode requires a terminal");
				for (const prompt of prompts) await app.run(prompt);
				await runInteractive(app, { signal: stopping.signal, fullscreen: values.fullscreen ?? settings.fullscreen });
				return 0;
			}
			if (!prompts.length) throw new Error("Provide a prompt or pipe input");
			return mode === "json"
				? await runJson(app, prompts, writeRecord)
				: await runPrint(app, prompts, (text) => {
						rawOutput(text);
					});
		} finally {
			process.off("SIGINT", interrupt);
			process.off("SIGTERM", terminate);
			await app.close({ preserveWork: mode === "interactive" });
		}
	} finally {
		process.stdout.write = originalWrite;
	}
}
