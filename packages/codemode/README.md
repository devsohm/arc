# @arc/codemode

Code Mode executes JavaScript inside QuickJS. The application supplies callable host functions and decides which capabilities they expose. Scripts do not receive Node filesystem, network, or module access automatically. Durable can add task journaling and replay around this executor.

## Example

```ts
import { CodemodeSandbox } from "@arc/codemode";

const sandbox = new CodemodeSandbox({
	tools: [{ name: "add", execute: value => Number(value) + 1 }],
});
try {
	const result = await sandbox.execute("text('ready'); return await tools.add(4)");
	if (!result.ok) throw new Error(result.error.message);
	console.log(result.value, result.output[0]);
} finally {
	await sandbox.close();
}
```

## Reference

- [Package specification](docs/spec.md)

[API reference](docs/api.md)
