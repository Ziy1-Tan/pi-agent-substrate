import { randomUUID } from "node:crypto";

import { PiBackend, type AgentBackend, type AgentResponse } from "./backend.js";
import { IdleLifecycle } from "./substrate/idle.js";
import type { ActorRef } from "./substrate/control.js";
import type { ActorProvisioner } from "./substrate/provisioner.js";
import { WebSocketTransport, type WebSocketTlsOptions } from "./websocket.js";

export interface ConversationSpec {
	conversationId: string;
	idleMs: number;
}

/** The slice of the idle lifecycle a turn needs. */
export interface TurnLifecycle {
	/** Creates the actor if absent and lets a resume finish before the prompt. */
	ready(): Promise<void>;
	turnStarted(): void;
	turnSettled(): void;
	readonly state: string;
	close?(): Promise<void>;
}

export interface TurnReport {
	turnMillis: number;
	/** The actor was suspended when this turn arrived. */
	resumed: boolean;
}

export interface ConversationOptions {
	actor: ActorRef;
	backend: AgentBackend;
	lifecycle?: TurnLifecycle;
	onTurn?: (report: TurnReport) => void;
}

/**
 * Runs one conversation's turns, one at a time. The reply goes back to the
 * HTTP caller that asked for it, so a failed or interrupted turn is reported
 * to that caller and the next request starts a fresh one.
 */
export class Conversation {
	readonly actor: ActorRef;
	private readonly backend: AgentBackend;
	private readonly lifecycle: TurnLifecycle | undefined;
	private readonly onTurn: ((report: TurnReport) => void) | undefined;
	private tail: Promise<unknown> = Promise.resolve();

	constructor(options: ConversationOptions) {
		this.actor = options.actor;
		this.backend = options.backend;
		this.lifecycle = options.lifecycle;
		this.onTurn = options.onTurn;
	}

	receive(prompt: string): Promise<AgentResponse> {
		const run = this.tail.then(() => this.runTurn(prompt));
		this.tail = run.catch(() => undefined);
		return run;
	}

	async close(): Promise<void> {
		await this.tail.catch(() => undefined);
		await this.backend.close?.().catch(() => undefined);
		await this.lifecycle?.close?.().catch(() => undefined);
	}

	private async runTurn(prompt: string): Promise<AgentResponse> {
		// Read before `ready()`: it may move SUSPENDED to IDLE while it checks
		// the control plane, which would erase the evidence of a resume.
		const resumed = this.lifecycle?.state === "SUSPENDED" || this.lifecycle?.state === "SUSPENDING";
		await this.lifecycle?.ready().catch(() => undefined);
		this.lifecycle?.turnStarted();
		const startedAt = Date.now();
		try {
			return await this.backend.submit({ requestId: randomUUID(), prompt });
		} finally {
			// A failed turn must settle too, or the lifecycle stays ACTIVE and
			// the actor is never suspended again.
			this.lifecycle?.turnSettled();
			this.onTurn?.({ turnMillis: Date.now() - startedAt, resumed });
		}
	}
}

/** Turn and lifecycle counters, enough to see suspends and resumes happen. */
export interface MetricsSnapshot {
	counters: Record<string, number>;
}

export class Metrics {
	private readonly counters = new Map<string, number>();

	increment(name: string, by = 1): void {
		this.counters.set(name, (this.counters.get(name) ?? 0) + by);
	}

	snapshot(): MetricsSnapshot {
		return { counters: Object.fromEntries(this.counters) };
	}
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

/**
 * Owns one conversation per conversation id, each on the actor the
 * provisioner places it on. Conversations share the control plane and the
 * bridge endpoint but never an actor: a suspend in one must not take another
 * with it.
 */
export class GatewayManager {
	private readonly options: ManagerOptions;
	private readonly metrics: Metrics;
	private readonly entries = new Map<string, Conversation>();
	private readonly opening = new Map<string, Promise<Conversation>>();

	constructor(options: ManagerOptions) {
		this.options = options;
		this.metrics = options.metrics ?? new Metrics();
	}

	getMetrics(): Metrics {
		return this.metrics;
	}

	/** Opens a conversation on first use; concurrent callers share the work. */
	async ensure(spec: ConversationSpec): Promise<Conversation> {
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
		const conversation = await this.ensure(spec);
		return conversation.receive(prompt);
	}

	async close(): Promise<void> {
		const entries = [...this.entries.values()];
		this.entries.clear();
		for (const conversation of entries) await conversation.close();
	}

	private async open(spec: ConversationSpec): Promise<Conversation> {
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

		const conversation = new Conversation({
			actor,
			backend,
			lifecycle,
			onTurn: (report) => {
				this.metrics.increment("turns");
				if (report.resumed) this.metrics.increment("resumed_turns");
			},
		});
		this.entries.set(spec.conversationId, conversation);
		log(`opened ${spec.conversationId} on ${actor.atespace}/${actor.name}`);
		return conversation;
	}
}
