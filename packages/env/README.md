# @arc/env

Env connects applications to a native daemon for local and SSH file operations, commands, watches, and terminals. It uses the Durable execution-environment contract. A connection is not an operating-system sandbox. Build native binaries from source or install a release containing your target.

## Example

```ts
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Connection, localDaemon, RemoteExecutionEnv } from "@arc/env";
import { BACKGROUND_CONTEXT } from "@arc/durable/context";

const cwd = await mkdtemp(join(tmpdir(), "arc-env-example-"));
await writeFile(join(cwd, "sample.txt"), "ready");
const connection = new Connection({ command: [localDaemon()] });
const env = new RemoteExecutionEnv({ connection, id: "local", cwd });
try {
  const result = await env.readTextFile("sample.txt", BACKGROUND_CONTEXT);
  if (!result.ok) throw result.error;
  console.log(result.value);
} finally {
  try {
    await env.cleanup(BACKGROUND_CONTEXT);
  } finally {
    connection.close();
    await rm(cwd, { recursive: true, force: true });
  }
}
```

## Reference

- [Package specification](docs/spec.md)

- [Environment semantics](docs/semantics.md)
- [Daemon protocol](docs/protocol.md)

[API reference](docs/api.md)
