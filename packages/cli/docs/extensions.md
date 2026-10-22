# Application extensions

An application extension is a Durable extension with optional commands, providers, lifecycle callbacks and tool renderers. Export it as the default value of a trusted ESM file. The application loads TypeScript through esbuild. Durable still owns tools, tasks, hooks, prompt sections, storage and recovery.

## Own application resources

`activate(context)` runs once for each installed definition. Return a cleanup function for resources acquired there. Replacement, removal and application shutdown call that cleanup once. A failing cleanup does not prevent other resources or storage from closing.

`onSessionStart` and `onSessionShutdown` receive a reason such as `startup`, `reload`, `new`, `resume` or `fork`. `onUIAttached` runs when a terminal adapter becomes available. `onUIDetached` runs when it leaves. Headless applications do not attach a terminal.

A lifecycle context includes the current state, working directory, models, Durable handles and the current UI adapter. Its `state` getter returns the current application snapshot. Its UI and Durable handle getters follow the active application. Capture the actual resource when acquiring it; close that captured resource in cleanup.

Lifecycle callbacks do not receive queued application command controls. Calling those controls from inside a command's lifecycle callback could wait on the command that is already waiting for the callback. Use the supplied Durable handles for runtime operations. Commands receive the application object and an `ExtensionCommandContext` as their third argument. The command context provides `waitForIdle`, `newSession`, `fork`, `navigateTree`, `switchSession`, and `reload`.

Callbacks and cleanup run in application order. Listener errors are reported without stopping other listeners. Definition publication and external side effects are not one transaction. If activation throws before returning its cleanup, it must release resources it already acquired. Module-scope timers cannot be unloaded by the host.

## Register contributions while running

The activation context provides `registerTool(tool)`, `registerCommand(command)`, `registerFlag(name, definition)`, `registerShortcut(shortcut)`, `registerMessageRenderer(name, renderer)`, `registerEntryRenderer(name, renderer)` and `registerToolRenderer(name, renderer)`. Definitions use the same types as their declarative counterparts. Registering the same name again replaces that owner's contribution. Reserved command and flag names remain protected. Dynamic flags can read startup arguments through `getFlag`.

Dynamic contributions belong to the loaded definition. Reload, removal and shutdown remove them. They do not replace the loader's ownership record or restart activation. Durable receives an updated immutable registry snapshot; running phases retain their captured snapshot. Subsequent phases use the new definitions. Explicit conversation tool selections still control which tools the model receives.

`context.registerHook(hook(task, handlers))` adds native Durable hooks and returns an idempotent removal function. Use generation hooks to change request messages or continue a run, tool hooks to block calls or replace arguments/results, and compaction hooks to supply a summary. These run in Durable's existing tasks.

`context.on(type, listener)` subscribes to committed Durable events and returns a removal function. The listener receives the current extension context and the typed event. Event names include `run_start`, `run_end`, `turn_start`, `turn_end`, `message_start`, `message_update`, `message_end`, `tool_execution_start`, `tool_execution_update`, `tool_execution_end`, retry, compaction, inbox, submission and usage updates. Observers cannot change an already committed result. Use hooks for interception. Slow observers can receive a replacement snapshot when the native watch resynchronizes. Do not wait for application session-switch commands inside an observer.

## Replace sessions from commands

Command controls invoke the built-in session operation even if an extension replaces its slash command. `newSession({parentSession, setup, withSession})` can initialize the destination through `setup(tx, conversationId)`. Setup completes before the destination becomes active. A failed setup leaves the current conversation selected. `parentSession` records the parent path or identity supplied by the caller.

After new-session, fork or session-switch operations, continue through `withSession(freshContext)`. Captured command contexts reject further use after replacement or reload. Lifecycle contexts remain live views of the application.

`fork(entryId, {position, withSession})` supports `before` and `at`. The command-context default is `before`, which requires a user-message entry and returns its text for the editor. Forking before the first entry creates empty history. `at` retains the selected entry. The destination uses Durable's conversation and document rules.

`navigateTree(entryId, {summarize, customInstructions, replaceInstructions, label})` controls branch summarization and labels. `replaceInstructions` replaces the default summary request with the supplied instructions. A successful navigation applies the label. `switchSession(path, {withSession})` supplies a fresh context after opening the destination.

