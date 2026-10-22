# Application authentication and settings

`@arc/cli` owns the files described here. The AI package owns provider authentication, OAuth flows, and token refresh. The application supplies a persistent `CredentialStore` and an `AuthInteraction` for terminal prompts.

## Credentials

`createApplicationModels({ home })` installs the built-in providers and uses `home/auth.json`. The application catalog excludes Mistral. The `openai-codex` provider uses legacy OAuth login.

Browser callback authentication closes the manual-code prompt automatically. Prompt cancellation and cancellation of the entire login attempt have separate lifetimes. Escape cancels the active login, and finishing the attempt removes any remaining login prompts.

After `/login` succeeds, the terminal shows the provider's available models. Only confirming a model changes the conversation and saves the choice. Escape keeps the current model; without an existing selection, it remains unset.

Constructing the models collection does not read credentials or contact a provider. `loginProvider(models, providerId, interaction)` selects an available login method and calls `models.login`. `logoutProvider` calls `models.logout`.

`FileCredentialStore(authPath)` stores one canonical AI credential per provider ID. API-key entries contain `type: "api_key"` and optional `key` and `env`. OAuth entries contain `type: "oauth"`, `access`, `refresh`, and numeric `expires`. OAuth metadata remains intact.

Every modification and deletion reloads the latest file under a cross-process lock. The lock covers the callback, including an OAuth refresh run by `Models.getAuth`. This prevents concurrent refreshes from reusing an old rotated refresh token. It also prevents writes for different providers from losing one another. A callback that returns `undefined` leaves the entry unchanged. A callback error propagates.

The store writes a temporary file in the same directory, syncs its contents, and renames it over the destination. Readers therefore see a complete file. Mutations set the storage directory to mode `0700` and write files with mode `0600` on POSIX systems. The supplied parent directory is application-owned. Windows permissions follow the host filesystem's rules.

Locks use heartbeat updates and a 30-second stale threshold. A waiting operation fails after 30 seconds or when its abort signal fires. If an active callback ignores cancellation, the operation rejects promptly but keeps its lock until that callback settles. An aborted callback cannot later commit its result. Editors that bypass the lock can still race with application writes.

Missing files mean no stored credentials. Malformed JSON and invalid credentials produce errors and remain untouched. Storage errors omit credential data and raw parser messages. API-key strings and environment values are literal data. The store does not execute command strings or interpolate environment references.

## Settings

`loadSettings({ cwd, home })` loads `home/settings.json`, then `cwd/.arc/settings.json`. Project fields replace global fields. Arrays and the entire `mcpServers` list replace the inherited value. A model is an object with `provider` and `modelId`.

| Field | Default | Accepted value |
| --- | --- | --- |
| `model` | Unset | `{ "provider": "...", "modelId": "..." }` |
| `thinkingLevel` | Unset | An AI model thinking level, including `off` |
| `modelThinkingLevels` | Unset | Map from `provider/model` to a thinking level |
| `enabledModels` | Unset | Ordered model IDs or model-scope patterns |
| `compaction` | Durable defaults | Optional `enabled`, token budgets, and `modelOverrides` |
| `steeringMode` | Durable default | `"all"` or `"one-at-a-time"` |
| `followUpMode` | Durable default | `"all"` or `"one-at-a-time"` |
| `toolExecution` | `"parallel"` | `"parallel"` or `"sequential"` |
| `fullscreen` | `false` | Boolean |
| `theme` | `"system"` | Theme name or `light/dark` pair |
| `themes` | `[]` | Additional theme files or directories |
| `markdown` | Streaming diagrams | Optional `mermaid` mode and `codeBlockIndent` |
| `extensionFiles` | `[]` | File paths |
| `resourcePaths` | `[]` | Resource directory paths |
| `mcpServers` | `[]` | Stdio or HTTP definitions |
| `codemode` | `true` | Boolean; can change during an idle session |
| `editorPaddingX` | `1` | Integer from 0 to 3 |
| `autocompleteMaxVisible` | `5` | Integer from 3 to 20 |
| `showHardwareCursor` | `false` | Boolean |
| `clearOnShrink` | `false` | Boolean |
| `showTerminalProgress` | `true` | Boolean |
| `retry` | Durable defaults | Retry policy, including `enabled` |
| `treeFilterMode` | `"default"` | `"default"`, `"no-tools"`, `"user-only"`, `"labeled-only"`, or `"all"` |
| `branchSummarySkipPrompt` | `false` | Skip the branch-summary selection prompt |

