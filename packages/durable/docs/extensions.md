# Load extension files

The Node adapter loads trusted JavaScript or TypeScript modules into an existing Durable registry. It uses esbuild to compile TypeScript. It does not type-check modules. Use your project's TypeScript check before loading them.

Relative imports follow the extension file. Installed dependencies resolve through Node. If an extension outside the application directory cannot resolve an `@arc/*` package, the loader resolves it from the host. Shared package imports, including `@arc/ai/models`, keep the host module instance. CommonJS extension modules are not supported.

An extension file default-exports the same `Extension` object accepted by `registry.install`:

```ts
import { defineExtension, section } from "@arc/durable";

export default defineExtension({
	name: "project",
	sections: [section("project", () => "Run the project's checks before finishing.")],
});
```

Pass one registry to the loader and the Harness:

```ts
import { createModels } from "@arc/ai";
import { createRegistry, Harness } from "@arc/durable";
import { ExtensionLoader } from "@arc/durable/extensions/node";
import { BACKGROUND_CONTEXT } from "@arc/durable/context";
import { openNodeSqliteStorage } from "@arc/durable/storage/sqlite/node";

const registry = createRegistry();
const loader = new ExtensionLoader(registry);
const project = await loader.load("./extension.ts");
const harness = await Harness.open(
	await openNodeSqliteStorage("./session.sqlite"),
	{ registry, models: createModels() },
	BACKGROUND_CONTEXT,
);
try {
	const conversation = await harness.root(BACKGROUND_CONTEXT);
	await conversation.configure({ extensions: [project] }, BACKGROUND_CONTEXT);
	// Submit input through the conversation when a model is configured.
	await loader.load("./extension.ts");
} finally {
	await harness.close(BACKGROUND_CONTEXT);
	await loader.close();
}
```

Pass extension and tool definitions to conversation configuration. Durable persists their names. Loading alone does not enable every tool in every conversation. Extension tasks become available to Durable's scheduler through the registry.

## Reload behavior

Calling `load` again creates a fresh module generation. Relative ESM imports receive the same generation. Bare package imports retain Node's normal cache and resolution. This preserves shared package identities. File URLs remain based on the original location, so relative assets still work.

Use `.ts`, `.mts`, `.tsx`, `.mjs`, or `.js` in an ESM package. CommonJS extension modules and relative CommonJS dependencies are unsupported. Third-party packages may still use CommonJS through ordinary bare imports. Changes inside a bare package require a process restart.

Import or registry-validation failures leave the previous definition installed. Registry listeners run after publication. If a listener throws, `load` rejects but the new definition remains published. The loader records ownership so it can still remove that definition later.

Reload preserves the extension name and its position in the registry. The loader refuses to replace a name registered manually or by another file. Conversely, unloading cannot remove a definition that another owner has already replaced.

Running task phases retain the registry snapshot captured by Durable. Later phases and later tasks use the current registry. Existing task version and migration rules still apply. Reload does not migrate documents, reset sessions, restart tasks or replace the scheduler.

`unload(filename)` removes an owned registration and returns whether one was present. It does not cancel running work. `close()` waits for admitted loader operations, removes owned registrations and rejects future loads. Close the Harness before closing the loader when shutting down the application.

Node retains imported ESM generations in its module cache. The loader cannot release that cache. Restart the process after many development reloads. Keep modules declarative; do not start unmanaged timers, connections or background work at module scope. Acquire and release resources inside their owning task or application lifecycle. Loading code grants it the process's privileges.

File discovery, filesystem watching and an interactive application are separate concerns. This adapter loads a file only when the application calls it.

## Inspect prompt sections

The package exports `renderSections` and `replaySections` for hosts that need to inspect effective prompts. These are the same helpers used by generation. A host can pass the current agent sections, environment, document reader, and previously shown sections to `renderSections`. The result contains rendered section text in application order. Rendering does not submit input or start generation.

## Plan physical model requests

The generation task's `beforeModel(request, api, context)` hook can return a physical model reference and thinking level before context budgeting. The selected agent configuration remains unchanged. The request includes messages, attempt, reason and an optional failed assistant response. Hook failures end the model request before dispatch.

A returned `commit(tx)` callback can save associated documents in the same transaction as the request choice. The choice is memoized for that input boundary and attempt, including recovery and repeated preparation after threshold compaction. A retry or overflow recovery can select again.

Task runtimes also accept `memo(name, candidate, context, commit?)`. The optional callback runs only when installing the winning candidate, within its transaction. A callback failure rolls back both the memo and its document writes. Existing memos return their stored value without rerunning the callback. Keep the callback limited to transaction operations.
