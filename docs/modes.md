# Interfaces

All interfaces use the same application and Durable runtime. They expose different input and output contracts.

| Interface | Entry | Output |
| --- | --- | --- |
| Interactive | `arc` in a terminal, or `--mode interactive` | Terminal editor, messages, live tools, dialogs, and menus |
| Text | `--print` or `--mode text` | Final answers and command output |
| JSON | `--mode json` | Initial runtime snapshot, runtime events, and result records as JSON lines |
| RPC | `--mode rpc` | JSON-RPC 2.0 responses and notifications over standard input and output |
| SDK | `createApplication()` from `@arc/cli` | Typed application methods, snapshots, subscriptions, and results |

`--fullscreen` selects the alternate terminal screen. Without it, interactive mode uses terminal scrollback. Piped input selects text mode by default.

## Interactive input

Enter submits input. Shift+Enter inserts a newline when the terminal supports that key sequence. `/help` lists commands and `/hotkeys` shows active keybindings. User bindings load from `~/.arc/keybindings.json`.

`!command` runs a shell command and includes its result in model context. `!!command` records the shell result without adding it to model context. These commands run through the configured execution environment.

`/settings` opens the keyboard menu. Tool execution offers parallel or sequential scheduling. Automatic compaction can be enabled or disabled. Code Mode can change while the application is idle. MCP is configured separately.

## Text and JSON

```sh
arc --print "Describe this directory"
arc --mode json "Describe this directory"
```

Text mode accepts application commands. JSON mode accepts conversation input and rejects slash commands. Use RPC when a headless client needs commands and interactive responses.

## RPC

Each request occupies one line. A request needs `jsonrpc: "2.0"`, a string or numeric `id`, a `method`, and optional object `params`. IDs must be unique among active requests.

```json
{"jsonrpc":"2.0","id":1,"method":"get_state"}
{"jsonrpc":"2.0","id":2,"method":"prompt","params":{"message":"Describe the project"}}
{"jsonrpc":"2.0","id":3,"method":"command","params":{"input":"/tools"}}
```

Supported methods are `prompt`, `steer`, `follow_up`, `abort`, `bash`, `command`, `get_state`, `get_commands`, `get_models`, and `extension_ui_response`.

`steer` and `follow_up` use `params.message`. `bash` uses `params.command` and optional boolean `excludeFromContext`. Commands use `params.input`.

State changes arrive as `state` notifications. Extension dialogs arrive as `extension_ui_request` notifications. Reply with `extension_ui_response`, supplying `params.requestId` and either `value` or `cancelled: true`.

RPC supports basic extension dialogs. It does not expose terminal component factories, themes, or a terminal editor. EOF cancels unanswered dialogs and drains admitted requests. Input errors cancel model work before returning the failure.

## SDK ownership

Create an application, call `run`, `submit`, `command`, or `executeBash`, and close it in a `finally` block. `snapshot()` reads application state. `subscribe()` observes updates. The application owns its Harness and storage lifetime. An injected model collection remains caller-owned.

See [application contracts](../packages/cli/docs/spec.md) for session replacement, extension contexts, and cleanup rules.
