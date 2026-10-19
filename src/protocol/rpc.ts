/**
 * The subset of Pi's RPC protocol this project depends on, pinned by the Pi
 * version declared in `package.json` (`piVersion`). Anything outside this set
 * is forwarded untouched, so a newer Pi can add events without breaking the
 * relay; commands are the contract and are listed in `SUPPORTED_COMMANDS`.
 */

export const PI_VERSION = "0.84.2";

export const SUPPORTED_COMMANDS = [
	"prompt",
	"get_state",
	"get_messages",
	"abort",
	"new_session",
	"compact",
	"set_model",
	"set_thinking_level",
] as const;

export type SupportedCommand = (typeof SUPPORTED_COMMANDS)[number];

export interface RpcCommand {
	type: SupportedCommand | string;
	id?: string;
	[key: string]: unknown;
}

export interface RpcResponse {
	type: "response";
	command: string;
	success: boolean;
	id?: string;
	data?: unknown;
	error?: string;
}

export interface RpcTextDelta {
	type: "message_update";
	assistantMessageEvent: {
		type: "text_delta";
		delta: string;
		contentIndex?: number;
	};
}

export interface RpcAgentSettled {
	type: "agent_settled";
}

export interface RpcMessageEnd {
	type: "message_end";
	message: {
		role: string;
		content?: Array<{ type: string; text?: string }>;
	};
}

export interface RpcState {
	isStreaming: boolean;
	sessionId?: string;
	sessionFile?: string;
	messageCount?: number;
	pendingMessageCount?: number;
}

/** Extension messages the bridge adds on top of Pi's own event stream. */
export interface BridgeResult {
	type: "bridge_result";
	requestId: string;
	text: string;
	replayed: boolean;
}

export interface BridgeState {
	type: "bridge_state";
	requestId?: string;
	streaming: boolean;
	piPid?: number;
}

export function isRpcResponse(value: unknown): value is RpcResponse {
	return isObject(value) && value.type === "response" && typeof value.command === "string";
}

export function isTextDelta(value: unknown): value is RpcTextDelta {
	if (!isObject(value) || value.type !== "message_update") return false;
	const event = value.assistantMessageEvent;
	return isObject(event) && event.type === "text_delta" && typeof event.delta === "string";
}

export function isAgentSettled(value: unknown): value is RpcAgentSettled {
	return isObject(value) && value.type === "agent_settled";
}

export function assistantText(value: unknown): string | undefined {
	if (!isObject(value) || value.type !== "message_end") return undefined;
	const message = value.message;
	if (!isObject(message) || message.role !== "assistant") return undefined;
	const content = message.content;
	if (!Array.isArray(content)) return undefined;
	return content
		.filter((block): block is { type: string; text: string } => isObject(block) && typeof block.text === "string")
		.map((block) => block.text)
		.join("");
}

function isObject(value: unknown): value is Record<string, any> {
	return typeof value === "object" && value !== null;
}
