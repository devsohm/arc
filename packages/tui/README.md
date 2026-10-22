# @arc/tui

TUI owns terminal rendering, layout, input, a multiline editor, completion, overlays, Markdown, supported LaTeX notation, images, and color utilities. It has no Durable dependency. Agent messages, tool cards, commands, and application themes belong to the application that uses it.

## Example

```js
import { matchesKey, ProcessTerminal, Text, TuiMainScreen } from "@arc/tui";

const ui = new TuiMainScreen(new ProcessTerminal());
ui.addChild(new Text("Arc terminal. Press Ctrl+C to exit.", 0, 0));
ui.addInputListener((data) => {
	if (matchesKey(data, "ctrl+c")) {
		ui.stop();
		return { consume: true };
	}
});
ui.start();
```

## Reference

- [Package specification](docs/spec.md)

- [Connect Durable to a UI](docs/durable-connection.md)
- [Native terminal helpers](native/README.md)

[API reference](docs/api.md)
