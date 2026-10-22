# Arc guide

Arc connects a terminal application to independent libraries. Durable runs the model and tools. The application supplies commands, settings, credentials, project resources and presentation.

## Start and authenticate

Run `arc`, then `/login`. After authentication, choose a model in the picker. Escape keeps the current selection; `/model` changes it later. `/help` lists current commands, including commands added by extensions. `/settings` changes runtime and display options. Application data lives in `~/.arc` unless you set `--home`.

Provider support and login methods come from AI. The application excludes Mistral and uses legacy Codex OAuth. Some providers use API keys or environment credentials instead of OAuth. See [authentication and settings](auth-settings.md).

## Choose an interface

| Interface | Start |
| --- | --- |
| Terminal | `arc` |
| Final text | `arc --print "Explain this project"` |
| JSON events | `arc --mode json "Explain this project"` |
| JSON-RPC over standard input/output | `arc --mode rpc` |
| SDK | `createApplication()` from `@arc/cli` |

All interfaces use the same application and Durable runtime. JSON events and RPC have different contracts. JSON mode does not accept slash commands; RPC has a `command` method. `--fullscreen` changes the terminal screen, not the runtime.

## Work with tools

The local tools are `read`, `write`, `edit` and `bash`. `/tools` lists or selects active tools. Parallel and sequential are scheduling choices in `/settings`, not additional model tools.

Code Mode executes JavaScript through explicit host functions and Durable's nested tool calls. MCP connects configured external servers and exposes their tools. These are separate features. Configuring one does not configure the other. `/mcp` manages configured servers; its HTTP login action opens browser OAuth. `/mcp logout <name>` removes saved MCP OAuth credentials.

The terminal shows streaming messages, thinking and live tool progress. Ctrl+T toggles thinking, and Ctrl+O toggles expanded tool output. `/hotkeys` lists active bindings; personal overrides live in `~/.arc/keybindings.json`. In fullscreen mode, expanding thinking or tools keeps the current viewport position. Scrolling to the end or submitting input resumes following new output. In scrollback mode, the terminal controls its native scrollback position.

Markdown includes syntax-highlighted code, tables, Mermaid and supported math notation. Terminal capability affects images, keyboard input and clipboard support. This is not a browser or a full TeX typesetter. See [themes and Markdown](themes.md).

## Save, inspect and navigate

SQLite is the default backend. Active runtime state uses memory. `MemoryStorage` is available for temporary sessions; it is not a separate persistent memory service. JSONL is available for sessions you want to inspect as text. See [session storage](storage.md) for commands, file layouts and backup limits.

To reopen the latest session at startup, use `arc --continue`. During a run, use `/resume` to choose a saved session, `/new` to start another, `/fork` to branch, and `/tree` to navigate history. `/clone` copies a complete file-backed session. `/name` labels a session.

`/compact` summarizes older model context. `/tasks` shows durable task state. `/abort` cancels current work. Automatic compaction is configurable in `/settings`.

`/export` creates HTML or an Arc JSON transcript. `/import` loads that transcript into another conversation. `/share` uploads through an authenticated GitHub CLI only when invoked. See [application contracts](spec.md) for exact behavior and failure handling.

## Load project resources

Personal instructions use `~/.arc/AGENTS.md`. Ancestor and working-directory `AGENTS.md` files also load. Skills, prompt templates, extensions and themes use their documented personal or trusted project resource directories.

Project trust controls project settings and discovered project skills, prompts, extensions and themes. Instructions are read separately. `/trust` saves a decision for a later startup; it does not unload code already executing. See [resource discovery](resources.md).

## Extend the application

An application extension builds on Durable's tools, task hooks, wrappers and prompt sections. It can also register application commands, flags, shortcuts, providers, virtual models, message/tool renderers and supported UI components.

Trusted ESM extension files compile through esbuild. `/reload` reloads resources and extension generations. Activation owns cleanup. Stale extension contexts cannot keep registering features after unload. Extensions have host permissions; module loading is not an operating-system sandbox. See [extension APIs](extensions.md).

## Use the libraries independently

AI owns provider requests and authentication. Durable owns sessions, tasks, documents, tools and recovery. TUI owns terminal components. MCP owns client sessions and transports. Code Mode owns isolated JavaScript execution. Env owns native local/remote connections. Telemetry owns instrumentation.

The CLI composes these libraries. Libraries do not import the CLI. Detailed package specifications and the complete import list are in the toolkit's documentation. Public TypeScript declarations define exact signatures.

## Verify a build

Run `npm run verify` from the source root. It builds, checks types, runs owned tests and coverage, exercises Rust/native/worker components, and tests installed archives. Provider credentials and other operating systems need separate acceptance checks. A passing test run does not prove the absence of every defect.
