import type { InboundMessageInput, ResolvedConversation } from "../../third_party/pi-chat/types.js";
import type { IdleLifecycle } from "../lifecycle/idle.js";

export type Checkpoint = { cursor?: string; messageId?: string };

export interface OutboundDelivery {
	/** Stable per turn. Channels may use it to suppress a retried delivery. */
	deliveryId: string;
	text: string;
	replyToMessageId?: string;
}

export interface Channel {
	send(delivery: OutboundDelivery): Promise<string | undefined>;
	syncPreview(text: string): Promise<void>;
	clearPreview(): Promise<void>;
}

export interface AgentRequest {
	requestId: string;
	conversationId: string;
	prompt: string;
}

export interface AgentResponse {
	text: string;
}

export type AgentEventListener = (delta: string) => void;

export interface AgentBackend {
	/**
	 * Must be idempotent per requestId: retrying after a gateway crash returns
	 * the same turn's result instead of executing it again.
	 */
	submit(request: AgentRequest, onDelta: AgentEventListener): Promise<AgentResponse>;
}

export type GatewayHookPoint =
	| "beforeSubmit"
	| "afterSubmit"
	| "afterResponse"
	| "afterChannelSend"
	| "afterOutbound";

export type GatewayHooks = Partial<Record<GatewayHookPoint, () => void | Promise<void>>>;

export interface GatewayOptions {
	conversation: ResolvedConversation;
	channel: Channel;
	backend: AgentBackend;
	/**
	 * Optional idle-suspend controller. The gateway only reports turn
	 * boundaries to it; the controller decides when the actor may sleep.
	 */
	lifecycle?: Pick<IdleLifecycle, "turnStarted" | "turnSettled" | "ready">;
	hooks?: GatewayHooks;
	ownerId?: string;
}

export type { InboundMessageInput };