## Run user shell commands

Interactive `!command` runs a shell command without a model request. The result enters conversation context. `!!command` records and displays the result but excludes it from model context. Output streams into the transcript; tool expansion controls the displayed tail. Escape or Ctrl+C cancels running commands. Shutdown joins them before closing storage.

SDK hosts use `application.executeBash(command, {excludeFromContext, onChunk, signal})`. Results contain output, exit code when available, cancellation, truncation and an optional complete-output path. Retained output is limited to 50 KiB or 2,000 lines; larger output spills through the execution environment. The `shellPath` setting chooses the local shell. `shellCommandPrefix` runs before user commands and the model's bash tool.

`onUserBash(context, event)` can return a complete `result` or custom `operations` implementing the execution environment's `exec` contract. A thrown hook stops execution; it does not fall back to the local machine. Results are submitted through Durable so model-visible writes respect conversation ordering.

## Replace the editor and render tools

`onInput(context, event)` sees text, optional images, source and steering/follow-up intent before model validation or submission. Return `{ action: "continue" }`, `{ action: "transform", text, images? }`, or `{ action: "handled" }`. Transforms chain in installation order. Omitting `images` preserves them; an empty array clears them. Handled input stops the chain and creates no Durable submission. A failed hook reports its error and leaves its incoming input available to later hooks.

`beforeSessionSwitch(context, { reason, targetSessionFile? })` can cancel new/resume operations. `beforeFork(context, { entryId, clone })` can cancel forks or clones. `beforeTree(context, event)` receives the target, old leaf, common ancestor, abandoned entries, summary preference and cancellation signal. Return `{ cancel: true }` to stop navigation or `{ summary: "..." }` to supply the requested summary. Cancellation runs before destination allocation. These callbacks must not await another admitted application command. Task execution, tool interception and automatic compaction customization use the existing Durable extension hooks. The application does not register a second task scheduler or tool-hook system.

`context.getLabel(entryId)` reads a label. `context.setLabel(entryId, label)` writes it or clears it with `undefined`. Labels are independent of conversation entries. `ui.tree`, when available, exposes the terminal tree selector to application extensions.

The editor factory receives the active TUI, its editor theme and the active keybinding manager. A replacement keeps the current draft, submission callbacks and autocomplete provider. Pass `undefined` to restore the default editor. Custom editors can provide `dispose()` for cleanup.

```ts
import { Editor, Text } from "@arc/tui";
import type { ApplicationExtension, EditorFactory } from "@arc/cli";

const factory: EditorFactory = (tui, theme) => new Editor(tui, theme);

const extension = {
  name: "project-ui",
  activate(context) {
    return () => {
      if (!context.ui.supported) return;
      context.ui.setStatus("project-ui", undefined);
      if (context.ui.getEditorComponent() === factory) {
        context.ui.setEditorComponent(undefined);
      }
    };
  },
  onUIAttached(context) {
    context.ui.setEditorComponent(factory);
    context.ui.setStatus("project-ui", "Project interface enabled");
  },
  toolRenderers: {
    read: {
      renderCall(args) {
        return new Text(`Reading ${String(args.path)}`);
      },
      renderResult(result, context) {
        const text = result
          ? result.content.flatMap((part) => part.type === "text" ? [part.text] : []).join("\n")
          : context.slot?.output ?? "Reading…";
        return new Text(context.expanded ? text : text.split("\n").slice(0, 5).join("\n"));
      },
    },
  },
} satisfies ApplicationExtension;

export default extension;
```

Renderers are keyed by tool name, so they can display historical calls even when the corresponding tool is not registered. Later extension contributions take precedence. They can replace call display, result display, or both. `renderShell: "self"` lets the renderer provide its own framing.

The render context includes the call, live tool slot, working directory, theme, expansion state, partial-result flag, execution and argument-completion flags, error status, per-call state object, and `requestRender()`. Render callbacks are synchronous. Components can have `dispose()`. Components reused by the next rendering are retained; replaced components are released. Session changes, reload and terminal shutdown release remaining components. A renderer failure uses the default display and reports the error. If activation fails during reload, the host still publishes the resulting presentation revision and state. A later repaired definition can reload normally; external activation side effects are not rolled back.

