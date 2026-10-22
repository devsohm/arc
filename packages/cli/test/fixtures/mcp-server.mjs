import { createInterface } from "node:readline";
for await (const line of createInterface({ input: process.stdin, crlfDelay: Infinity })) {
	const request = JSON.parse(line);
	if (!("id" in request)) continue;
	let result;
	switch (request.method) {
		case "initialize":
			result = {
				protocolVersion: request.params.protocolVersion,
				capabilities: { tools: {} },
				serverInfo: { name: "fixture", version: "1" },
			};
			break;
		case "tools/list":
			result = {
				tools: [
					{
						name: "add",
						description: "Add two numbers",
						inputSchema: {
							type: "object",
							properties: { a: { type: "number" }, b: { type: "number" } },
							required: ["a", "b"],
						},
						outputSchema: { type: "object", properties: { sum: { type: "number" } }, required: ["sum"] },
					},
				],
			};
			break;
		case "tools/call": {
			const { a, b } = request.params.arguments;
			result = { content: [{ type: "text", text: String(a + b) }], structuredContent: { sum: a + b } };
			break;
		}
		case "ping":
			result = {};
			break;
		default:
			process.stdout.write(
				JSON.stringify({ jsonrpc: "2.0", id: request.id, error: { code: -32601, message: "Unknown method" } }) + "\n",
			);
			continue;
	}
	process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }) + "\n");
}
