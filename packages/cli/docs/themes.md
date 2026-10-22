# Terminal themes and Markdown

Select `system`, `dark`, or `light` in `/settings`. `system` follows the terminal's reported colors. `/settings theme light` saves a choice. A pair such as `light/dark` follows the terminal's light or dark appearance.

```json
{
  "theme": "light/dark",
  "markdown": { "mermaid": "streaming", "codeBlockIndent": "  " }
}
```

## Adaptive colors

Arc uses its own palette. It takes hues from a complete terminal palette when available, then adjusts text lightness for the reported background and message panels. Body text reaches a contrast ratio of at least 4.5 to 1 on those surfaces. A reported foreground is retained when it is readable. Panel colors fall back to the terminal background if their tint would make text unreadable.

Before the terminal answers its color query, the system theme uses default foregrounds and no panel backgrounds. Without a background report, it uses ANSI colors and faint neutral hints. An appearance change clears the old reports before querying again.

## Add a theme

Place JSON files in `home/themes` or a trusted project's `.arc/themes`. Additional resource directories can contain a `themes` directory. The `themes` setting also accepts explicit files and directories. Relative global paths resolve against the application home; relative project paths resolve against the working directory.

A document contains a unique `name`, optional `appearance` of `light` or `dark`, optional `vars`, and `colors`. Names cannot contain slash characters or replace built-in names. Unknown properties and color roles are errors.

Start with a complete built-in definition:

```ts
import { ThemeCatalog } from "@arc/cli";

const base = new ThemeCatalog().get("dark");
if (!base) throw new Error("Missing built-in theme");
const custom = { ...structuredClone(base.definition), name: "custom" };
custom.vars = { primary: "#00aaff" };
custom.colors.accent = "primary";
// Save JSON.stringify(custom, null, 2) in home/themes/custom.json.
```

Colors accept `#RGB`, `#RRGGBB`, ANSI indices from 0 through 255, `oklch(...)`, `okhsl(...)`, variable names, and an empty string for the terminal default. Variables can reference other variables. Missing variables, circular references, and invalid colors are errors. Colors adapt to truecolor or 256-color terminals.

The definition contains interface, message, tool, Markdown, syntax, and editor color roles. Five roles have fallbacks:

| Optional role | Inherits |
| --- | --- |
| `scrollbarTrack` | `muted` |
| `scrollbarThumb` | `text` |
| `searchMatchBg` | `selectedBg` |
| `searchMatchText` | `text` |
| `thinkingMax` | `thinkingXhigh` |

Run `/reload` after adding a theme. The active theme's directory is watched for saves, including saves that replace the file. An invalid save reports an error and retains the last valid palette. Theme changes preserve the editor draft. Header, footer, and widget factories rebuild with the new theme and release replaced components.

## Render Markdown

Messages support syntax-highlighted code, inline and display LaTeX, and Mermaid diagrams. LaTeX uses terminal characters. Unsupported expressions retain their source.

Mermaid supports flowcharts, sequence diagrams, state diagrams, class diagrams, and entity relationships. `markdown.mermaid` accepts `streaming` to render during generation, `final` to render completed messages, or `off` to keep fenced source. `/settings mermaid final` saves that setting. Diagrams that do not fit the available width retain their source. Invalid diagrams do not replace surrounding text. Thinking blocks keep their original Markdown.

Read and write cards highlight recognized source-file languages. Edit cards color removed and added lines and emphasize changed words in single-line replacements. Code Mode highlights JavaScript, and generic tool arguments use JSON highlighting. Shell commands use Bash highlighting; ordinary shell output and plain text files stay plain. Custom tool renderers control their own formatting. Transcript HTML uses the active terminal theme, or the configured theme in headless operation. Optional `export.pageBg`, `export.cardBg` and `export.infoBg` override page, card and system-message backgrounds. Variables and palette colors resolve to validated CSS colors before export. HTML has its own layout and does not reproduce terminal cells.