Built-in read, write, edit, and bash presenters format their calls and results. Read content expands on request. Write calls preview their content; edit calls request a read-only file preview and results show the recorded diff. Collapsed bash output keeps the latest five visual lines. Expanded output remains plain. Individual completed tools can expand by mouse click; the global expansion shortcut still controls all cards. Custom components retain their input, focus, and mouse handlers. Consecutive thinking blocks form one clickable disclosure. The default editor embeds working status in its top border. A replacement editor receives a separate working indicator instead.

## Dialogs and editing

- `ui.select`, `ui.confirm` and `ui.input` provide standard dialogs. Their options accept `signal` for cancellation and `timeout` in milliseconds. Positive timeouts show a countdown rounded up to whole seconds. Cancellation returns `undefined`, or `false` for confirmation. It closes only that dialog and preserves the editor draft. Use the input option `secret: true` for credentials.
- `ui.editor(title, initial)` provides a multiline dialog. Enter confirms, Shift+Enter adds a line, and Escape cancels.
- `ui.setEditorText`, `ui.getEditorText` and `ui.pasteToEditor` operate on the main editor.
- `ui.custom` accepts a synchronous or asynchronous `(tui, theme, keybindings, done)` factory. Call `done(value)` to complete the dialog. Completion, cancellation and shutdown release components with `dispose()`. A component returned after cancellation is released without being mounted.
- Status and widget keys belong to callers. Use a unique extension prefix and remove owned contributions in cleanup.

Check `ui.supported` and `ui.capabilities` before interactive calls. Unsupported calls reject in headless modes. Custom UI code is trusted code, not a sandbox. Do not block shutdown waiting for a new user interaction.

## Customize terminal components

`ui.theme` returns the active palette. `ui.getAllThemes()` lists loaded names and paths. `ui.getTheme(name)` returns a palette without selecting it. `ui.setTheme(nameOrTheme)` changes the current terminal and returns `{ success, error? }`. It does not save settings. Use `/settings theme name` to persist a choice. An invalid selection retains the current theme.

`ui.setHeader(factory)` and `ui.setFooter(factory)` replace the standard components. Pass `undefined` to restore them. Factories receive the stable TUI reference and current theme. Footer factories also receive `getState()` and `getExtensionStatuses()` for current application data.

`ui.setWidget(key, content, { placement })` accepts a component, text lines, or a `(tui, theme)` factory. Placement is `aboveEditor` by default, or `belowEditor`. Components can define `dispose()`. The terminal releases replaced components and releases remaining components at shutdown. Theme changes rebuild factory components.

`ui.onTerminalInput(handler)` listens to raw input and returns an unsubscribe function. A handler can consume or replace input using the TUI listener result. Subscriptions follow screen switches and are removed at terminal shutdown. Extension cleanup should unsubscribe handlers and remove its widgets and status keys when unloading.

See [Terminal themes and Markdown](themes.md) for theme files and rendering settings.

## Control streaming and tool output

`ui.getToolsExpanded()` reads the global tool-output setting. `ui.setToolsExpanded(expanded)` updates it immediately. The keyboard shortcut, settings menu and extensions use the same setting. Individual card clicks can still override that setting until it changes.

`ui.setWorkingMessage(message)` replaces the streaming status message. Call it without an argument to restore the current task's default message. `ui.setWorkingVisible(false)` hides the working row without cancelling work. Retry and compaction messages remain visible.

`ui.setWorkingIndicator({ frames, intervalMs })` changes the working animation. One frame gives a static indicator. An empty frame list hides only the indicator; the message remains. Custom frames keep their supplied colors. Call without arguments to restore the default spinner. The terminal stops its animation when work ends, when the row is hidden, and on shutdown.

`ui.setHiddenThinkingLabel(label)` replaces the collapsed-thinking label. Call without an argument to restore the default. This changes presentation only; it does not expose hidden thinking or change the model's thinking level.

## Add autocomplete suggestions

`ui.addAutocompleteProvider(factory)` wraps the current provider and returns a removal function. Wrappers run in registration order. Their trigger characters accumulate, so a later wrapper does not disable earlier triggers. Delegate unmatched input and completion application to the provider passed to the factory to retain command and file suggestions.

