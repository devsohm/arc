import {
	createModels,
	type AuthInteraction,
	type AuthOperationOptions,
	type AuthType,
	type Credential,
	type CredentialInfo,
	type CredentialStore,
	type Models,
	type MutableModels,
} from "@arc/ai";
import { builtinProviders } from "@arc/ai/providers/all";
import { join, resolve } from "node:path";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { readJsonFile, withFileUpdate } from "../configuration/file-storage.ts";

const credentialSchema = Type.Union([
	Type.Object(
		{
			type: Type.Literal("api_key"),
			key: Type.Optional(Type.String()),
			env: Type.Optional(Type.Record(Type.String(), Type.String())),
		},
		{ additionalProperties: false },
	),
	Type.Object(
		{
			type: Type.Literal("oauth"),
			refresh: Type.String(),
			access: Type.String(),
			expires: Type.Number(),
		},
		{ additionalProperties: true },
	),
]);
const credentialsSchema = Type.Record(Type.String(), credentialSchema);

async function readCredentials(path: string, signal?: AbortSignal): Promise<Map<string, Credential>> {
	const data = await readJsonFile(path, signal);
	if (data === undefined) return new Map();
	if (!Value.Check(credentialsSchema, data)) throw new Error("Invalid auth.json credential data");
	return new Map(Object.entries(data));
}

export class FileCredentialStore implements CredentialStore {
	readonly #path: string;

	constructor(authPath: string) {
		this.#path = resolve(authPath);
	}

	async read(providerId: string, options?: AuthOperationOptions): Promise<Credential | undefined> {
		return (await readCredentials(this.#path, options?.signal)).get(providerId);
	}

	async list(options?: AuthOperationOptions): Promise<readonly CredentialInfo[]> {
		return [...(await readCredentials(this.#path, options?.signal))].map(([providerId, credential]) => ({
			providerId,
			type: credential.type,
		}));
	}

	async modify(
		providerId: string,
		fn: (current: Credential | undefined) => Promise<Credential | undefined>,
		options?: AuthOperationOptions,
	): Promise<Credential | undefined> {
		return withFileUpdate(
			this.#path,
			async () => {
				const credentials = await readCredentials(this.#path, options?.signal);
				const current = credentials.get(providerId);
				const next = await fn(current === undefined ? undefined : structuredClone(current));
				if (next === undefined) return { result: current };
				if (!Value.Check(credentialSchema, next)) throw new Error("Invalid auth.json credential data");
				credentials.set(providerId, next);
				return { result: next, data: Object.fromEntries(credentials) };
			},
			options?.signal,
		);
	}

	async delete(providerId: string, options?: AuthOperationOptions): Promise<void> {
		await withFileUpdate(
			this.#path,
			async () => {
				const credentials = await readCredentials(this.#path, options?.signal);
				if (!credentials.delete(providerId)) return { result: undefined };
				return { result: undefined, data: Object.fromEntries(credentials) };
			},
			options?.signal,
		);
	}
}

export function createApplicationModels({ home }: { home: string }): MutableModels {
	const models = createModels({ credentials: new FileCredentialStore(join(home, "auth.json")) });
	for (const provider of builtinProviders()) {
		if (provider.id !== "mistral") models.setProvider(provider);
	}
	return models;
}

export async function loginProvider(models: Models, providerId: string, interaction: AuthInteraction): Promise<void> {
	const provider = models.getProvider(providerId);
	if (!provider) throw new Error("Unknown login provider");
	const options: { id: AuthType; label: string }[] = [];
	if (provider.auth.apiKey?.login) options.push({ id: "api_key", label: provider.auth.apiKey.name });
	if (provider.auth.oauth)
		options.push({ id: "oauth", label: provider.auth.oauth.loginLabel ?? provider.auth.oauth.name });
	const first = options[0];
	if (!first) throw new Error("This provider uses ambient credentials and does not support login");
	const type =
		options.length === 1
			? first.id
			: await interaction.prompt({ type: "select", message: "Choose a login method", options });
	if (type !== "api_key" && type !== "oauth") throw new Error("Invalid login method selection");
	await models.login(providerId, type, interaction, { agentName: "arc" });
}

export async function logoutProvider(models: Models, providerId: string): Promise<void> {
	await models.logout(providerId);
}
