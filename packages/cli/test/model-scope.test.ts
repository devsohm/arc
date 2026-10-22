import { createModels, fauxProvider } from "@arc/ai";
import { expect, test } from "vitest";
import { resolveModelScope } from "../src/core/providers/model-scope.ts";

const catalog = createModels();
catalog.setProvider(
	fauxProvider({
		provider: "one",
		models: [
			{ id: "alpha", name: "Alpha" },
			{ id: "beta-20261001" },
			{ id: "beta-latest" },
			{ id: "bracket[1m]" },
			{ id: "literal:high" },
		],
	}).provider,
);
catalog.setProvider(fauxProvider({ provider: "two", models: [{ id: "alpha" }] }).provider);

function select(patterns: string[]) {
	const result = resolveModelScope(patterns, catalog.getModels());
	return {
		...result,
		models: result.models.map(({ model, thinkingLevel }) => ({ id: `${model.provider}/${model.id}`, thinkingLevel })),
	};
}

test("model scopes expand case-insensitive globs in order and retain the first thinking override", () => {
	expect(select(["ONE/B*:high", "*alpha*:low", "one/*:off"]).models).toEqual([
		{ id: "one/beta-20261001", thinkingLevel: "high" },
		{ id: "one/beta-latest", thinkingLevel: "high" },
		{ id: "one/bracket[1m]", thinkingLevel: "high" },
		{ id: "one/alpha", thinkingLevel: "low" },
		{ id: "two/alpha", thinkingLevel: "low" },
		{ id: "one/literal:high", thinkingLevel: "off" },
	]);
});

test("literal punctuation beats pattern syntax, while fuzzy aliases and shared IDs resolve predictably", () => {
	expect(select(["one/bracket[1m]", "one/literal:high", "beta:medium"]).models).toEqual([
		{ id: "one/bracket[1m]", thinkingLevel: undefined },
		{ id: "one/literal:high", thinkingLevel: undefined },
		{ id: "one/beta-latest", thinkingLevel: "medium" },
	]);
	expect(select(["alpha"]).models.map((model) => model.id)).toEqual(["one/alpha", "two/alpha"]);
	expect(select(["alpha"]).warnings).toHaveLength(1);
	expect(select(["one/alpha"]).warnings).toEqual([]);
});

test("invalid suffixes warn without inventing a thinking level and unmatched patterns remain visible", () => {
	expect(select(["one/alpha:low:high"]).models).toEqual([{ id: "one/alpha", thinkingLevel: "high" }]);
	const result = select(["one/alpha:invalid:high", "absent/*"]);
	expect(result.models).toEqual([{ id: "one/alpha", thinkingLevel: undefined }]);
	expect(result.warnings).toHaveLength(1);
	expect(result.unmatched).toEqual(["absent/*"]);
});
