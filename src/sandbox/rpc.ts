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

/** The `message_end` of an assistant message, successful or not. */
function assistantMessage(value: unknown): Record<string, any> | undefined {
	if (!isObject(value) || value.type !== "message_end") return undefined;
	const message = value.message;
	return isObject(message) && message.role === "assistant" ? message : undefined;
}

export interface AssistantOutcome {
	/** The text of the finished message; absent when it produced none. */
	text?: string;
	/** Why the turn failed; absent when the message ended normally. */
	error?: string;
}

/**
 * The outcome of a finished assistant message, or undefined for any other
 * record. Text and failure come from the same message: Pi reports a provider
 * error as an assistant message with `stopReason: "error"` and the provider's
 * own text in `errorMessage`, so reading one without the other makes a failed
 * turn indistinguishable from one that produced no text.
 */
export function assistantOutcome(value: unknown): AssistantOutcome | undefined {
	const message = assistantMessage(value);
	if (!message) return undefined;
	const text = Array.isArray(message.content)
		? message.content
				.filter((block: unknown): block is { text: string } => isObject(block) && typeof block.text === "string")
				.map((block: { text: string }) => block.text)
				.join("")
		: "";
	const failure = typeof message.errorMessage === "string" ? message.errorMessage : "";
	const error = message.stopReason === "error" ? failure || "the model request failed" : undefined;
	return error === undefined ? { text } : { text: "", error };
}

/**
 * The final error of an exhausted retry loop. `auto_retry_end` with
 * `success: false` is Pi saying it will not try again, and its `finalError` is
 * more specific than the last assistant message when the provider never
 * answered at all.
 */
export function retryFailure(value: unknown): string | undefined {
	if (!isObject(value) || value.type !== "auto_retry_end" || value.success !== false) return undefined;
	const text = value.finalError;
	return typeof text === "string" && text.length > 0 ? text : "the model request failed after retries";
}

function isObject(value: unknown): value is Record<string, any> {
	return typeof value === "object" && value !== null;
}
