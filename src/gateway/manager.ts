import { randomUUID } from "node:crypto";

import { PiBackend, type AgentBackend, type AgentResponse } from "./backend.js";
import { IdleLifecycle } from "./substrate/idle.js";
import type { ActorControl, ActorRef } from "./substrate/control.js";
import { WebSocketTransport, type WebSocketTlsOptions } from "./websocket.js";

/** `local/chat` -> `pi-local-chat`. Stable, and legal as a Kubernetes name. */
export function actorNameFor(conversationId: string): string {
  const sanitized = conversationId
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return `pi-${sanitized || "conversation"}`;
}

export interface TurnReport {
  turnMillis: number;
  /** The actor was suspended when this turn arrived. */
  resumed: boolean;
}

export interface ConversationOptions {
  actor: ActorRef;
  backend: AgentBackend;
  lifecycle?: IdleLifecycle;
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
  private readonly lifecycle: IdleLifecycle | undefined;
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
    await this.lifecycle?.close().catch(() => undefined);
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
  control: ActorControl;
  /** Atespace that holds the actors. */
  atespace: string;
  /** Egress policy manifest applied to each new actor; unset disables. */
  egressPolicy?: string;
  /** Idle window before suspend, shared by every conversation. */
  idleMs: number;
  metrics?: Metrics;
  /** Replaces the actor backend; tests use it to run without a cluster. */
  createBackend?: (conversationId: string) => AgentBackend;
  log?: (message: string) => void;
}

/**
 * Owns one conversation per conversation id, each on its own actor: a
 * suspend in one must not take another with it. The actor is created and its
 * egress policy applied when the conversation first opens.
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
  async ensure(conversationId: string): Promise<Conversation> {
    const existing = this.entries.get(conversationId);
    if (existing) return existing;
    const pending = this.opening.get(conversationId);
    if (pending) return pending;
    const created = this.open(conversationId).finally(() => this.opening.delete(conversationId));
    this.opening.set(conversationId, created);
    return created;
  }

  /** Runs one turn and returns its reply to the HTTP caller. */
  async receive(conversationId: string, prompt: string): Promise<AgentResponse> {
    const conversation = await this.ensure(conversationId);
    return conversation.receive(prompt);
  }

  async close(): Promise<void> {
    const entries = [...this.entries.values()];
    this.entries.clear();
    for (const conversation of entries) await conversation.close();
  }

  private async open(conversationId: string): Promise<Conversation> {
    const log = this.options.log ?? (() => undefined);
    const actor: ActorRef = { atespace: this.options.atespace, name: actorNameFor(conversationId) };
    await this.options.control.ensure(actor);
    if (this.options.egressPolicy)
      await this.options.control.applyEgress(actor, this.options.egressPolicy);

    const transport = new WebSocketTransport({
      url: this.options.actorUrl,
      targetActor: `${actor.atespace}/${actor.name}`,
      tls: this.options.transportTls,
      log: (message) => log(`[${conversationId}] ${message}`),
    });
    const backend = this.options.createBackend?.(conversationId) ?? new PiBackend({ transport });

    const lifecycle = new IdleLifecycle({
      actor,
      control: this.options.control,
      idleMs: this.options.idleMs,
      log: (message) => log(`[${conversationId}] ${message}`),
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
    this.entries.set(conversationId, conversation);
    log(`opened ${conversationId} on ${actor.atespace}/${actor.name}`);
    return conversation;
  }
}
