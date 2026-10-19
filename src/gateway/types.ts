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
	/**
	 * Tells the user the turn failed. Without it a provider outage looks like
	 * an agent that answered with nothing.
	 */
	sendError?(delivery: OutboundDelivery): Promise<string | undefined>;
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
	/**
	 * Set when the turn failed. The gateway records a failed job and delivers
	 * the message to the user, instead of sending an empty reply.
	 */
	error?: string;
}

export type AgentEventListener = (delta: string) => void;

export interface AgentBackend {
	/**
	 * Must be idempotent per requestId: retrying after a gateway crash returns
	 * the same turn's result instead of executing it again.
	 */
	submit(request: AgentRequest, onDelta: AgentEventListener): Promise<AgentResponse>;
	/** Stops an in-flight turn, if the backend can. The turn rejects. */
	cancel?(requestId: string): void;
	/** Discards the running conversation inside the actor. */
	newSession?(): Promise<void>;
}

export type GatewayHookPoint =
	| "beforeSubmit"
	| "afterSubmit"
	| "afterResponse"
	| "afterChannelSend"
	| "afterOutbound";

export type GatewayHooks = Partial<Record<GatewayHookPoint, () => void | Promise<void>>>;

/** Timing and state the gateway reports after each turn. */
export interface TurnReport {
	requestId: string;
	/** Wall time from dispatch to the settled response. */
	turnMillis: number;
	/** Wall time from dispatch to the first streamed delta, when one arrived. */
	firstTokenMillis?: number;
	/** True when the turn started from a suspended actor. */
	resumed: boolean;
}

export interface GatewayOptions {
	conversation: ResolvedConversation;
	channel: Channel;
	backend: AgentBackend;
	/**
	 * Optional idle-suspend controller. The gateway only reports turn
	 * boundaries to it; the controller decides when the actor may sleep.
	 */
	lifecycle?: Pick<IdleLifecycle, "turnStarted" | "turnSettled" | "ready" | "state">;
	onTurn?: (report: TurnReport) => void;
	hooks?: GatewayHooks;
	ownerId?: string;
}

export type { InboundMessageInput };
