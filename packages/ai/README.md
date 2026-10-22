# @arc/ai

AI owns provider requests, streaming, catalogs, authentication contracts, image operations, and classifiers. Applications own credential storage and decide which providers to register. Catalog presence does not guarantee account access.

## Example

```ts
import { contentText, createModels, fauxAssistantMessage, fauxProvider } from "@arc/ai";

const scripted = fauxProvider();
scripted.setResponses([fauxAssistantMessage("Ready.")]);
const models = createModels();
models.setProvider(scripted.provider);

const response = await models.completeSimple(scripted.getModel(), {
	messages: [{ role: "user", content: "Hello", timestamp: Date.now() }],
});
console.log(contentText(response.content));
```

## Reference

- [Package specification](docs/spec.md)

[API reference](docs/api.md)

## Client identity

`createModels({ identity })` sets request identity defaults. `withClientIdentity(models, identity)` wraps an existing collection. Individual requests can override fields. `userAgent` accepts `"short"`, `"detailed"`, or `{ custom: "my-app/1" }`. `attribution: null` removes attribution; model and request headers retain precedence.
