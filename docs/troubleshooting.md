# Troubleshoot Arc

## No models appear

Use `/login` and choose a model when the picker opens. Cancelling the picker keeps the current selection. Use `/model` to choose later. `arc --list-models` lists catalog entries, which does not guarantee that your account can use each model. Provider network access, account permissions, and model availability require live checks.

Credentials are stored in `~/.arc/auth.json` by default. Do not paste that file or tokens into a bug report.

## OAuth does not finish

Start a new login attempt. Browser login opens the complete authorization URL through the operating system. If the launcher fails, Arc prints a warning and retains the URL for manual use. Login panels and notices use explicit terminal hyperlinks so a wrapped label retains the complete authorization URL. A copied URL must still include every query parameter. Open the current attempt's full URL; do not reuse a partial or expired authorization link.

A server-side authorization rejection is different from a browser-launch failure. Record the error code and the selected provider, without sharing authorization codes, callback URLs, or tokens. A successful local test does not prove that the provider currently accepts the request.

## MCP shows no connected servers

MCP is not configured automatically. Add `mcpServers` to your global settings or trusted project settings. Restart Arc after editing the definitions. `/mcp` shows connection status and tool counts. `/mcp connect <name>` and `/mcp disconnect <name>` control servers already present in loaded settings.

Code Mode does not need MCP. Turning Code Mode on does not create MCP connections.

## Code Mode is unavailable

Use `/settings` to enable Code Mode. Wait for active work to finish before changing it. An explicit active-tool selection can exclude a registered tool. `/tools` shows the active model tools.

## Tool output has no color

Tool cards use theme surfaces for pending, success, and error states. Expanded output text stays plain. The system theme depends on terminal color information. Select the dark or light theme if the terminal does not report its colors. A terminal with limited color support can show fewer distinctions.

## Mermaid or math stays as source

Mermaid has streaming, final, and off modes in settings. Unsupported syntax and blocks too wide for the available terminal width retain their source. Mathematical notation uses the terminal renderer's supported LaTeX subset. Unsupported expressions retain a readable fallback. Arc does not run a complete TeX engine.

## Project resources do not load

Project `.arc` settings and executable extensions require trust. The startup selector can save a decision, apply one for the current session, or trust the parent directory. Escape declines for the current run. `/trust` reports the current state. Saved trust changes apply on restart.

## A session cannot open

Close another process using that session first. File-backed sessions have an application lock. Preserve the session data before investigating a lock or storage error. Do not delete a database or JSONL directory as a repair step.

## Report a defect

Include `arc --version`, operating system, terminal, mode, backend, reproduction steps, and sanitized error text. State whether extensions or a custom theme are enabled. Remove credentials, private prompts, and sensitive file contents from logs.
