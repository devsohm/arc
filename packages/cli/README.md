# @arc/cli

The Arc terminal application and SDK. This package connects the independent AI, Durable, TUI, MCP, Code Mode, environment, and telemetry libraries.

## Run

From a built source checkout:

```sh
node packages/cli/dist/cli.js --help
node packages/cli/dist/cli.js
```

For an installed release, run `arc`. Use `/login` to authenticate and choose a model. Cancelling the model picker keeps the current selection. Use `/model` to change it, and `/help` to list commands. Host tools use your account's permissions.

## Interfaces

Arc supports an interactive terminal, final text output, JSON runtime events, JSON-RPC over standard input and output, and the SDK. All use the same application and Durable runtime. See [application contracts](docs/spec.md).

The local tools are `read`, `write`, `edit`, and `bash`. Code Mode is enabled by default. MCP servers are configured independently. Tool execution can be parallel or sequential. These modes are scheduler choices, not additional tools.

## Settings and data

The default data directory is `~/.arc`. It contains credentials, global settings, keybindings, saved trust decisions, and sessions. Project `.arc` settings and executable extensions require trust. Explicit SDK resources and explicit extension files are caller-authorized.

SQLite is the default session backend. `--backend jsonl` selects Durable's JSONL backend. `--backend memory` does not persist sessions. Each session has one authoritative backend.

The interactive `/settings` menu changes supported runtime and presentation controls. An active model request must finish before Code Mode can change. Automatic compaction can be enabled or disabled. `/mcp` reports server connections and tool counts.

## SDK

Import `createApplication` from `@arc/cli`. Call `run`, `submit`, `command`, or `executeBash`. Read state through `snapshot()` or `subscribe()`. Close the application in a `finally` block. The application owns its Harness and storage lifetime. Injected model collections remain caller-owned.

Use isolated `home`, `resources`, and `settings` options when embedding Arc without ambient configuration. The exported TypeScript declarations define every option and method.

## Reference

- [Application contracts](docs/spec.md)
- [Authentication, settings, and keybindings](docs/auth-settings.md)
- [Extension APIs and lifecycle](docs/extensions.md)
- [Resources](docs/resources.md)
- [Themes](docs/themes.md)
- [Installation](docs/installation.md)

Local tests and terminal walkthroughs cover selected behaviors. They do not establish complete compatibility with another application, live acceptance for every provider, or native acceptance on every target.

[Arc guide](docs/guide.md) · [Session storage](docs/storage.md)

[API reference](docs/api.md)

[Source layout](docs/layout.md) describes application module ownership.
