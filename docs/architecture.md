# Architecture and ownership

Arc has one application package and seven libraries. The application composes the libraries. Library packages do not import the application.

| Package | Responsibility |
| --- | --- |
| `@arc/cli` | Startup, settings, credentials, resources, application extensions, commands, session selection, and terminal presentation |
| `@arc/ai` | Provider protocols, catalogs, authentication contracts, streaming responses, images, and classifiers |
| `@arc/durable` | Conversations, documents, transactions, tasks, scheduling, model and tool execution, cancellation, storage, and recovery |
| `@arc/codemode` | JavaScript execution in QuickJS and the host-call boundary |
| `@arc/mcp` | MCP client sessions, transports, tools, resources, progress, cancellation, and OAuth helpers |
| `@arc/env` | Local and remote native environment connections |
| `@arc/tui` | Terminal rendering, layout, input, editor, Markdown, math, images, overlays, and selection |
| `@arc/telemetry` | Explicit spans, measurements, diagnostic context, and telemetry adapters |

## Request flow

The CLI parses options and creates the application. The application resolves trusted resources and opens a Durable Harness. User input enters a conversation. Durable schedules generation and tool tasks. AI adapters handle provider requests. Execution environments perform permitted host operations.

The interactive application observes committed conversation views and live state. It renders messages and tool cards through the TUI library. JSON and RPC modes observe the same runtime. SDK callers use the same application methods.

There is no second application-owned generation loop or recovery journal. UI layout and presentation state belong to the application. Durable owns execution state.

## Extensions

Durable extensions define tools, tasks, documents, hooks, and prompt sections. Application extensions add commands, provider registrations, resource handling, message renderers, UI contributions, and application lifecycle callbacks.

Trusted extension files load through Node's native ESM loader and built-in TypeScript stripping. The loader manages file generations and the application manages activation cleanup. Reloading a module is not remote object routing or coordinated process replacement.

Extensions run trusted host code. A child process or a TypeScript module is not an operating-system sandbox.

## Code Mode and MCP

Code Mode and MCP are independent features. Code Mode executes JavaScript with explicit host functions. Durable records nested calls and owns replay. A script cannot obtain host access merely by importing a Node module.

MCP connects external servers and registers their tools. Those servers may execute processes or contact services with their configured permissions. Enabling Code Mode does not create an MCP server or grant additional credentials.

Parallel and sequential select how ordinary tool calls are scheduled. They are not tool names. Code Mode scripts can also compose asynchronous calls through JavaScript.

## Storage

A session uses one authoritative backend: SQLite, JSONL, or memory. SQLite is the application's default. JSONL uses the Durable backend's directory layout. Memory stores nothing after process exit.

Do not assume that SQLite and JSONL are interchangeable files or that both are live copies of every session. Transcript export is a separate application feature. It is not a complete backup of every task and extension document.

Durable includes shared invocation context, change tracking, bounded output, SQLite adapters, and an optional SQLite telemetry recorder. These utilities are importable without the CLI.

## UI boundaries

The TUI library does not provide the complete agent application. Arc supplies its editor wiring, message cards, tool renderers, navigation, menus, status, and footer. Extensions can replace supported application components.

A terminal's image, keyboard, color, clipboard, and mouse capabilities affect the experience. Unsupported image protocols use text fallback. Supported LaTeX notation renders as terminal text. The terminal is not a browser or a full TeX typesetter.
