/**
 * The slice of Pi's RPC protocol this project reads. Events outside it are
 * forwarded untouched, so a newer Pi can add records without breaking the
 * relay. Pi is pinned in package.json (`piVersion`); run the clustered smoke
 * before moving it.
 */

export interface RpcCommand {
	type: string;
	id?: string;
	[key: string]: unknown;
}

export interface RpcState {
	isStreaming?: boolean;
	sessionId?: string;
	sessionFile?: string;
	messageCount?: number;
	pendingMessageCount?: number;
}

export function isRpcResponse(value: unknown): value is { type: "response"; command: string; success: boolean; data?: unknown } {
	return isObject(value) && value.type === "response" && typeof value.command === "string";
}

export function isTextDelta(value: unknown): value is { assistantMessageEvent: { delta: string } } {
	if (!isObject(value) || value.type !== "message_update") return false;
	const event = value.assistantMessageEvent;
	return isObject(event) && event.type === "text_delta" && typeof event.delta === "string";
}

export function isAgentSettled(value: unknown): boolean {
	return isObject(value) && value.type === "agent_settled";
}

/** The text of a completed assistant message, or undefined for any other record. */
export function assistantText(value: unknown): string | undefined {
	if (!isObject(value) || value.type !== "message_end") return undefined;
	const message = value.message;
	if (!isObject(message) || message.role !== "assistant" || !Array.isArray(message.content)) return undefined;
	return message.content
		.filter((block): block is { text: string } => isObject(block) && typeof block.text === "string")
		.map((block) => block.text)
		.join("");
}

function isObject(value: unknown): value is Record<string, any> {
	return typeof value === "object" && value !== null;
}
