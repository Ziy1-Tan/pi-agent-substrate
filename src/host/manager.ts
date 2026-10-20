import { PiBackend } from "./backend.js";
import type { InboundMessage } from "./conversation/records.js";
import { createConversation, type Conversation } from "./conversation/store.js";
import type { AgentBackend, AgentResponse, Channel } from "./types.js";
import { Gateway } from "./gateway.js";
import { NullChannel } from "./null-channel.js";
import { IdleLifecycle } from "./substrate/idle.js";
import type { ActorRef } from "./substrate/control.js";
import type { ActorProvisioner } from "./substrate/provisioner.js";
import { Metrics } from "../metrics.js";
import { WebSocketTransport } from "./websocket.js";

export interface ConversationSpec {
	conversationId: string;
	idleMs: number;
}

export interface ManagerOptions {
	/** Root of the conversation storage tree. */
	dataDir: string;
	/** Bridge endpoint; the actor is selected by the route header. */
	actorUrl: string;
	actors: ActorProvisioner;
	metrics?: Metrics;
	/** Replaces the actor backend; tests use it to run without a cluster. */
	createBackend?: (conversation: Conversation) => AgentBackend;
	/**
	 * Supplies the channel a turn's reply goes to. Without it the reply is only
	 * returned from `receive`, which is what `POST /messages` does.
	 */
	createChannel?: (conversation: Conversation) => Channel | undefined;
	log?: (message: string) => void;
}

export interface ManagedConversation {
	conversation: Conversation;
	gateway: Gateway;
	/** Where the settled reply is delivered; undefined means the caller's return. */
	outbound: Channel | undefined;
	lifecycle: IdleLifecycle;
	actor: ActorRef;
}

/**
 * Owns one gateway, backend, and lifecycle per conversation, each on the
 * actor the provisioner places it on. Conversations share the control plane
 * and the bridge endpoint but never an actor: a crash or a suspend in one
 * must not take another with it.
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
	async receive(conversationId: string, input: InboundMessage): Promise<AgentResponse> {
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
		const actor = await this.options.actors.provision(spec.conversationId);

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
			control: this.options.actors.control,
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
