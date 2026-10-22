# Application contracts

## Package ownership

`@arc/cli` is the application. AI, Durable, TUI, telemetry, environment, MCP and Code Mode remain independent packages. `scripts/check-boundaries.mjs` rejects application dependencies and source imports in library packages.

The application uses Durable's existing registry, scheduler and storage. It does not run another model/tool loop or write another recovery journal. UI messages come from committed conversation views and their live documents. The renderer owns presentation state such as expanded tools and selected dialogs.

## Sessions and resources

An application opens one Harness at a time. Each file-backed session has a process lock with heartbeat and stale-lock recovery. Closing releases the lock after closing the Harness. Startup failure closes the opened storage and releases the lock.

`/new` creates a new session file for file-backed operation. With injected storage or memory mode it creates an independent conversation in the existing Harness. `/resume path` switches file-backed sessions. Switching requires idle conversation input. Current task migrations and recovery remain Durable's responsibility.

Interactive `/tree` shows entries and branches with the current leaf selected. The active branch is ordered first. Search matches message text, entry metadata and labels. Filters select the default view, no tool results, user messages, labeled entries or all entries. Filter choices persist in settings. Branches fold and unfold. The selected entry remains readable when deep indentation requires horizontal clipping. Labels are session documents and survive SQLite/JSONL reopening. `getLabel` and `setLabel` are available on the application and extension context.

Selecting the current leaf does nothing. A branch tip reopens its conversation; an earlier entry creates a durable fork at that boundary. Selecting a user entry restores its text in the editor and branches before that entry. Before navigating, the terminal offers no summary, a summary, or a summary with custom instructions. Escape returns to the tree. `branchSummarySkipPrompt: true` skips that question. `/tree entry:<id> --summarize [instructions]` requests a summary without the selector. Summarization uses the selected model through the AI provider interface. Its usage is recorded. A failure or abort leaves the selected conversation unchanged. A successful summary is stored at the destination as context; it does not erase the abandoned branch. `/tree entry:<id>` navigates without a summary. `/tree <conversation-id>` selects a conversation tip. Headless `/tree` lists conversations.

`/fork` creates a conversation in the current backend. `/clone` creates a separate SQLite file or JSONL directory when the current session is file-backed. It copies the complete backend so history, extension documents and settled task receipts remain available. The active conversation is forked in the copy using Durable's document policies. Copied provider identities are refreshed, and the current model and thinking settings are retained. Source data is not forked or changed. Every task must be terminal before copying. SQLite uses a consistent backup; JSONL copies its directory while commits are serialized. Publication uses an owned staging directory and rename. This is a same-backend clone, not cross-backend conversion. Memory-only applications use an in-memory fork.

Interactive `/resume` and `/fork` open searchable selectors when no argument is supplied.

Saved project trust is checked before project settings and discovered extensions load. Unknown projects are excluded by default in SDK and headless modes. The executable offers a startup choice in interactive mode. `projectTrusted` and the CLI `--trust` or `--no-trust` flags provide an explicit per-run decision. Trust decisions use canonical paths and nearest-parent inheritance. `/trust` saves a decision for the next startup. It does not unload code already running.

The working directory used to open the application supplies resources and the initial execution directory. Providers and conversation choices are resolved from the existing libraries. Credentials use `home/auth.json`; settings use global and project files.

## Terminal rendering

Assistant Markdown supports tables, fenced code with syntax highlighting, Mermaid diagrams, and supported LaTeX expressions. This is terminal rendering, not a full TeX engine. Read and write cards highlight recognized source-file languages. Edit cards use added and removed colors, with changed-word emphasis for single-line replacements. Code Mode highlights JavaScript, and generic tool arguments highlight JSON. Plain text files and shell output keep plain text styling. Streaming transcript updates coalesce into 33 ms frames; completed responses render immediately. Fullscreen expansion retains the viewport until the user scrolls to the end or submits input. Ctrl+T toggles thinking and Ctrl+O toggles tool expansion; key release and repeat events do not reverse the toggle.

Code Mode shows its JavaScript source and nested call statuses inside one script card. Independent model tool calls still have their own cards. Parallel and sequential select scheduling behavior; neither is an extra tool. MCP and Code Mode remain separate features.

## Session files

A normal launch starts a new session. Use `arc --continue` to reopen the latest session for the working directory, or `/resume` to choose one. `/new` creates another session. Starting Arc without sending a message can therefore leave an empty session database.

The default SQLite backend stores conversations, entries, tasks, submissions, documents, and document revisions as tables in each session database. It does not create a separate database per table or tool call. SQLite can create `-wal` and `-shm` companion files while the database is open. Preserve these files with their database; do not delete them while Arc is running. JSONL and memory are alternative backends, not additional databases written alongside SQLite.

## SDK lifecycle

