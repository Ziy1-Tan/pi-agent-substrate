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

export function isMessageEnd(value: unknown): boolean {
	return isObject(value) && value.type === "message_end";
}

export function isTextDelta(value: unknown): value is { assistantMessageEvent: { delta: string } } {
	if (!isObject(value) || value.type !== "message_update") return false;
	const event = value.assistantMessageEvent;
	return isObject(event) && event.type === "text_delta" && typeof event.delta === "string";
}

export function isAgentSettled(value: unknown): boolean {
	return isObject(value) && value.type === "agent_settled";
}

/** True for the `message_end` of an assistant message, successful or not. */
export function isAssistantMessageEnd(value: unknown): boolean {
	if (!isMessageEnd(value)) return false;
	const message = (value as Record<string, unknown>).message;
	return isObject(message) && message.role === "assistant";
}

/** The text of a completed assistant message, or undefined for any other record. */
export function assistantText(value: unknown): string | undefined {
	if (!isMessageEnd(value)) return undefined;
	const message = (value as Record<string, unknown>).message;
	if (!isObject(message) || message.role !== "assistant" || !Array.isArray(message.content)) return undefined;
	return message.content
		.filter((block): block is { text: string } => isObject(block) && typeof block.text === "string")
		.map((block) => block.text)
		.join("");
}

/**
 * Why the assistant turn failed, or undefined when it ended normally.
 *
 * Pi reports provider failures as an assistant message with `stopReason:
 * "error"` carrying the provider's own text in `errorMessage`. Without this,
 * a failed turn looks like a turn that produced nothing: the gateway records
 * an empty reply and the user sees silence.
 */
export function assistantError(value: unknown): string | undefined {
	if (!isMessageEnd(value)) return undefined;
	const message = (value as Record<string, unknown>).message;
	if (!isObject(message) || message.role !== "assistant") return undefined;
	const stopReason = message.stopReason;
	if (stopReason !== "error") return undefined;
	const text = message.errorMessage;
	return typeof text === "string" && text.length > 0 ? text : "the model request failed";
}

/**
 * The final error of an exhausted retry loop, or undefined while retrying or
 * after a retry that succeeded.
 *
 * `auto_retry_end` with `success: false` is Pi saying it will not try again.
 * It carries the last provider error, which is more specific than the final
 * assistant message when the provider never answered at all.
 */
export function retryFailure(value: unknown): string | undefined {
	if (!isObject(value) || value.type !== "auto_retry_end" || value.success !== false) return undefined;
	const text = value.finalError;
	return typeof text === "string" && text.length > 0 ? text : "the model request failed after retries";
}

function isObject(value: unknown): value is Record<string, any> {
	return typeof value === "object" && value !== null;
}
