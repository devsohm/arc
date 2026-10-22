import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { expect, test, vi } from "vitest";
import { showProjectTrust } from "../src/cli/project-trust.ts";
import { projectTrust, saveProjectTrust } from "../src/core/configuration/trust.ts";
import { TestTerminal } from "../../tui/test/support/terminal.ts";

test.each([
	{ down: 0, trusted: "yes", saved: true, parent: false },
	{ down: 1, trusted: "yes", saved: true, parent: true },
	{ down: 2, trusted: "yes", saved: undefined, parent: false },
	{ down: 3, trusted: "no", saved: false, parent: false },
	{ down: 4, trusted: "no", saved: undefined, parent: false },
	{ down: -1, trusted: "no", saved: undefined, parent: false },
])(
	"startup trust choice $down persists only the requested scope and clears the prompt",
	async ({ down, trusted, saved, parent }) => {
		const root = await realpath(await mkdtemp(join(tmpdir(), "arc-startup-trust-")));
		const cwd = join(root, "project");
		const home = join(root, "home");
		const terminal = new TestTerminal(100, 30);
		try {
			await mkdir(cwd);
			if (parent) await saveProjectTrust(home, cwd, false);
			const task = showProjectTrust(cwd, home, terminal);
			await vi.waitFor(async () => expect((await terminal.screen()).join("\n")).toContain("Trust project folder?"));
			expect((await terminal.screen()).join("\n")).toContain("Trust (this session only)");
			for (let i = 0; i < down; i++) terminal.input("\x1b[B");
			terminal.input(down < 0 ? "\x1b" : "\r");
			expect(await task).toEqual({ trusted, remember: false });
			expect(await projectTrust(home, cwd)).toBe(saved);
			expect(await projectTrust(home, dirname(cwd))).toBe(parent ? true : undefined);
			expect((await terminal.screen()).join("\n")).not.toContain("Trust project folder?");
		} finally {
			terminal.dispose();
			await rm(root, { recursive: true, force: true });
		}
	},
);
