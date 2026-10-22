import { linkifyUrls } from "../src/core/ui/text.ts";
import { expect, test } from "vitest";
import { stripTerminalSequences, visibleWidth, Text } from "@arc/tui";
import { fauxAssistantMessage } from "@arc/ai";
import { ThemeCatalog } from "../src/core/ui/theme.ts";
import { messageComponent } from "../src/modes/interactive/components.ts";
import { mermaidTransform, highlightCode } from "../src/modes/interactive/markdown.ts";

const theme = new ThemeCatalog("truecolor").resolve("dark");
const display = { toolsExpanded: false, thinkingVisible: false, theme };
test.each([
	["flowchart LR\n A[Start] --> B[Finish]", "Start", "Finish"],
	["sequenceDiagram\n Alice->>Bob: Hello", "Alice", "Bob"],
	["stateDiagram-v2\n [*] --> Ready\n Ready --> Done", "Ready", "Done"],
	["classDiagram\n Animal <|-- Dog", "Animal", "Dog"],
	["erDiagram\n USER ||--o{ ORDER : places", "USER", "ORDER"],
])("actual message cards render diagram %s", (source, first, second) => {
	const content = "```mermaid\n" + source + "\n```";
	const lines = messageComponent(fauxAssistantMessage(content), display).render(120).map(stripTerminalSequences);
	const text = lines.join("\n");
	expect(text).toContain(first);
	expect(text).toContain(second);
	expect(text).toMatch(/[─│╭┌┐▶]/);
	expect(text).not.toContain("```mermaid");
	expect(lines.every((line) => visibleWidth(line) <= 120)).toBe(true);
});
test("diagram modes preserve streaming source, narrow blocks and unsupported syntax without losing surrounding text", () => {
	const text = "Before\n\n```mermaid\nflowchart LR\n A[Start] --> B[Finish]\n```\n\nAfter";
	expect(mermaidTransform({ mode: "off" })(text, 100)).toBe(text);
	expect(mermaidTransform({ mode: "final", streaming: true })(text, 100)).toBe(text);
	expect(mermaidTransform({})(text, 2)).toBe(text);
	const rendered = mermaidTransform({ mode: "final" })(text, 100);
	expect(rendered).toContain("Before");
	expect(rendered).toContain("After");
	expect(rendered).not.toContain("```mermaid");
	const unsupported = "```mermaid\nnot-a-diagram\n```";
	expect(mermaidTransform({})(unsupported, 100)).toBe(unsupported);
	const regular = "```typescript\nconst x = 1;\n```";
	expect(mermaidTransform({})(regular, 100)).toBe(regular);
});
test("syntax highlighting preserves source characters and LaTeX renders through the message path", () => {
	const code = 'const text = "<tag> & \\"quoted\\""; // comment';
	const lines = highlightCode(code, "typescript", theme);
	expect(lines.join("\n")).toContain("\x1b[");
	expect(lines.map(stripTerminalSequences).join("\n")).toBe(code);
	expect(highlightCode("<unrecognized>&", "unknown-language", theme).map(stripTerminalSequences)).toEqual([
		"<unrecognized>&",
	]);
	const text = messageComponent(fauxAssistantMessage("Inline $x^2$ and $\\sqrt{x}$\n\n$$\\frac{a}{b}$$"), display)
		.render(80)
		.map(stripTerminalSequences)
		.join("\n");
	expect(text).toContain("x²");
	expect(text).toContain("√x");
	expect(text).toContain("a");
	expect(text).toContain("b");
	expect(text).not.toContain("\\frac");
	expect(text).not.toContain("$$");
});

test("message cards render Markdown table rows within the available terminal width", () => {
	const message = fauxAssistantMessage("| Name | Status |\n| --- | --- |\n| Durable | Ready |\n| TUI | Ready |");
	for (const width of [24, 80]) {
		const lines = messageComponent(message, display).render(width).map(stripTerminalSequences);
		const text = lines.join("\n");
		expect(text).toContain("Durable");
		expect(text).toContain("Ready");
		expect(text).toMatch(/[│|]/);
		expect(text).not.toContain("---");
		expect(lines.every((line) => visibleWidth(line) <= width)).toBe(true);
	}
});

test("wrapped login links retain the complete authorization target and reject external terminal escapes", () => {
	const url =
		"https://example.invalid/authorize?client_id=public-client&scope=openid+profile+email+offline_access&code_challenge=" +
		"a".repeat(80) +
		"&state=fixture&redirect_uri=http%3A%2F%2Flocalhost%3A1455%2Fauth%2Fcallback";
	const rendered = new Text(linkifyUrls(`Open ${url}\nEscape cancels`), 0, 0).render(38);
	const targets = rendered.flatMap((line) =>
		[...line.matchAll(/\x1b\]8;;([^\x1b\x07]+)(?:\x1b\\|\x07)/g)].map((match) => match[1]),
	);
	expect(targets.length).toBeGreaterThan(1);
	for (const target of targets) expect(target).toBe(url);
	expect(rendered.map(stripTerminalSequences).join("").replaceAll(" ", "")).toContain(url);
	expect(linkifyUrls("\x1b]0;untrusted-title\x07https://example.invalid/login")).not.toContain("untrusted-title");
	expect(linkifyUrls("javascript:alert(1)")).not.toContain("\x1b]8;");
});

test("plain display text preserves Unicode and whitespace while removing terminal instructions", async () => {
	const { plainText } = await import("../src/core/ui/text.ts");
	expect(plainText("界 👨‍👩‍👦 é\n\ttext")).toBe("界 👨‍👩‍👦 é\n\ttext");
	expect(plainText("first\r\nsecond\rthird")).toBe("first\nsecond\nthird");
	expect(plainText("\x1b[31mred\x1b[0m\x1b]0;window title\x07\0")).toBe("red");
	expect(
		highlightCode('const safe = "界";\x1b]0;bad title\x07', "typescript", theme).map(stripTerminalSequences).join("\n"),
	).toBe('const safe = "界";');
});
