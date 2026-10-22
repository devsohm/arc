import type { MutableModels, Provider } from "@arc/ai";

type Layer = { owner: object; provider: Provider };
type Layers = { base: Provider | undefined; values: Layer[] };
const collections = new WeakMap<MutableModels, Map<string, Layers>>();
export function setProviderContribution(models: MutableModels, owner: object, provider: Provider): void {
	let collection = collections.get(models);
	if (!collection) {
		collection = new Map();
		collections.set(models, collection);
	}
	let layers = collection.get(provider.id);
	const current = models.getProvider(provider.id);
	if (!layers || current !== layers.values.at(-1)?.provider) {
		layers = { base: current, values: [] };
		collection.set(provider.id, layers);
	}
	const index = layers.values.findIndex((layer) => layer.owner === owner);
	if (index < 0) layers.values.push({ owner, provider });
	else layers.values[index] = { owner, provider };
	const top = layers.values.at(-1);
	if (top) models.setProvider(top.provider);
}
export function removeProviderContribution(models: MutableModels, owner: object, id: string): void {
	const collection = collections.get(models),
		layers = collection?.get(id);
	if (!layers) return;
	const top = layers.values.at(-1)?.provider;
	layers.values = layers.values.filter((layer) => layer.owner !== owner);
	if (models.getProvider(id) === top) {
		const next = layers.values.at(-1)?.provider ?? layers.base;
		if (next) models.setProvider(next);
		else models.deleteProvider(id);
	}
	if (!layers.values.length) collection?.delete(id);
}
