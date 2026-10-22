import { defineExtension, section, type Extension, type PromptInput } from "@arc/durable";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import type { Resources } from "./resources.ts";

export interface PromptOptions {
	readonly systemPrompt?: string;
	readonly appendSystemPrompt?: string;
}

function workGuidance(input: PromptInput): string {
	const tools = new Set(input.agent.tools.map((tool) => tool.name));
	const guidance = [
		"Follow the user's request and the applicable project instructions. Keep changes focused on the task.",
		"Call tools by their declared names and follow their argument schemas. Parallel and sequential are execution settings, not tool names.",
	];
	if (tools.has("read"))
		guidance.push(
			"Inspect relevant files with read before changing them. Continue truncated reads with offset and limit.",
		);
	if (tools.has("edit"))
		guidance.push(
			"Use edit for focused replacements. Each edits item matches the original file, so combine replacements that overlap.",
		);
	if (tools.has("write")) guidance.push("Use write to create a file or replace its entire contents.");
	if (tools.has("bash"))
		guidance.push(
			"Use bash for ls, rg, find, and the project's checks. Set a timeout when a command needs a time limit.",
		);
	guidance.push(
		"Verify the resulting behavior. In your answer, describe the change, the checks you ran, and any unresolved issue. Be concise.",
	);
	return guidance.join("\n");
}

export function createPromptExtension(resources: Resources, cwd: string, options: PromptOptions = {}): Extension {
	return defineExtension({
		name: "arc-prompt",
		sections: [
			section(
				"arc-role",
				() =>
					options.systemPrompt ?? "You are Arc, a coding assistant working with the user on their software project.",
				{ tag: false },
			),
			section("arc-tools", ({ agent }) =>
				agent.tools.length
					? agent.tools.map((tool) => `${tool.name}: ${tool.description}`).join("\n\n")
					: "No tools are enabled for this turn.",
			),
			section("arc-behavior", (input) => (options.systemPrompt === undefined ? workGuidance(input) : undefined)),
			section("arc-docs", () =>
				options.systemPrompt === undefined
					? [
							"When asked about Arc itself, read the installed documentation before changing its configuration or writing extensions.",
							`Package guide: ${fileURLToPath(new URL("../../../README.md", import.meta.url))}`,
							`Documentation directory: ${fileURLToPath(new URL("../../../docs", import.meta.url))}`,
							"Start with guide.md for product usage, spec.md for commands and modes, extensions.md for extension APIs, auth-settings.md for login and settings, resources.md for skills and prompts, storage.md for session backends and record layouts, themes.md for Markdown and appearance, and layout.md for source ownership. Resolve these paths under the documentation directory, not the user's project.",
						].join("\n")
					: undefined,
			),
			section("arc-extra", () => options.appendSystemPrompt || undefined),
			section("arc-notes", () =>
				resources.contextFiles.length
					? resources.contextFiles
							.map((file) => `Instructions in ${JSON.stringify(file.path)}:\n${file.content}`)
							.join("\n\n")
					: undefined,
			),
			section("arc-guides", ({ agent }) => {
				const reader = agent.tools.some((tool) => tool.name === "read")
					? "read"
					: agent.tools.some((tool) => tool.name === "bash")
						? "bash"
						: undefined;
				if (reader === undefined || resources.skills.length === 0) return undefined;
				return [
					`For a matching task, use ${reader} to open the skill file before applying it. Resolve supporting files relative to that skill's directory.`,
					...resources.skills.map(
						(skill) =>
							`${JSON.stringify(skill.name)}: ${JSON.stringify(skill.description)}\nFile: ${JSON.stringify(skill.path)}`,
					),
				].join("\n\n");
			}),
			section("arc-location", ({ agent }) => resolve(agent.cwd ?? cwd)),
		],
	});
}
