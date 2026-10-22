import { expect, test } from "vitest";
import { createRpcUI } from "../src/modes/rpc/ui.ts";

test("RPC dialog responses validate their type and selection before consuming the request", async () => {
	const requests: { requestId: string }[] = [];
	const bridge = createRpcUI(async (record) => {
		if (record && typeof record === "object" && "params" in record) {
			const params = record.params;
			if (params && typeof params === "object" && "requestId" in params && typeof params.requestId === "string")
				requests.push({ requestId: params.requestId });
		}
	});
	try {
		const selected = bridge.ui.select("Choose", [{ value: "valid", label: "Valid" }]);
		const requestId = requests[0]?.requestId;
		if (!requestId) throw new Error("Dialog request missing");
		expect(() => bridge.respond({ requestId, value: "absent" })).toThrow("Unknown UI selection");
		expect(() => bridge.respond({ requestId, value: true })).toThrow("must be a string");
		expect(bridge.respond({ requestId, value: "valid" })).toBe(true);
		await expect(selected).resolves.toBe("valid");
		expect(bridge.respond({ requestId, value: "valid" })).toBe(false);
	} finally {
		bridge.close();
	}
});

test("RPC cancellation and timeout settle requests and ignore late replies", async () => {
	const requests: string[] = [];
	const bridge = createRpcUI(async (record) => {
		if (record && typeof record === "object" && "params" in record) {
			const params = record.params;
			if (params && typeof params === "object" && "requestId" in params && typeof params.requestId === "string")
				requests.push(params.requestId);
		}
	});
	try {
		const controller = new AbortController();
		const cancelled = bridge.ui.input("Abort", "", { signal: controller.signal });
		controller.abort();
		await expect(cancelled).resolves.toBeUndefined();
		expect(bridge.respond({ requestId: requests[0], value: "late" })).toBe(false);
		await expect(bridge.ui.confirm("Expire", "Continue?", { timeout: 1 })).resolves.toBe(false);
		expect(bridge.respond({ requestId: requests[1], value: true })).toBe(false);
		await expect(bridge.ui.input("Already cancelled", "", { signal: controller.signal })).resolves.toBeUndefined();
		expect(requests).toHaveLength(2);
		bridge.close();
		await expect(bridge.ui.input("Closed")).resolves.toBeUndefined();
	} finally {
		bridge.close();
	}
});
