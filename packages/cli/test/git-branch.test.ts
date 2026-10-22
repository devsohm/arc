import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { GitBranch } from "../src/core/ui/git-branch.ts";

test("tracks ordinary and worktree HEAD changes and stops notifying after close", async () => {
	const directory = await mkdtemp(join(tmpdir(), "arc-branch-"));
	const cwd = join(directory, "repo");
	const worktree = join(directory, "worktree");
	const git = (...args: string[]) => execFileSync("git", args, { cwd, stdio: "pipe" });
	execFileSync("git", ["init", "-b", "initial", cwd], { stdio: "pipe" });
	git("-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "--allow-empty", "-m", "seed");
	git("worktree", "add", "-b", "work", worktree);
	const branch = await GitBranch.open(cwd);
	const other = await GitBranch.open(worktree);
	const observed: (string | null)[] = [];
	branch.subscribe(() => observed.push(branch.value));
	try {
		expect(branch.value).toBe("initial");
		expect(other.value).toBe("work");
		git("switch", "-c", "next");
		await expect.poll(() => branch.value).toBe("next");
		git("checkout", "--detach");
		await expect.poll(() => branch.value).toBe("detached");
		expect(other.value).toBe("work");
		branch.close();
		git("switch", "initial");
		await branch.refresh();
		expect(observed).toEqual(["next", "detached"]);
	} finally {
		branch.close();
		other.close();
		await rm(directory, { recursive: true, force: true });
	}
});