`createApplication(options)` returns the shared runtime used by every interface. `run(input)` accepts a string or Durable text/image content blocks and waits for its own submission's answer. `submit(input, {whenBusy})` returns a Durable submission handle for steering or follow-up work. When an input hook handles the request, `submit` returns `undefined`, `run` returns a completed empty answer and no submission is allocated. `abort` requests cancellation, including branch summarization. `close` is idempotent.

`subscribe(listener)` immediately supplies the latest known state and publishes subsequent updates. Listeners must not block rendering. The application schedules document reads outside Durable's synchronous publication callbacks. It retries when the committed conversation view changes during a snapshot read, so a new transcript is not paired with old agent/live state. `snapshot()` reads current state. Conversation selection replaces the observation without replacing the toolkit.

Injected storage transfers its lifecycle to the Harness. Injected models are borrowed. SDK callers may inject resources and extensions without invoking the executable. The application does not copy credentials from other programs.

## Extension definitions

An application extension extends Durable's `Extension` with optional commands and providers:

```ts
import type { ApplicationExtension } from "@arc/cli";

export default {
  name: "project-actions",
  commands: [{
    name: "greet",
    description: "Show a greeting",
    execute(args, app) {
      return { message: `Hello ${args || "there"}. Directory: ${app.cwd}` };
    },
  }],
} satisfies ApplicationExtension;
```

Durable contributions remain tools, task definitions, hooks, prompt sections and wrappers. The application checks command names before installation. Extension commands can replace built-ins except abort and quit. Commands with the same name in different extensions receive numbered invocation aliases. Provider contributions require a mutable model collection. Closing or removing the owning extension restores a previous provider when that registration is still owned by the application.

The Node loader uses esbuild and native ESM imports. Calling `/reload` reloads resources and file definitions. Replacement is atomic for each registry installation; loading several files is not one atomic transaction. Import/validation failures preserve the previous definition for that file. Subscriber exceptions after publication are reported but do not reverse publication.

Relative ESM imports reload with their file generation. Bare package imports retain Node's cache. CommonJS extension replacement is unsupported. Node retains imported ESM generations. Keep extension modules declarative and own resources in tasks or explicit host lifecycles. This loader cannot unload arbitrary imported code or clean up timers created at module scope.

Application definitions can also return activation cleanup and receive session/UI lifecycle callbacks. Tool renderer contributions and editor replacement stay in this package. [Extension UI and lifecycle](extensions.md) defines their ownership and failure rules.

## Interactive UI

The application owns UI capabilities. A terminal adapter attaches them through `attachUI`; Durable has no terminal dependency. Extensions inspect `app.ui.supported` and `app.ui.capabilities` before using dialogs, editor access, notifications, status, widgets, title changes or custom components. Headless mode rejects unsupported interactive calls rather than silently succeeding.

The terminal provides masked secret input, cancellable provider login, clipboard copying and image/text paste, and ordered model cycling. Login refreshes the provider catalog before updating model choices. `/model` uses authenticated models and supports an initial search. `/scoped-models` accepts ordered IDs, patterns and thinking suffixes. The selector expands patterns and preserves those suffixes. It applies changes live and persists them with Ctrl+S. Escape retains the session selection. Ctrl+P cycles forward; Ctrl+Shift+P cycles backward outside the selector. Cycling uses authenticated models. An empty or unavailable scope falls back to all authenticated models. Per-model thinking defaults are validated settings; model switches clamp the selected level to supported capabilities.

The edit presenter requests a read-only file preview after complete arguments arrive. It uses the same execution-environment resolver, text normalization and replacement matcher as the edit tool. It does not write the file. Argument changes invalidate earlier reads; disposing the card prevents later redraws. The recorded tool result replaces the preview. Historical completed calls do not read files for previews. Preview output is advisory because another writer can change the file before execution.

`/settings` uses the TUI settings component. It controls tool execution, automatic compaction, queue delivery, thinking, and display preferences. Durable owns the compaction and queue policies. Fullscreen changes switch renderers without replacing the editor or extension components. A stable TUI reference forwards their callbacks to the active renderer. Input and color subscriptions move with it. Open extension overlays must close before a switch.

User attachments and tool results use the TUI image component when the terminal supports Kitty or iTerm2 image protocols. Unsupported terminals show its text fallback. The application validates image MIME types and normalizes base64 data before it reaches the terminal protocol. Non-PNG transcoding for Kitty still requires a host-supplied TUI transcoder.

Terminal rendering sanitizes message and tool text before it reaches components. Raw escape sequences in file contents cannot move the cursor or change the terminal title. Programmatic custom components are trusted UI code.

`/tasks` toggles a live view of the Harness task graph. The panel shows task kind, phase, waiting dependencies, conversation ownership and blockers. It does not add scheduling or subagent policy.

Themes, Mermaid, LaTeX, syntax highlighting, custom terminal components, streaming controls and autocomplete contributions are described in [Terminal themes and Markdown](themes.md) and [Extensions](extensions.md). These are application adapters over the independent TUI library.

