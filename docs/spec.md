# Product contracts

## Application and toolkit

The `@arc/cli` package owns the executable and application SDK. Other workspace packages must not depend on it. Durable owns scheduling and durable state. TUI owns terminal primitives. The application connects those primitives to conversation views, commands, menus, and extensions.

## Input and output

Interactive, text, JSON, RPC, and SDK interfaces use the same application runtime. Their input and output contracts differ as described in [interfaces](modes.md). A mode must not claim a terminal capability that it does not provide. RPC basic dialogs do not imply support for custom terminal components.

## Execution

The application exposes local read, write, edit, and shell tools. Tools operate through the configured execution environment. Parallel and sequential settings control scheduling, not tool registration. Tool cancellation and results remain Durable's responsibility.

Code Mode adds a QuickJS script tool and explicit host-call access. It is enabled by default. It can be enabled or disabled while the application is idle. MCP registers tools from configured external servers. MCP and Code Mode do not require one another.

## Extensions

Application extensions use the existing Durable registry and add application behavior through the SDK's typed context. Dynamic registrations belong to an extension owner. Reload and shutdown release resources owned by that extension. Removed owners cannot register new contributions.

Generation, tool, and compaction hooks can influence their documented phases. Runtime events observe committed state. An event with a similar name to an interception hook does not necessarily have the same timing or return contract.

See [extension contracts](../packages/cli/docs/extensions.md) and [application specifications](../packages/cli/docs/spec.md) for available methods, replacement contexts, and cleanup.

## Persistence and trust

Each session has one authoritative storage backend. File-backed application sessions use a process lock. Settings and credential writes are serialized and published by rename. Application uninstall preserves user data.

Project resources load only when the startup trust decision allows them. A session-only choice must not persist a trust decision. Trusting a parent applies the store's canonical-path rules.

## Presentation

Tool cards distinguish pending, success, and failure through theme surfaces. Expanded output text remains plain. Mermaid rendering follows its configured mode. Supported LaTeX expressions become terminal text. Unsupported rendering features use a readable fallback.

Presentation settings must change the actual component or terminal behavior. A menu row without a functioning handler is not a supported setting.

## Verification

The local gate checks package boundaries, builds, TypeScript, owned-test coverage, native checks, worker checks, and installed archives. Coverage includes workspace TypeScript sources and excludes declaration files. Native implementations, subprocess internals, external accounts, and other platforms require separate checks.

A passing gate does not establish 100% code coverage or complete behavioral compatibility. Documentation must distinguish measured results from unverified behavior.
