# Package import paths

Generated from workspace package manifests. Run `node scripts/document-packages.mjs` to update this page. Run the same command with `--check` to detect stale output.

Each import has a source entry and compiled TypeScript declarations. The declarations define exact signatures. The package specification describes behavior and ownership.

## @arc/telemetry

[README](../packages/telemetry/README.md) · [Specification](../packages/telemetry/docs/spec.md)

| Import | Source | Types |
| --- | --- | --- |
| `@arc/telemetry` | [`./src/index.ts`](../packages/telemetry/src/index.ts) | `./dist/index.d.ts` |
| `@arc/telemetry/render` | [`./src/render.ts`](../packages/telemetry/src/render.ts) | `./dist/render.d.ts` |
| `@arc/telemetry/testing` | [`./src/testing/index.ts`](../packages/telemetry/src/testing/index.ts) | `./dist/testing/index.d.ts` |

## @arc/ai

[README](../packages/ai/README.md) · [Specification](../packages/ai/docs/spec.md)

| Import | Source | Types |
| --- | --- | --- |
| `@arc/ai` | [`./src/index.ts`](../packages/ai/src/index.ts) | `./dist/index.d.ts` |
| `@arc/ai/models` | [`./src/models.ts`](../packages/ai/src/models.ts) | `./dist/models.d.ts` |
| `@arc/ai/compat` | [`./src/compat.ts`](../packages/ai/src/compat.ts) | `./dist/compat.d.ts` |
| `@arc/ai/providers/*` | [`./src/providers/*.ts`](../packages/ai/src/providers) | `./dist/providers/*.d.ts` |
| `@arc/ai/api/*` | [`./src/api/*.ts`](../packages/ai/src/api) | `./dist/api/*.d.ts` |
| `@arc/ai/utils/*` | [`./src/utils/*.ts`](../packages/ai/src/utils) | `./dist/utils/*.d.ts` |
| `@arc/ai/oauth` | [`./src/oauth.ts`](../packages/ai/src/oauth.ts) | `./dist/oauth.d.ts` |
| `@arc/ai/bedrock-provider` | [`./src/bedrock-provider.ts`](../packages/ai/src/bedrock-provider.ts) | `./dist/bedrock-provider.d.ts` |

Blocked imports: `@arc/ai/api/anthropic-client`, `@arc/ai/api/anthropic-request`, `@arc/ai/api/anthropic-sse`, `@arc/ai/api/bedrock-client`, `@arc/ai/api/bedrock-request`, `@arc/ai/api/bedrock-stream`, `@arc/ai/api/google-request`, `@arc/ai/api/google-stream`, `@arc/ai/api/mistral-http`, `@arc/ai/api/mistral-request`, `@arc/ai/api/mistral-stream`, `@arc/ai/api/openai-codex-protocol`, `@arc/ai/api/openai-codex-websocket`, `@arc/ai/api/openai-completions-compat`, `@arc/ai/api/openai-completions-messages`, `@arc/ai/api/openai-completions-request`, `@arc/ai/api/options`, `@arc/ai/api/responses-request`, `@arc/ai/providers/builtin`. These override wildcard exports.

## @arc/codemode

[README](../packages/codemode/README.md) · [Specification](../packages/codemode/docs/spec.md)

| Import | Source | Types |
| --- | --- | --- |
| `@arc/codemode` | [`./src/index.ts`](../packages/codemode/src/index.ts) | `./dist/index.d.ts` |
| `@arc/codemode/source` | [`./src/source.ts`](../packages/codemode/src/source.ts) | `./dist/source.d.ts` |
| `@arc/codemode/declarations` | [`./src/declarations.ts`](../packages/codemode/src/declarations.ts) | `./dist/declarations.d.ts` |
| `@arc/codemode/portable` | [`./src/portable.ts`](../packages/codemode/src/portable.ts) | `./dist/portable.d.ts` |
| `@arc/codemode/cloudflare` | [`./src/cloudflare.ts`](../packages/codemode/src/cloudflare.ts) | `./dist/cloudflare.d.ts` |
| `@arc/codemode/worker` | [`./src/runtime/worker.ts`](../packages/codemode/src/runtime/worker.ts) | `./dist/runtime/worker.d.ts` |

## @arc/mcp

[README](../packages/mcp/README.md) · [Specification](../packages/mcp/docs/spec.md)

| Import | Source | Types |
| --- | --- | --- |
| `@arc/mcp` | [`./src/index.ts`](../packages/mcp/src/index.ts) | `./dist/index.d.ts` |
| `@arc/mcp/oauth` | [`./src/oauth/index.ts`](../packages/mcp/src/oauth/index.ts) | `./dist/oauth/index.d.ts` |
| `@arc/mcp/testing` | [`./src/testing/index.ts`](../packages/mcp/src/testing/index.ts) | `./dist/testing/index.d.ts` |

## @arc/durable

[README](../packages/durable/README.md) · [Specification](../packages/durable/docs/spec.md)