Relative extension and resource paths resolve against `home` for global settings and `cwd` for project settings. An explicit MCP stdio `cwd` uses the same base. Other stdio command arguments remain literal.

A stdio server has `name`, `transport: "stdio"`, and `command`. It may contain string-array `args`, a string-valued `env` object, and `cwd`. An HTTP server has `name`, `transport: "http"`, and an HTTP or HTTPS `url`. It may contain a string-valued `headers` object and an `oauth` object with optional `clientId`, `clientSecret`, `scope` and `redirectPort`. A client secret requires a client ID. Set `redirectPort` when a pre-registered client requires a fixed callback address. Server names must be unique within a settings file.

In the terminal, `/mcp` opens a server picker followed by Connect, Disconnect, Log in and Log out actions. Without a configured server, it shows setup guidance. In headless modes it reports connection status and tool counts.

- `/mcp connect <name>` connects a configured server.
- `/mcp disconnect <name>` stops the connection and removes its tools. It keeps saved credentials.
- `/mcp login <name>` opens browser OAuth for a configured HTTP server, waits for the callback and reconnects it.
- `/mcp logout <name>` disconnects the server and deletes its saved OAuth state. It does not revoke the remote account grant or remove explicitly configured HTTP headers.

A server that returns an authorization challenge stays disconnected at startup; Arc remains available so you can run `/mcp login`. OAuth login uses the MCP library's discovery, PKCE, registration and token-exchange helpers. Saved tokens and registration state live in `home/mcp-auth/<server-url-hash>.json`, separate from model-provider credentials. Files use private POSIX permissions and atomic updates. Refresh runs when the server rejects an expired access token. Closing a connection cancels its pending authentication requests and prevents later credential writes.

The browser callback binds to `127.0.0.1` at `/callback`. Arc reuses its saved callback port; a configured `redirectPort` takes precedence. Browser authorization must reach that callback on the machine running Arc. Escape cancels a pending login and closes its callback listener. Login and cancellation dismiss the progress panel. Stdio servers manage authentication in their own executable or environment and do not use Arc's HTTP OAuth login.

Restart Arc after editing server definitions. MCP does not require Code Mode.

Use `/settings` for the keyboard menu. Parallel and sequential select how tool calls are scheduled; they are not tools. Mermaid diagrams render in assistant Markdown according to the `markdown.mermaid` setting. Supported LaTeX expressions render as terminal text, not as a PDF or a complete TeX document.

Unknown fields, invalid values, malformed JSON, and duplicate MCP names are errors. The loader does not reset an invalid file or continue with defaults. `saveSettings(home, change)` validates and merges only the supplied fields into the latest global file under the same locking and atomic-write mechanism as credentials. It does not persist project overrides into the global file.

Compaction token budgets are nonnegative integers. `modelOverrides` maps model identifiers to compaction fields. These settings pass to Durable's existing agent policy. The application does not run a second compaction scheduler.

`/settings` opens a searchable keyboard menu. It changes tool execution, automatic compaction, steering and follow-up delivery, thinking level, thinking visibility, tool expansion, and fullscreen preference. Fullscreen changes switch the active terminal renderer. Close extension overlays before switching. The editor draft, replacement editor, component tree, and input subscriptions stay attached. Thinking visibility and tool expansion affect the current terminal only. `/settings autoCompact false`, `/settings steeringMode all`, and `/settings followUpMode one-at-a-time` also work without the menu.

## Verification limits

The fixture tests use temporary directories, fabricated credentials, and local Node subprocesses. They exercise persistence, private file modes, concurrent modifications, cancellation, settings precedence, and the actual `Models.getAuth` refresh path with a fixture provider. They do not read a real home credential store, call a live provider, or prove a provider's current OAuth acceptance. Live provider authentication and terminal interaction require separate acceptance checks.

## Terminal login and project trust

`/login` selects a provider and runs its authentication prompts inside the terminal. `/login name` accepts a provider identifier or display name. Other text starts a filtered provider selector. Secret input is masked. Escape cancels the current dialog or pending authorization. The same model authentication API stores the credential. Other programs' credentials are not imported.

After login, the application refreshes that provider's catalog with a 15-second limit. Refresh failure retains the saved credential and cached catalog. Cancelling refresh does not undo a completed login. If the conversation has no known model, the application selects and saves the first available model from that provider. A valid existing model stays selected.

`/model` shows authenticated, available models. `/model search` opens a filtered selector; `/model provider/model` selects an exact identifier. A missing available catalog points to `/login`.