Wrappers survive editor replacement and command-catalog refreshes. A factory that throws does not replace the active provider. Call the returned function during extension cleanup. Removal is idempotent, and terminal shutdown removes all remaining wrappers.

```ts
import type { ApplicationUI } from "@arc/cli";

function addResourceSuggestions(ui: ApplicationUI) {
  return ui.addAutocompleteProvider((current) => ({
    triggerCharacters: ["%"],
    async getSuggestions(lines, line, column, options) {
      const prefix = lines[line]?.slice(0, column) ?? "";
      if (prefix.startsWith("%")) {
        return { items: [{ value: "workspace", label: "Workspace" }], prefix };
      }
      return current.getSuggestions(lines, line, column, options);
    },
    applyCompletion: (...args) => current.applyCompletion(...args),
    shouldTriggerFileCompletion: current.shouldTriggerFileCompletion?.bind(current),
  }));
}
```

Call `addResourceSuggestions(context.ui)` from `onUIAttached`, and retain its removal function for cleanup.

## Show positioned overlays

Pass `{ overlay: true, overlayOptions, onHandle }` as the second argument to `ui.custom` to draw above the current terminal content. The editor draft remains in place. `overlayOptions` accepts the TUI's width, height limit, anchor, row, column, margin and visibility options. It can be an object or a function evaluated when the component mounts. Without explicit options, a numeric component `width` supplies the overlay width.

`onHandle` receives the TUI overlay handle for hiding, showing, focusing and inspecting bounds. Hiding an overlay does not resolve its dialog. Call the factory's completion callback to finish it. Completion removes that specific overlay, even when another dialog opened later. Escape cancels the most recently opened dialog. Setup failures, cancellation and terminal shutdown remove and dispose owned components. Close overlays before switching screen mode.


## Inspect mode and cancel commands

`context.mode` reports `sdk`, `interactive`, `text`, `json` or `rpc`. The executable sets its mode before creating the application. SDK hosts can set `ApplicationOptions.mode`; the default is `sdk`. Attaching the terminal reports `interactive` until it detaches. Retained extension contexts read the current state, conversation and UI instead of keeping the activation-time state snapshot.