| Import | Source | Types |
| --- | --- | --- |
| `@arc/durable/tool-search` | [`./src/tool-search/index.ts`](../packages/durable/src/tool-search/index.ts) | `./dist/tool-search/index.d.ts` |
| `@arc/durable/package.json` | [`./package.json`](../packages/durable/package.json) | Not applicable |
| `@arc/durable/storage/memory` | [`./src/storage/memory.ts`](../packages/durable/src/storage/memory.ts) | `./dist/storage/memory.d.ts` |
| `@arc/durable/env` | [`./src/env/index.ts`](../packages/durable/src/env/index.ts) | `./dist/env/index.d.ts` |
| `@arc/durable/env/node` | [`./src/env/node.ts`](../packages/durable/src/env/node.ts) | `./dist/env/node.d.ts` |
| `@arc/durable` | [`./src/index.ts`](../packages/durable/src/index.ts) | `./dist/index.d.ts` |
| `@arc/durable/storage/sqlite` | [`./src/storage/sqlite/index.ts`](../packages/durable/src/storage/sqlite/index.ts) | `./dist/storage/sqlite/index.d.ts` |
| `@arc/durable/storage/sqlite/node` | [`./src/storage/sqlite/node.ts`](../packages/durable/src/storage/sqlite/node.ts) | `./dist/storage/sqlite/node.d.ts` |
| `@arc/durable/storage/sqlite/cloudflare` | [`./src/storage/sqlite/cloudflare.ts`](../packages/durable/src/storage/sqlite/cloudflare.ts) | `./dist/storage/sqlite/cloudflare.d.ts` |
| `@arc/durable/storage/jsonl` | [`./src/storage/jsonl/index.ts`](../packages/durable/src/storage/jsonl/index.ts) | `./dist/storage/jsonl/index.d.ts` |
| `@arc/durable/storage/jsonl/node` | [`./src/storage/jsonl/node.ts`](../packages/durable/src/storage/jsonl/node.ts) | `./dist/storage/jsonl/node.d.ts` |
| `@arc/durable/tools` | [`./src/tools/index.ts`](../packages/durable/src/tools/index.ts) | `./dist/tools/index.d.ts` |
| `@arc/durable/images` | [`./src/images/index.ts`](../packages/durable/src/images/index.ts) | `./dist/images/index.d.ts` |
| `@arc/durable/images/node` | [`./src/images/node.ts`](../packages/durable/src/images/node.ts) | `./dist/images/node.d.ts` |
| `@arc/durable/images/cloudflare` | [`./src/images/cloudflare.ts`](../packages/durable/src/images/cloudflare.ts) | `./dist/images/cloudflare.d.ts` |
| `@arc/durable/codemode` | [`./src/codemode/index.ts`](../packages/durable/src/codemode/index.ts) | `./dist/codemode/index.d.ts` |
| `@arc/durable/testing` | [`./src/testing/index.ts`](../packages/durable/src/testing/index.ts) | `./dist/testing/index.d.ts` |
| `@arc/durable/context` | [`./src/shared/context/index.ts`](../packages/durable/src/shared/context/index.ts) | `./dist/shared/context/index.d.ts` |
| `@arc/durable/delta` | [`./src/shared/state/delta/index.ts`](../packages/durable/src/shared/state/delta/index.ts) | `./dist/shared/state/delta/index.d.ts` |
| `@arc/durable/output` | [`./src/shared/output.ts`](../packages/durable/src/shared/output.ts) | `./dist/shared/output.d.ts` |
| `@arc/durable/sqlite` | [`./src/shared/sqlite/index.ts`](../packages/durable/src/shared/sqlite/index.ts) | `./dist/shared/sqlite/index.d.ts` |
| `@arc/durable/sqlite/node` | [`./src/shared/sqlite/node.ts`](../packages/durable/src/shared/sqlite/node.ts) | `./dist/shared/sqlite/node.d.ts` |
| `@arc/durable/sqlite/cloudflare` | [`./src/shared/sqlite/cloudflare.ts`](../packages/durable/src/shared/sqlite/cloudflare.ts) | `./dist/shared/sqlite/cloudflare.d.ts` |
| `@arc/durable/telemetry-sqlite` | [`./src/shared/telemetry-sqlite/index.ts`](../packages/durable/src/shared/telemetry-sqlite/index.ts) | `./dist/shared/telemetry-sqlite/index.d.ts` |
| `@arc/durable/extensions/node` | [`./src/extensions/node.ts`](../packages/durable/src/extensions/node.ts) | `./dist/extensions/node.d.ts` |
| `@arc/durable/storage/indexeddb` | [`./src/storage/indexeddb.ts`](../packages/durable/src/storage/indexeddb.ts) | `./dist/storage/indexeddb.d.ts` |

## @arc/env

[README](../packages/env/README.md) · [Specification](../packages/env/docs/spec.md)

| Import | Source | Types |
| --- | --- | --- |
| `@arc/env` | [`./src/index.ts`](../packages/env/src/index.ts) | `./dist/index.d.ts` |

## @arc/tui

[README](../packages/tui/README.md) · [Specification](../packages/tui/docs/spec.md)

| Import | Source | Types |
| --- | --- | --- |
| `@arc/tui` | [`./src/index.ts`](../packages/tui/src/index.ts) | `./dist/index.d.ts` |

## @arc/cli

[README](../packages/cli/README.md) · [Specification](../packages/cli/docs/spec.md)

| Import | Source | Types |
| --- | --- | --- |
| `@arc/cli` | [`./src/sdk.ts`](../packages/cli/src/sdk.ts) | `./dist/sdk.d.ts` |
| `@arc/cli/interactive` | [`./src/modes/interactive/interactive-mode.ts`](../packages/cli/src/modes/interactive/interactive-mode.ts) | `./dist/modes/interactive/interactive-mode.d.ts` |