`/logout` lists credentials in the application's `home/auth.json`. It removes the selected stored credential, then refreshes terminal model availability. Environment credentials remain available. SDK callers with an injected model collection and a different credential store use `/logout provider` explicitly.

Project settings and automatically discovered project resources load only for a trusted project. `/trust` saves a canonical folder or parent-folder decision in `home/trust.json`. The nearest folder decision wins. Restart after changing it. Explicit SDK resources and explicit extension files are caller-authorized.

`enabledModels` stores ordered model IDs or patterns for cycling. Patterns match a model ID or `provider/model`, without case sensitivity. For example, `provider/*:high` selects that provider's models with high thinking. A literal ID takes priority over pattern syntax. Bare names also support substring matching. Fuzzy selection prefers an undated alias, then the highest model ID in lexical order. A bare ID offered by several providers includes each provider and reports a warning. Overlapping patterns keep the first match and its thinking override.

For example, `/scoped-models save provider/fast*:low,provider/large*:high` saves an ordered scope. The `--models "provider/fast*:low,provider/large*:high"` startup option overrides the scope for that run without saving it. An unknown command pattern rejects the command and retains the previous scope. An invalid thinking suffix reports a warning and uses the model default. Cycling checks authenticated availability each time. An empty or unavailable scope lets cycling use all authenticated models.

On a fresh session, the first available scoped model is selected unless an explicit model or provider was supplied. A resumed session retains its stored model and thinking level. Switching models uses the scope's thinking override, then `modelThinkingLevels`, then the global `thinkingLevel`, then the current level. The selected model's supported levels clamp the result. `/thinking save high` saves a per-model default for the current model. Ordinary `/thinking high` changes only the active conversation. Saving one model's level merges that entry under the settings-file lock.

The `/scoped-models` terminal selector expands patterns into concrete IDs and retains their thinking suffixes when applying or saving the selection. Changes apply as you make them. Escape closes the selector and retains those session changes. Enter closes it; Ctrl+S also saves it to global settings. Space toggles one model, Ctrl+P toggles its provider, Ctrl+A enables all models, Ctrl+X clears the selection, and Alt+Up/Down changes the order. These keys use configurable `app.models.*` actions. API keys and OAuth tokens do not belong in this list.


## Keybindings

`home/keybindings.json` maps action names to a key string or a list of keys. An empty list disables an action. This file is global to the application home and is not read from the project.

```json
{
  "app.tools.expand": "ctrl+y",
  "app.model.select": ["ctrl+l", "alt+m"],
  "app.thinking.toggle": [],
  "tui.input.submit": "ctrl+s"
}
```

Application actions include `app.clear`, `app.interrupt`, `app.exit`, `app.model.cycleForward`, `app.model.cycleBackward`, `app.model.select`, `app.thinking.cycle`, `app.tools.expand`, `app.thinking.toggle`, `app.message.followUp`, `app.message.copy`, `app.clipboard.pasteImage`, and `app.session.new`, `tree`, `fork`, `resume`. The session actions have no default keys. TUI editor, selection and fullscreen actions use their existing `tui.*` names.

Keys can use `ctrl`, `alt`, `shift` and `super` modifiers. Examples are `ctrl+o`, `alt+enter` and `ctrl+shift+p`. Modifier names cannot repeat. `/reload` reads a complete replacement configuration. Invalid JSON, unknown actions and invalid keys are errors; a failed reload retains the active bindings. `/hotkeys` displays application bindings. The editor and tool hints use the active bindings.

The default backward-model key is Alt+P on Windows and WSL, and Ctrl+Shift+P elsewhere. Follow-up uses Ctrl+Q on Windows and WSL, and Alt+Enter elsewhere. The terminal adapter restores the previous TUI keybinding manager when it closes.


## Clipboard input

Ctrl+V pastes an image or text. Windows and WSL use Alt+V by default. `app.clipboard.pasteImage` changes this binding. Pasted images remain in the terminal draft until the next conversation submission. The draft shows the number of attached images. Ctrl+C clears an idle draft, including its images. Preparation errors keep the image and text draft for correction.

Linux reads Wayland selections with `wl-paste`, then X11 selections with `xclip` when the first backend is unavailable. An empty Wayland selection does not read an older X11 selection. Other supported desktops use the TUI native clipboard helper. Clipboard subprocesses have output and time limits. Remote clipboard-image protocols and WSL's Windows clipboard fallback are not implemented.
