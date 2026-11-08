import { PiBackend } from "./backend.js";
import { Gateway } from "./gateway.js";
import { Metrics } from "./metrics.js";
import { IdleLifecycle } from "./substrate/idle.js";
import type { ActorRef } from "./substrate/control.js";
import type { ActorProvisioner } from "./substrate/provisioner.js";
import type { AgentBackend, AgentResponse } from "./types.js";
import { WebSocketTransport, type WebSocketTlsOptions } from "./websocket.js";

export interface ConversationSpec {
	conversationId: string;
	idleMs: number;
}

export interface ManagerOptions {
	/** Bridge endpoint; the actor is selected by the route header. */
	actorUrl: string;
	/** TLS settings for the router when actorUrl is wss. */
	transportTls?: WebSocketTlsOptions;
	actors: ActorProvisioner;
	metrics?: Metrics;
	/** Replaces the actor backend; tests use it to run without a cluster. */
	createBackend?: (conversationId: string) => AgentBackend;
	log?: (message: string) => void;
}

export interface ManagedConversation {
	conversationId: string;
	actor: ActorRef;
	lifecycle: IdleLifecycle;
	gateway: Gateway;
	backend: AgentBackend;
}

/**
 * Owns one gateway and lifecycle per conversation, each on the actor the
 * provisioner places it on. Conversations share the control plane and the
 * bridge endpoint but never an actor: a suspend in one must not take another
 * with it.
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

	/** Runs one turn and returns its reply to the HTTP caller. */
	async receive(spec: ConversationSpec, prompt: string): Promise<AgentResponse> {
		const entry = await this.ensure(spec);
		return entry.gateway.receive(prompt);
	}

	async close(): Promise<void> {
		const entries = [...this.entries.values()];
		this.entries.clear();
		for (const entry of entries) {
			await entry.gateway.stop().catch(() => undefined);
			await entry.lifecycle.close().catch(() => undefined);
			await entry.backend.close?.().catch(() => undefined);
		}
	}

	private async open(spec: ConversationSpec): Promise<ManagedConversation> {
		const log = this.options.log ?? (() => undefined);
		const actor = await this.options.actors.provision(spec.conversationId);

		const transport = new WebSocketTransport({
			url: this.options.actorUrl,
			targetActor: `${actor.atespace}/${actor.name}`,
			tls: this.options.transportTls,
			log: (message) => log(`[${spec.conversationId}] ${message}`),
		});
		const backend = this.options.createBackend?.(spec.conversationId) ?? new PiBackend({ transport });

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
			backend,
			lifecycle,
			onTurn: (report) => {
				this.metrics.increment("turns");
				if (report.resumed) this.metrics.increment("resumed_turns");
			},
		});

		const entry: ManagedConversation = {
			conversationId: spec.conversationId,
			actor,
			lifecycle,
			gateway,
			backend,
		};
		this.entries.set(spec.conversationId, entry);
		log(`opened ${spec.conversationId} on ${actor.atespace}/${actor.name}`);
		return entry;
	}
}
