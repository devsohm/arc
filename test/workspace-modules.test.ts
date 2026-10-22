import { test, expect } from "vitest";
import { createModels as publicFactory } from "@arc/ai";
import { createModels as sourceFactory } from "../packages/ai/src/models.ts";
test("workspace imports use source modules", () => {
	expect(publicFactory().getProviders()).toEqual([]);
	expect(publicFactory).toBe(sourceFactory);
});
