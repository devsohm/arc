import type { Api, Model, ModelThinkingLevel } from "@arc/ai";
import { minimatch } from "minimatch";

export interface ScopedModel {
	readonly model: Model<Api>;
	readonly thinkingLevel?: ModelThinkingLevel;
}

function thinkingSuffix(text: string): { text: string; level: ModelThinkingLevel } | undefined {
	const colon = text.lastIndexOf(":");
	if (colon < 0) return undefined;
	const level = text.slice(colon + 1);
	if (
		level === "off" ||
		level === "minimal" ||
		level === "low" ||
		level === "medium" ||
		level === "high" ||
		level === "xhigh" ||
		level === "max"
	)
		return { text: text.slice(0, colon), level };
	return undefined;
}

function match(text: string, models: readonly Model<Api>[], allowFuzzy: boolean): Model<Api>[] {
	const key = text.toLowerCase();
	const raw = models.filter((model) => model.id.toLowerCase() === key);
	const slash = key.indexOf("/");
	if (slash > 0) {
		const provider = key.slice(0, slash).trim();
		const rest = key.slice(slash + 1).trim();
		const pool = models.filter((model) => model.provider.toLowerCase() === provider);
		const named =
			pool.find((model) => model.id.toLowerCase() === rest) ??
			raw.find((model) => model.provider.toLowerCase() === provider) ??
			(allowFuzzy ? fuzzy(rest, pool)[0] : undefined);
		if (named) return [named];
	}
	return raw.length || !allowFuzzy ? raw : fuzzy(key, models);
}

function fuzzy(text: string, models: readonly Model<Api>[]): Model<Api>[] {
	const query = text.toLowerCase();
	const matches = models.filter(
		(model) => model.id.toLowerCase().includes(query) || model.name?.toLowerCase().includes(query),
	);
	const aliases = matches.filter((model) => model.id.endsWith("-latest") || !/-\d{8}$/.test(model.id));
	const best = [...(aliases.length ? aliases : matches)].sort((a, b) => b.id.localeCompare(a.id))[0];
	return best ? matches.filter((model) => model.id === best.id) : [];
}

export function resolveModelScope(
	patterns: readonly string[],
	models: readonly Model<Api>[],
): {
	models: ScopedModel[];
	warnings: string[];
	unmatched: string[];
} {
	const selected: ScopedModel[] = [];
	const seen = new Set<string>();
	const warnings: string[] = [];
	const unmatched: string[] = [];
	for (const pattern of patterns) {
		const glob = /[*?[]/.test(pattern);
		let text = glob ? pattern : pattern.trim();
		let level: ModelThinkingLevel | undefined;
		let invalid = false;
		let matches = match(text, models, !glob);
		while (!matches.length) {
			const suffix = thinkingSuffix(text);
			if (suffix) {
				text = suffix.text;
				if (!invalid) level ??= suffix.level;
			} else if (!glob && text.includes(":")) {
				warnings.push(`Invalid thinking level in ${pattern}; using the model default`);
				text = text.slice(0, text.lastIndexOf(":"));
				level = undefined;
				invalid = true;
			} else break;
			matches = match(text, models, !glob);
			if (glob) break;
		}
		if (!matches.length && glob)
			matches = models.filter(
				(model) =>
					minimatch(`${model.provider}/${model.id}`, text, { nocase: true }) ||
					minimatch(model.id, text, { nocase: true }),
			);
		if (!matches.length) unmatched.push(pattern);
		if (!glob && new Set(matches.map((model) => model.provider)).size > 1)
			warnings.push(`Multiple providers match ${pattern}; use provider/model to select one`);
		for (const model of matches) {
			const key = `${model.provider}/${model.id}`;
			if (seen.has(key)) continue;
			seen.add(key);
			selected.push({ model, thinkingLevel: level });
		}
	}
	return { models: selected, warnings, unmatched };
}
