import type { ActorControl, ActorRef, EgressPolicyManifest } from "./ateapi.js";
import { sendTurn, type ActorEndpoint, type Reply } from "./turn.js";
import { IdleLifecycle, type Clock } from "./idle.js";

/** `local/chat` -> `pi-local-chat`. Stable, and legal as a Kubernetes name. */
export function actorNameFor(conversationId: string): string {
  const sanitized = conversationId
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return `pi-${sanitized || "conversation"}`;
}

export type Counter = "turns" | "resumed_turns" | "suspends" | "suspend_failures";

export type TurnRunner = (actor: ActorRef, prompt: string) => Promise<Reply>;

export interface GatewayOptions {
  control: ActorControl;
  /** Atespace that holds the actors. */
  atespace: string;
  /** Applied to each new actor; unset applies none. */
  egressPolicy?: EgressPolicyManifest;
  /** Idle window before suspend, shared by every conversation. */
  idleMs: number;
  /** Where turns go. Tests pass `runTurn` instead. */
  endpoint?: ActorEndpoint;
  runTurn?: TurnRunner;
  clock?: Clock;
  log?: (message: string) => void;
}

interface Conversation {
  actor: ActorRef;
  lifecycle: IdleLifecycle;
  /** Turns within one conversation run one at a time. */
  tail: Promise<unknown>;
}

/**
 * Maps each conversation id to its own actor, so a suspend in one cannot take
 * another with it, and runs that conversation's turns in order. The actor is
 * created and its egress policy applied when the conversation first opens.
 */
export class Gateway {
  private readonly options: GatewayOptions;
  private readonly runTurn: TurnRunner;
  private readonly counters = new Map<Counter, number>();
  private readonly conversations = new Map<string, Promise<Conversation>>();

  constructor(options: GatewayOptions) {
    this.options = options;
    const endpoint = options.endpoint;
    this.runTurn =
      options.runTurn ??
      ((actor, prompt) => {
        if (!endpoint) throw new Error("the gateway has no actor endpoint");
        return sendTurn(endpoint, actor, prompt);
      });
  }

  /** Runs one turn and returns its reply to the HTTP caller. */
  async receive(conversationId: string, prompt: string): Promise<Reply> {
    const conversation = await this.open(conversationId);
    const run = conversation.tail.then(() => this.turn(conversation, prompt));
    conversation.tail = run.catch(() => undefined);
    return run;
  }

  /** Counter snapshot for `/metrics`. */
  metrics(): { counters: Partial<Record<Counter, number>> } {
    return { counters: Object.fromEntries(this.counters) };
  }

  async close(): Promise<void> {
    const opened = await Promise.allSettled(this.conversations.values());
    this.conversations.clear();
    for (const entry of opened) {
      if (entry.status !== "fulfilled") continue;
      await entry.value.tail;
      await entry.value.lifecycle.close();
    }
  }

  private async turn(conversation: Conversation, prompt: string): Promise<Reply> {
    const { lifecycle } = conversation;
    const resumed = lifecycle.state === "SUSPENDED" || lifecycle.state === "SUSPENDING";
    lifecycle.turnStarted();
    try {
      return await this.runTurn(conversation.actor, prompt);
    } finally {
      // Settle even on failure, or the in-flight count never drops and the
      // actor is never suspended again.
      lifecycle.turnSettled();
      this.count("turns");
      if (resumed) this.count("resumed_turns");
    }
  }

  /** Opens a conversation on first use; concurrent first messages share the work. */
  private open(conversationId: string): Promise<Conversation> {
    const existing = this.conversations.get(conversationId);
    if (existing) return existing;
    const opening = this.create(conversationId);
    this.conversations.set(conversationId, opening);
    // A failed open is forgotten, so the next message retries it.
    opening.catch(() => this.conversations.delete(conversationId));
    return opening;
  }

  private async create(conversationId: string): Promise<Conversation> {
    const { control, egressPolicy, log } = this.options;
    const actor: ActorRef = { atespace: this.options.atespace, name: actorNameFor(conversationId) };
    await control.ensure(actor);
    if (egressPolicy) await control.applyEgress(actor, egressPolicy);
    log?.(`opened ${conversationId} on ${actor.atespace}/${actor.name}`);
    const lifecycle = new IdleLifecycle({
      actor,
      suspend: (target) => control.suspend(target),
      idleMs: this.options.idleMs,
      clock: this.options.clock,
      count: (name) => this.count(name),
      log: (message) => log?.(`[${conversationId}] ${message}`),
    });
    return { actor, lifecycle, tail: Promise.resolve() };
  }

  private count(name: Counter): void {
    this.counters.set(name, (this.counters.get(name) ?? 0) + 1);
  }
}
