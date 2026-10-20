import { PiBackend } from "../actor/backend.js";
import type { ResolvedConversation } from "../../third_party/pi-chat/types.js";
import type { AgentBackend, AgentResponse, Channel, InboundMessageInput } from "./types.js";
import { createConversation } from "./conversations.js";
import { Gateway } from "./gateway.js";
import { NullChannel } from "./null-channel.js";
import { IdleLifecycle } from "../lifecycle/idle.js";
import type { ActorControl, ActorRef } from "../lifecycle/control.js";
import { Metrics } from "../metrics.js";
import { WebSocketTransport } from "../actor/websocket.js";

export interface ConversationSpec {
	conversationId: string;
	atespace: string;
	/** Template used when the conversation's actor does not exist yet. */
	template: string;
	idleMs: number;
}

export interface ManagerOptions {
	/** Root of the conversation storage tree. */
	dataDir: string;
	/** Bridge endpoint; the actor is selected by the route header. */
	actorUrl: string;
	control: ActorControl;
	metrics?: Metrics;
	/**
	 * Gives a freshly created actor its egress rules. Egress policies are
	 * per-actor, so an actor created without one cannot reach the model and
	 * every turn fails with an empty reply.
	 */
	provision?: (actor: ActorRef) => Promise<void>;
	/** Replaces the actor backend; tests use it to run without a cluster. */
	createBackend?: (conversation: ResolvedConversation) => AgentBackend;
	/**
	 * Supplies the channel a turn's reply goes to. Without it the reply is only
	 * returned from `receive`, which is what `POST /messages` does.
	 */
	createChannel?: (conversation: ResolvedConversation) => Channel | undefined;
	log?: (message: string) => void;
}

export interface ManagedConversation {
	conversation: ResolvedConversation;
	gateway: Gateway;
	/** Where the settled reply is delivered; undefined means the caller's return. */
	outbound: Channel | undefined;
	lifecycle: IdleLifecycle;
	actor: ActorRef;
}

/** `local/chat` -> `pi-local-chat`. Stable, and legal as a Kubernetes name. */
export function actorNameFor(conversationId: string): string {
	const sanitized = conversationId
		.toLowerCase()
		.replace(/[^a-z0-9-]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 40);
	return `pi-${sanitized || "conversation"}`;
}

/**
 * Owns one gateway, backend, and lifecycle per conversation, and maps each
 * conversation deterministically to its own actor. Conversations share the
 * control plane and the bridge endpoint but never an actor: a crash or a
 * suspend in one must not take another with it.
 *
 * Failures are contained per conversation. A broken conversation reports its
 * error and stops, while the others keep processing turns.
 */
export class GatewayManager {
	private readonly options: ManagerOptions;
	private readonly metrics: Metrics;
	private readonly entries = new Map<string, ManagedConversation>();
	private readonly opening = new Map<string, Promise<ManagedConversation>>();

	constructor(options: ManagerOptions) {
		this.options = options;
		this.metrics = options.metrics ?? new Metrics();
	}

	getMetrics(): Metrics {
		return this.metrics;
	}

	/** The conversation's outbound channel, once it is open. */
	get(conversationId: string): Channel | undefined {
		return this.entries.get(conversationId)?.outbound;
	}

	/** Opens a conversation on first use; concurrent callers share the work. */
	async ensure(spec: ConversationSpec): Promise<ManagedConversation> {
		const existing = this.entries.get(spec.conversationId);
		if (existing) return existing;
		const pending = this.opening.get(spec.conversationId);
		if (pending) return pending;
		const created = this.open(spec).finally(() => this.opening.delete(spec.conversationId));
		this.opening.set(spec.conversationId, created);
		return created;
	}

	/**
	 * Queues one message and resolves with that message's own reply. The reply
	 * reaches a chat adapter when the conversation has one, and either way it is
	 * returned here.
	 */
	async receive(conversationId: string, input: InboundMessageInput): Promise<AgentResponse> {
		const entry = this.entries.get(conversationId);
		if (!entry) throw new Error(`unknown conversation: ${conversationId}`);
		return entry.gateway.receive(input);
	}

	async close(): Promise<void> {
		const entries = [...this.entries.values()];
		this.entries.clear();
		for (const entry of entries) {
			await entry.gateway.stop().catch(() => undefined);
			await entry.lifecycle.close().catch(() => undefined);
		}
	}

	private async open(spec: ConversationSpec): Promise<ManagedConversation> {
		const log = this.options.log ?? (() => undefined);
		const conversation = await createConversation(this.options.dataDir, spec.conversationId);
		const actor: ActorRef = { atespace: spec.atespace, name: actorNameFor(spec.conversationId) };

		// Create-if-absent before the first turn: a gateway may be started for a
		// conversation whose actor has never existed, and the router only
		// resumes actors that do.
		await this.options.control.ensure({ atespace: spec.atespace, name: actor.name });
		await this.options.provision?.(actor);

		const outbound = this.options.createChannel?.(conversation);
		const transport = new WebSocketTransport({
			url: this.options.actorUrl,
			targetActor: `${actor.atespace}/${actor.name}`,
			log: (message) => log(`[${spec.conversationId}] ${message}`),
		});
		const backend =
			this.options.createBackend?.(conversation) ?? new PiBackend({ transport });

		const lifecycle = new IdleLifecycle({
			actor,
			control: this.options.control,
			idleMs: spec.idleMs,
			log: (message) => log(`[${spec.conversationId}] ${message}`),
			onEvent: (event) => {
				if (event.reason === "suspend_requested") this.metrics.increment("suspends");
				if (event.reason === "idle_elapsed") this.metrics.increment("idle_windows");
				if (event.reason === "suspend_failed") this.metrics.increment("suspend_failures");
			},
		});

		const gateway = new Gateway({
			conversation,
			channel: outbound ?? new NullChannel(),
			backend,
			lifecycle,
			onTurn: (report) => {
				this.metrics.increment("turns");
				this.metrics.observe("turn_millis", report.turnMillis);
				if (report.firstTokenMillis !== undefined) {
					this.metrics.observe("first_token_millis", report.firstTokenMillis);
				}
				if (report.resumed) {
					this.metrics.increment("resumed_turns");
					// Resume latency is what a user feels: prompt to first token.
					this.metrics.observe("resume_millis", report.firstTokenMillis ?? report.turnMillis);
				}
			},
		});
		await gateway.start();

		const entry: ManagedConversation = { conversation, gateway, outbound, lifecycle, actor };
		this.entries.set(spec.conversationId, entry);
		log(`opened ${spec.conversationId} on ${actor.atespace}/${actor.name}`);
		return entry;
	}
}