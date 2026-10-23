import { defineDoc, type ConversationId } from "@arc/durable";

export const SessionInfo = defineDoc<{ name: string; conversationId?: ConversationId; parentSession?: string }>({
	kind: "arc.session",
	scope: "session",
	version: 1,
	initial: () => ({ name: "" }),
	checkpointWhen: () => false,
});
