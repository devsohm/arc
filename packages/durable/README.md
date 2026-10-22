# @arc/durable

Durable owns conversations, transactions, documents, scheduling, generation, tools, cancellation, and recovery. Extensions register domain behavior through its registry and hooks. Memory, SQLite, JSONL, and IndexedDB adapters serve different deployment needs. The CLI exposes memory, SQLite, and JSONL.

## Example

```ts
import { BACKGROUND_CONTEXT } from "@arc/durable/context";
import { createSession, MemoryStorage } from "@arc/durable";

const session = createSession(new MemoryStorage());
try {
	const conversation = await session.commit(
		tx => tx.createConversation({ ownership: { kind: "ownerless" } }),
		BACKGROUND_CONTEXT,
	);
	console.log(conversation.id);
} finally {
	await session.close(BACKGROUND_CONTEXT);
}
```

## Reference

- [Package specification](docs/spec.md)

- [Tutorial](docs/tutorial.md)
- [Extensions](docs/extensions.md)
- [Shared utilities](docs/shared.md)

[API reference](docs/api.md)

## Request identity

`Harness.open` accepts `identity`. Harness defaults identify Arc; request-level identity fields take precedence. Model factories and model access in tasks and hooks use the same defaults.
