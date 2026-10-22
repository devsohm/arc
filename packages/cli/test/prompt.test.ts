import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels, fauxAssistantMessage, fauxProvider, type TranscriptContext, Type } from "@arc/ai";
import { getCurrentTools } from "@arc/ai/utils/transcript";
import { BACKGROUND_CONTEXT as context } from "@arc/durable/context";
import { CodingTools, createBashTool, createReadTool } from "@arc/durable/tools";
import { createRegistry, defineTool, Harness, MemoryStorage } from "@arc/durable";
import { expect, test } from "vitest";
import { createPromptExtension } from "../src/core/resources/prompt.ts";
import { expandPrompt, loadResources } from "../src/core/resources/resources.ts";

function capture(transcript: TranscriptContext) {
	const sections: Record<string, string> = {};
	for (const message of transcript.messages) {
		if (message.role !== "system") continue;
		for (const [key, value] of Object.entries(message.sections ?? {})) {
			if (value === null) delete sections[key];
			else sections[key] = value;
		}
	}
	const latestInput = transcript.messages.findLast((message) => message.role === "user");
	return { sections, tools: getCurrentTools(transcript.messages).map((tool) => tool.name), latestInput };
}

test("discovered resources and selected tools reach real Durable requests and update after reconfiguration", async () => {
	const directory = await mkdtemp(join(tmpdir(), "arc-prompt-"));
	const home = join(directory, "home");
	const cwd = join(directory, "work");
	await mkdir(join(home, "skills", "review"), { recursive: true });
	await mkdir(join(cwd, ".arc", "prompts"), { recursive: true });
	await writeFile(join(home, "AGENTS.md"), "Prefer the project's public API.");
	await writeFile(join(cwd, "AGENTS.md"), "Run the focused project check.");
	await writeFile(
		join(home, "skills", "review", "SKILL.md"),
		"---\nname: review\ndescription: Review a patch for regressions.\n---\nSecret body loaded only on demand.",
	);
	await writeFile(join(cwd, ".arc", "prompts", "inspect.md"), "Inspect $1 for ${2:-regressions}.");
	const resources = await loadResources({ cwd, home });
	const models = createModels();
	const provider = fauxProvider();
	models.setProvider(provider.provider);
	const requests: ReturnType<typeof capture>[] = [];
	provider.setResponses(
		Array.from({ length: 4 }, () => (transcript: TranscriptContext) => {
			requests.push(capture(transcript));
			return fauxAssistantMessage("Checked.");
		}),
	);
	const registry = createRegistry();
	registry.install(CodingTools);
	registry.install({
		name: "project-status",
		tools: [
			defineTool({
				name: "build_status",
				description: "Read the local build receipt.",
				parameters: Type.Object({}),
				execute: async () => ({ output: [{ type: "text", text: "Ready" }] }),
			}),
		],
	});
	registry.install(createPromptExtension(resources, cwd));
	const harness = await Harness.open(
		new MemoryStorage(),
		{ registry, models, settings: { compaction: { enabled: false } } },
		context,
	);
	try {
		const conversation = await harness.root(context, {
			agent: { cwd, model: { provider: provider.provider.id, modelId: provider.getModel().id } },
		});
		const template = resources.prompts.find((prompt) => prompt.name === "inspect");
		if (template === undefined) throw new Error("Prompt template was not discovered");
		const submit = async (input: string) =>
			expect((await (await conversation.submit({ type: "input", content: input }, context)).wait(context)).status).toBe(
				"done",
			);
		await submit(expandPrompt(template.content, '"src/entry.ts"'));
		const first = requests[0];
		expect(first?.tools).toEqual(["read", "write", "edit", "bash", "build_status"]);
		expect(first?.latestInput?.content).toBe("Inspect src/entry.ts for regressions.");
		expect(first?.sections["arc-docs"]).toContain("Documentation directory:");
		expect(first?.sections["arc-docs"]).toContain("extensions.md");
		const documentation = first?.sections["arc-docs"]
			?.split("\n")
			.find((line) => line.startsWith("Documentation directory: "))
			?.slice("Documentation directory: ".length);
		if (!documentation) throw new Error("Installed documentation path is missing");
		for (const file of [
			"guide.md",
			"spec.md",
			"extensions.md",
			"auth-settings.md",
			"resources.md",
			"storage.md",
			"themes.md",
			"layout.md",
		]) {
			expect(first?.sections["arc-docs"]).toContain(file);
			expect((await readFile(join(documentation, file), "utf8")).startsWith("# ")).toBe(true);
		}
		expect(first?.sections["arc-behavior"]).toContain("execution settings, not tool names");
		expect(first?.sections["arc-tools"]).toContain("build_status: Read the local build receipt.");
		expect(first?.sections["arc-behavior"]).toContain("Each edits item matches the original file");
		expect(first?.sections["arc-notes"]).toContain("Prefer the project's public API.");
		expect(first?.sections["arc-notes"]).toContain("Run the focused project check.");
		expect(first?.sections["arc-guides"]).toContain("Review a patch for regressions.");
		expect(first?.sections["arc-guides"]).toContain(join(home, "skills", "review", "SKILL.md"));
		expect(first?.sections["arc-guides"]).not.toContain("Secret body");
		expect(first?.sections["arc-location"]).toBe(`<arc-location>\n${cwd}\n</arc-location>`);
		expect(Object.values(first?.sections ?? {}).join("\n")).not.toContain("PowerShell");
		await conversation.configure({ tools: [createReadTool()] }, context);
		registry.install(
			createPromptExtension(
				{ ...resources, contextFiles: [{ path: join(cwd, "AGENTS.md"), content: "Updated project instruction." }] },
				cwd,
				{ systemPrompt: "Answer using project terminology.", appendSystemPrompt: "Include the build receipt." },
			),
		);
		await submit("Check the revised instructions.");
		const second = requests[1];
		expect(second?.tools).toEqual(["read"]);
		expect(second?.sections["arc-role"]).toBe("Answer using project terminology.");
		expect(second?.sections["arc-extra"]).toContain("Include the build receipt.");
		expect(second?.sections["arc-tools"]).toMatch(/^<arc-tools>\nread:/);
		expect(second?.sections["arc-tools"]).not.toContain("build_status");
		expect(second?.sections["arc-behavior"]).toBeUndefined();
		expect(second?.sections["arc-docs"]).toBeUndefined();
		expect(second?.sections["arc-notes"]).toContain("Updated project instruction.");
		expect(second?.sections["arc-notes"]).not.toContain("Run the focused project check.");
		await conversation.configure({ tools: [] }, context);
		await submit("Explain without tools.");
		expect(requests[2]?.tools).toEqual([]);
		expect(requests[2]?.sections["arc-tools"]).toContain("No tools are enabled for this turn.");
		expect(requests[2]?.sections["arc-guides"]).toBeUndefined();
		await conversation.configure({ tools: [createBashTool()], cwd: join(cwd, "subfolder") }, context);
		registry.install(createPromptExtension(resources, cwd));
		await submit("Read the requested skill through the shell.");
		expect(requests[3]?.tools).toEqual(["bash"]);
		expect(requests[3]?.sections["arc-guides"]).toContain("use bash to open the skill file");
		expect(requests[3]?.sections["arc-behavior"]).toContain("Use bash for ls, rg, find");
		expect(requests[3]?.sections["arc-behavior"]).not.toContain("Use edit");
		expect(requests[3]?.sections["arc-extra"]).toBeUndefined();
		expect(requests[3]?.sections["arc-location"]).toContain(join(cwd, "subfolder"));
	} finally {
		await harness.close(context);
		await rm(directory, { recursive: true, force: true });
	}
});
