# Application source layout

`@arc/cli` connects the independent libraries to the command line and terminal. Start with `src/main.ts` for startup or `src/core/application.ts` for application behavior.

| Path | Responsibility |
| --- | --- |
| `src/cli.ts` | Executable entry point |
| `src/main.ts` | Startup, mode selection and application shutdown |
| `src/sdk.ts` | Public application exports |
| `src/cli/` | Argument parsing, input files and startup trust UI |
| `src/core/application.ts` | Runtime ownership, commands and extension coordination |
| `src/core/types.ts` | Public application and extension contracts |
| `src/core/input.ts` | Input normalization |
| `src/core/authentication/` | Credential storage, login interaction and browser launch |
| `src/core/configuration/` | Settings, trust, keybindings and application file updates |
| `src/core/resources/` | Resource discovery and system-prompt sections |
| `src/core/providers/` | Provider registrations, callbacks, model routing, scope and cache warming |
| `src/core/sessions/` | Saved sessions, navigation, summaries, transcript export and custom entries |
| `src/core/tools/` | User-initiated shell execution |
| `src/core/ui/` | UI contracts, themes, Git footer data and tool renderer contracts |
| `src/extensions/` | Application extension registry and MCP integration |
| `src/modes/interactive/` | Terminal editor, message cards, selectors, Markdown and rendering |
| `src/modes/json-mode.ts` | JSON event output |
| `src/modes/print-mode.ts` | Final text output |
| `src/modes/rpc/` | RPC requests and remote UI interactions |
| `test/` | Application behavior tests, grouped by test filename |
| `docs/` | User guides and application contracts |

The public imports remain `@arc/cli` and `@arc/cli/interactive`. Internal source paths are not public APIs. Import public contracts from the package root when writing an extension.

Durable owns session commits, scheduling, tool tasks and recovery. TUI owns reusable terminal components. AI owns provider protocols and authentication flows. Application modules compose those capabilities; they do not introduce another execution loop or storage writer.