## Optional features

MCP connections register namespaced tools directly in the Durable registry. Structured results, cancellation and progress pass through the MCP client. MCP can run without Code Mode. Configured HTTP servers support browser OAuth through `/mcp login <name>` and local credential removal through `/mcp logout <name>`. Model-provider `/login` and `/logout` remain separate. Code Mode is an independent extension using Durable's nested-tool execution and recorded state. Arc enables it by default. `/settings codemode false` disables it, and `/settings codemode true` enables it again while the application is idle. It can run without any MCP server. Scripts call the tools exposed by the current registry; nested calls use the same execution environment and durable task records as direct calls. The sandbox limits script access, but a permitted host tool still runs with its configured host authority.

## Transcript exports

`/export` writes `conversation.html` by default. HTML is self-contained, escapes message markup and includes inert transcript data. `/export path.json` writes an Arc transcript document with format `arc-transcript`, version `1`, and model messages. `/import path` validates the document and creates a new conversation containing those messages. It does not execute historical tool calls. Exports are readable conversation transfers, not a full backup of tasks, documents or backend revisions. Preserve the selected backend to recover complete runtime state.

`/share` sends a self-contained HTML document through an installed, authenticated GitHub CLI as a secret gist. Secret gists are accessible to anyone who has the link. No upload happens during export. Clipboard transfers stay on the terminal adapter and never write escape sequences into JSON or RPC output.

## RPC

RPC uses one JSON-RPC 2.0 request per line with a string or numeric ID. Methods are `prompt`, `steer`, `follow_up`, `abort`, `command`, `get_state`, `get_commands` and `get_models`. `prompt` takes `{message}`, where `message` is a string or text/image content blocks, and waits for its own result. `steer` and `follow_up` return submission IDs. `command` takes `{input}` such as `/model provider/model`.

The `bash` method takes `{command, excludeFromContext?}` and returns a user shell result. State notifications and `get_state` include `userBash` progress. `abort` also cancels user shell commands. These operations do not invoke the model.

RPC also attaches a UI adapter for extension dialogs. An `extension_ui_request` notification contains `params.requestId`, a `method` such as `select`, `confirm`, `input` or `editor`, and the dialog fields. Reply through the `extension_ui_response` RPC method with `{requestId, value}` or `{requestId, cancelled: true}`. Confirmation values are boolean; text and selection values are strings. Select responses must match an offered value. Invalid replies leave the request available for a corrected reply. Replies to expired or completed dialogs return `{accepted: false}`.

Dialogs can run while their original command waits. Abort signals, timeouts, input EOF and transport abort cancel pending dialogs. EOF also cancels dialogs opened by requests still settling. Output failures terminate the RPC run. Detaching restores the previous UI. Notifications, status, title and editor-text changes use the same notification channel without requiring a response. Custom terminal components remain unavailable over RPC.

State notifications use method `state` with conversation entries, live progress, queued input, model choice and usage. Responses correlate with request IDs. Requests can finish out of order so an abort does not wait behind a prompt. Duplicate active IDs and malformed requests are rejected. Standard output contains protocol records; diagnostics use standard error. This is Arc's protocol, not an assertion of wire compatibility with another application.


## Input attachments

CLI `@file` arguments read files from the selected working directory, using the file tool's path resolution. Empty files are skipped. Text files retain their content with a file label and no UTF-8 BOM. Image detection uses content bytes. The CLI accepts up to 16 MiB of attachment bytes in total. Piped input, files and positional words form one initial submission. RPC reads input from its request stream and rejects positional prompts or attachments.

SDK `run` and `submit`, RPC `prompt`, `steer` and `follow_up`, and text/JSON mode runners accept Durable's `UserInput` type. Invalid or empty blocks fail before submission. Image preparation uses the selected model's resize limits, with the default image limits for unspecified fields. Preparation failure leaves conversation history unchanged. The worker uses its own byte copy, preserving caller buffers. HTML exports embed supported image types as data URLs and block external resources.

Diagnostic callbacks are observational. A synchronous exception from `onReport` does not stop observer delivery, session replacement or resource cleanup. Command interception failures still reject the requested command.

## Branch summary requests

`branchSummary.reserveTokens` reserves space for the summary prompt and response. It defaults to 16384. The newest entries receive priority. Tool-result bodies and thinking blocks are omitted. A summary at the budget boundary can remain when less than 90 percent of the budget has been used.

Summary requests disable cache retention and keep one routing ID across retries. The `retry` setting uses the same enabled, maximum retries, base delay and delay cap as generation. Aborting during backoff cancels the operation. Failed, aborted, empty or tool-calling summaries do not navigate the conversation. Generated summaries retain sorted read-only and modified file lists; extension-supplied summaries are marked separately.
