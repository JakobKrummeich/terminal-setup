import * as piAi from "@earendil-works/pi-ai";

interface ProviderContext {
	systemPrompt?: string;
	tools?: unknown[];
	messages?: any[];
}

const optionalPiAi = piAi as Record<string, unknown>;

/** Provider context compatibility: Pi <=0.86 fields vs 0.87 transcript system messages. */
export function currentSystemPrompt(context: ProviderContext | undefined): string {
	const getCurrentSystemPrompt = optionalPiAi.getCurrentSystemPrompt;
	if (typeof getCurrentSystemPrompt === "function") {
		return String(getCurrentSystemPrompt(context?.messages ?? []));
	}
	return String(context?.systemPrompt ?? "");
}

/** Resolve current tools without statically importing Pi 0.87-only exports. */
export function currentTools(context: ProviderContext | undefined): any[] {
	const getCurrentTools = optionalPiAi.getCurrentTools;
	if (typeof getCurrentTools === "function") {
		return getCurrentTools(context?.messages ?? []) as any[];
	}
	return context?.tools ?? [];
}

/** Conversation messages only; Pi 0.87's leading system transcript entry is transport metadata. */
export function conversationMessages(context: ProviderContext | undefined): any[] {
	const messages = context?.messages ?? [];
	const withoutInitialSystemMessage = optionalPiAi.withoutInitialSystemMessage;
	if (typeof withoutInitialSystemMessage === "function") {
		return withoutInitialSystemMessage(messages) as any[];
	}
	return messages;
}
