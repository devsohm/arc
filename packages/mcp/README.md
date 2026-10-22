# @arc/mcp

MCP connects external servers, discovers tools and resources, sends requests, and handles progress, cancellation, notifications, and authentication. The application decides which capabilities reach a model. This package has no Code Mode dependency and does not configure servers automatically.

## Example

```ts
import { McpClient, LATEST_PROTOCOL_VERSION } from "@arc/mcp";
import { createInMemoryTransportPair } from "@arc/mcp/testing";

const pair = createInMemoryTransportPair();
pair.server.onMessage(message => {
	if (!("id" in message) || !("method" in message)) return;
	const result = message.method === "initialize"
		? { protocolVersion: LATEST_PROTOCOL_VERSION, capabilities: { tools: {} }, serverInfo: { name: "example", version: "1" } }
		: { tools: [{ name: "read", inputSchema: { type: "object" } }] };
	void pair.server.send({ jsonrpc: "2.0", id: message.id, result });
});
await pair.server.start();
const client = new McpClient({ name: "example-client", version: "1" });
try {
	await client.connect(pair.client);
	console.log((await client.listTools()).map(tool => tool.name).join(","));
} finally {
	await client.close();
}
```

## Reference

- [Package specification](docs/spec.md)

[API reference](docs/api.md)
