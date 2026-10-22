# Arc

Arc is a terminal agent with independent TypeScript libraries for models, durable execution, terminal UI, MCP, Code Mode, environments, and telemetry.

The application is `@arc/cli`. The libraries can be used without the application. Durable owns the model and tool loop, storage, tasks, cancellation, and recovery.

## Start

For a prepared release, follow [installation](docs/install.md). To build the source checkout:

```sh
npm ci
npm run build
npm run build:daemon --workspace @arc/env
npm run build:native --workspace @arc/tui
node packages/cli/dist/cli.js
```

Use `/login` to authenticate and choose a model, `/model` to change it later, `/settings` to configure the application, and `/help` to list commands. The default data directory is `~/.arc`.

The local tools are `read`, `write`, `edit`, and `bash`. Code Mode is enabled by default and can be disabled in settings. MCP servers are configured separately. Parallel and sequential are execution settings, not tool names. Host tools run with your account's permissions.

## Interfaces

Use the interactive terminal, text output, JSON events, JSON-RPC over standard input and output, or the SDK. All use the same application runtime. See [interface contracts](docs/modes.md).

## Libraries

| Package | Purpose |
| --- | --- |
| [AI](packages/ai/README.md) | Providers, authentication, models, streaming, images, and classifiers |
| [Durable](packages/durable/README.md) | Conversations, transactions, documents, tasks, tools, and storage |
| [TUI](packages/tui/README.md) | Terminal components, editor, Markdown, math, images, and layout |
| [Code Mode](packages/codemode/README.md) | QuickJS execution with explicit host calls |
| [MCP](packages/mcp/README.md) | MCP client, transports, resources, tools, and OAuth helpers |
| [Env](packages/env/README.md) | Native local and remote environment connections |
| [Telemetry](packages/telemetry/README.md) | Spans, diagnostics, measurements, and adapters |
| [Application](packages/cli/README.md) | Commands, resources, credentials, settings, and presentation |

See [architecture](docs/architecture.md) for ownership and [package imports](docs/packages.md) for every public import path.

## Verify

```sh
npm run verify
```

The full gate builds the packages, checks TypeScript, measures owned-test coverage, runs native and worker checks, and verifies installed archives. Tests use scripted providers where possible. Live provider acceptance, other operating systems, and complete visual equivalence require separate verification.

[Arc guide](packages/cli/docs/guide.md) · [Session storage](packages/cli/docs/storage.md) · [Documentation](docs/README.md) · [Testing](docs/testing.md) · [Troubleshooting](docs/troubleshooting.md) · [Releases](docs/releases.md)