RPC attaches a UI adapter for dialogs, notifications, status and title changes. `hasUI` is true during that attachment. Check individual capabilities before using terminal components. Dialogs are forwarded to the client and resolve when it responds, cancels, disconnects, or the supplied timeout or signal dismisses them. The [RPC contract](spec.md#rpc) defines the messages.

`beforeCommand(context, { name, args })` runs before a command changes application state. Return `{ action: "cancel", message? }` to stop it, or return nothing or `{ action: "continue" }` to proceed. A cancelled call returns `{ cancelled: true, message? }`. Hooks run in extension installation order, and cancellation stops later hooks. Exceptions and malformed decisions reject the command before it starts. Abort and quit bypass interception.

This hook applies to application commands, including extension-contributed commands. It does not replace Durable's task hooks, tool wrappers or invocation registry snapshots. Hooks must not wait for another admitted application command from inside a built-in command interception. A contributed command's execution runs outside the admission queue, so it can call application methods.

## Footer data

A footer factory receives `getGitBranch()`, `onBranchChange(listener)`, `getAvailableProviderCount()`, `getState()` and `getExtensionStatuses()`. Branch subscriptions return an unsubscribe function. The host watches repository HEAD and reftable metadata, including Git worktrees, and releases its watches when the terminal closes. Detached checkouts report `detached`; directories outside a repository report `null`.

## Application controls

The extension context exposes the current `model`, `thinkingLevel`, `scopedModels`, and `hasUI`. Use `isIdle`, `hasPendingMessages`, and `isProjectTrusted` to inspect application state. `getSettings` returns a copy.

`setModel` checks provider authentication before selection and returns whether selection succeeded. `setThinkingLevel` clamps the level to the model's capabilities. `setActiveTools` changes tools offered to the model while preserving tools callable by other tools. Unknown names are ignored. `getActiveTools` returns offered names. `getAllTools` returns configured registrations.

`sendUserMessage` submits through Durable and accepts a `deliverAs` value of `steer` or `followUp`. It does not call input transformation hooks recursively. `abort` and `compact` use the current Durable conversation.

Use `setSessionName` and `getSessionName` for the session display name. `onSessionInfoChanged` runs after a name commit. `onTree` runs after successful entry navigation.

## Flags and keyboard shortcuts

Declare `flags` as a record of names to `{ type: "boolean", default?: boolean }` or `{ type: "string", default?: string }`. Each declaration can include `description`. Read a value with `context.getFlag(name)`. Values are available during activation. Built-in option names cannot be replaced. SDK callers can supply the argument list through `extensionArgs`.

Declare `shortcuts` as an array of `{ key, description?, execute(context) }`. The terminal calls the handler without inserting the key into the editor. Dialogs keep their own keys. Global editor actions remain reserved, including interruption, exit, submission, selection, model controls and tool expansion. Reservations follow configured keybindings. Later declarations win when extensions use the same key.

## Render transformations

`toolRendererResolvers` run in extension installation order. Each resolver receives a tool name and a `next()` function. Call `next()` to retain or wrap the remaining renderers. Resolvers can handle historical tools that are no longer registered.

`markdownTransformer(source, context)` runs before terminal Markdown rendering. The context identifies user text, assistant text, or assistant thinking, and includes the streaming state and available width. Transformations change display text, not stored messages or provider input.

## MCP servers and extension events

Use `registerMcpServer`, `unregisterMcpServer`, and `getMcpServers` to manage extension-owned connections. The host disconnects owned servers on removal, replacement, or activation failure. An extension cannot unregister another extension's connection. `onMcpServersChange` reports connection and tool-list changes. MCP does not enable Code Mode.

`context.events.emit(channel, data)` sends an application-local event. `context.events.on(channel, listener)` returns an unsubscribe function. Listener errors are reported. The host releases each extension's subscriptions when it unloads. These channels are separate from Durable's committed conversation events.

## Custom messages and entries

`await context.sendMessage({ customType, content, display, details? }, options?)` stores a message that participates in model context. Set `display: false` to hide it in the terminal. Without `triggerTurn`, an idle conversation records the message without calling a model. During a run, the default is steering; `deliverAs: "followUp"` queues a follow-up instead. `triggerTurn: false` uses a write that waits for a safe turn boundary. `deliverAs: "nextTurn"` persists the message until the next user input.

`await context.appendEntry(customType, data?)` stores JSON application data without adding it to model context. Both operations use Durable records and submission queues. Deferred messages use submission identities to avoid duplicate delivery after interruption.

Declare `messageRenderers` and `entryRenderers` as records keyed by `customType`. A presenter receives the stored value, an `expanded` option, and the active theme. A missing message presenter uses the standard custom-message card. A custom entry without a presenter stays hidden. Presenter errors are reported. Returned components are disposed when removed, replaced, or closed.

## Prompt and context information

`await context.getSystemPrompt()` renders the current agent's sections with Durable's section renderer. It includes application instructions, loaded resources, extension sections, and conversation instructions. Section renderers should avoid side effects because a prompt query can render them before a request.

`await context.getContextUsage()` returns estimated tokens, the selected model's context window, and a percentage. It returns `undefined` when limits are unavailable. After compaction, tokens and percentage remain `null` until a successful response reports new usage. Command contexts also expose `getSystemPromptOptions()`.

## Provider request callbacks

`beforeProviderRequest`, `beforeProviderHeaders`, `afterProviderResponse`, and `onProviderStreamEvent` use the existing AI request callbacks. Payload handlers can return a replacement. Header handlers mutate the assembled headers; a `null` value removes a header. Response callbacks receive status and headers. Raw stream callbacks run before the provider normalizes an event.

These callbacks receive a `ProviderContext` with the actual requested model, mode, working directory, request signal, and `abort()`. Cancellation affects that invocation. Callback failures are reported without suppressing other extensions. Removed extensions do not receive later callbacks from an existing request.

`context.registerProvider(provider)` adds or replaces an owned provider contribution. `unregisterProvider(id)` removes that contribution. Unloading the extension restores the preceding provider. Static `providers` declarations remain available.

## Contribute resources

`onResourcesDiscover(context, { cwd, reason })` runs after session startup or reload. Return `skillPaths`, `promptPaths`, or `themePaths` to contribute files or directories. Relative paths resolve against the application working directory. Existing resource names take precedence. Reload replaces previous contributions. The host uses the same readers for configured and contributed resources.

## Resolve project trust

`onProjectTrust(context)` runs only when startup has no explicit or saved trust decision. At this point, injected and global extensions are loaded, but project extensions and project settings are excluded. A project extension cannot approve its own loading.

Return `{ trusted: "yes" | "no" | "undecided", remember?: boolean }`. The first definitive result wins. An undecided result or a reported handler failure falls through to the next policy. When all policies abstain, the host's `resolveProjectTrust` callback can decide. Without a decision, project resources remain disabled. Saved and explicit decisions bypass these callbacks.

The bootstrap context exposes the working directory, application mode, and a restricted UI for selection, confirmation, input and notifications. SDK hosts can provide `trustUI`. Without it, `hasUI` is false. The executable's fallback uses a terminal confirmation before the interactive application starts. Approval reloads settings and resources with project access, while explicit host settings keep precedence. Global modules already loaded during bootstrap are not executed twice.

## Virtual models

Declare `virtualModels` on an extension, or call `context.registerVirtualModel(definition)`. A definition has `provider`, `id`, `name`, optional `thinkingLevels`, `contextWindow`, `maxTokens`, `input`, and a `route(request, context)` callback. A virtual-only provider needs no credentials. A virtual model listed under a physical provider follows that provider's authentication.

The router returns a physical catalog `model` and `thinkingLevel`. It may also return JSON `state`. The request includes the selected virtual model and level, messages, cancellation signal, previous successful response, and failed physical response during retries. Its reason is `user`, `continuation`, `retry`, or `direct`. The callback context provides `models` and `cwd`.

The application preserves the virtual selection in the conversation agent. Durable chooses and records physical request parameters before checking context limits. Router state and the request choice commit together. Automatic compaction reuses that choice; retries can choose again. State survives reopening and follows forks through a rewindable conversation document. Direct `streamSimple` and `completeSimple` calls route without reading or storing branch state. Cross-provider routes remove caller-supplied credentials, headers and environment overrides. Physical output limits cap explicit direct-request output budgets.

A virtual model cannot route to another virtual model. Unavailable or unauthenticated targets fail the request. Reload removes registrations owned by removed extensions. `unregisterVirtualModel(provider, id)` removes the calling extension's contribution. A resumed session whose virtual selection is unavailable falls back to its last successful physical model. The terminal footer shows selection and dispatch separately.

## Prompt cache warming

Set `cacheWarming` to `off`, `streaming`, or `idle` in settings, or run `/settings cacheWarming <mode>`. The default is `streaming`. Streaming mode stops when the agent settles; idle mode can retain the cache afterward. `/session` and application snapshots report its status.

The application captures a real request and can replay its prompt with one output token and no retries before the declared cache lifetime expires. Replays preserve the provider session identity. Models without a declared cache lifetime, disabled caching, and nonadaptive Anthropic budget thinking do not start warming. Refreshes stop after one hour, or thirty minutes in idle mode, and stop when the conversation or model changes. Timers do not keep the process alive. Closing the application cancels pending work.

Default decisions compare the estimated cost of refreshing with the expected savings from retaining the cache. `onCacheWarmingDecision(context, decision)` can return `{ action: "warm" | "stop" }`. Errors are reported and retain the default decision. Warm usage is recorded separately under `cache_warm`, with a display-only accounting entry. A replay never becomes an assistant reply.


## Replace and complete commands

An extension command can replace a built-in command, including its terminal picker. Abort and quit remain reserved. When different extensions declare the same name, all receive distinct invocation names such as `review:1` and `review:2`. The command catalog reports those names. Reload removes aliases from unloaded definitions.

A command may provide `getArgumentCompletions(prefix)` returning TUI autocomplete items, null, or a promise of either. The terminal uses those suggestions before built-in argument suggestions. The handler runs through command interception and receives its owning extension's command context.

## Complete member reference

[Application API](api.md) lists every directly declared application, extension-context and UI member with its signature. Durable extension members are listed in the [Durable API](../../durable/docs/api.md). Public declaration files are included in installed packages.
