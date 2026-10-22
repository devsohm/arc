import { hyperlink, stripTerminalSequences } from "@arc/tui";

export function plainText(text: string): string {
	if (!/[\x00-\x08\x0b-\x1f\x7f-\x9f]/.test(text)) return text;
	return stripTerminalSequences(text)
		.replace(/\r\n?/g, "\n")
		.replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "");
}

export function linkifyUrls(text: string): string {
	return plainText(text).replace(/https?:\/\/[^\s<>"']+/g, (value) => {
		try {
			return hyperlink(value, new URL(value).href);
		} catch {
			return value;
		}
	});
}
