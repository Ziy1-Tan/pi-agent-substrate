import type { ActorRef } from "./ateapi.js";

export type IdleState = "IDLE" | "ACTIVE" | "GRACE" | "SUSPENDING" | "SUSPENDED";

/** Injectable timers so idle timing can be tested without sleeping. */
export interface Clock {
  schedule(callback: () => void, delayMs: number): unknown;
  cancel(handle: unknown): void;
}

export const systemClock: Clock = {
  schedule: (callback, delayMs) => {
    const timer = setTimeout(callback, delayMs);
    timer.unref?.();
    return timer;
  },
  cancel: (handle) => clearTimeout(handle as NodeJS.Timeout),
};

export interface IdleLifecycleOptions {
  actor: ActorRef;
  suspend: (actor: ActorRef) => Promise<void>;
  /** How long the actor must be idle after a settled turn before suspending; 0 disables. */
  idleMs: number;
  clock?: Clock;
  count?: (name: "suspends" | "suspend_failures") => void;
  log?: (message: string) => void;
}

/**
 * The per-conversation lifecycle:
 *
 *   IDLE -prompt-> ACTIVE -settled-> GRACE -idle-> SUSPENDING -done-> SUSPENDED
 *   GRACE/SUSPENDING -prompt-> ACTIVE (the timer is cancelled; the router
 *   resumes the actor when the next turn connects)
 *
 * The one rule that matters most: a suspend is never issued while a turn is in
 * flight, because substrate's suspend cancels in-flight work rather than
 * draining it. `turnSettled()` is the only entry to GRACE, and `turnStarted()`
 * always leaves it.
 */
export class IdleLifecycle {
  private readonly options: IdleLifecycleOptions;
  private readonly clock: Clock;
  private readonly log: (message: string) => void;

  private current: IdleState = "IDLE";
  /** Turns started but not yet settled. */
  private inflight = 0;
  private timer: unknown;
  private suspending: Promise<void> | undefined;

  constructor(options: IdleLifecycleOptions) {
    this.options = options;
    this.clock = options.clock ?? systemClock;
    this.log = options.log ?? (() => undefined);
  }

  get state(): IdleState {
    return this.current;
  }

  /** A prompt was accepted for this conversation. Cancels any pending suspend. */
  turnStarted(): void {
    this.inflight += 1;
    this.cancelTimer();
    this.current = "ACTIVE";
  }

  /** A turn ended, successfully or not. This is the only path into GRACE. */
  turnSettled(): void {
    this.inflight = Math.max(0, this.inflight - 1);
    if (this.current !== "ACTIVE" || this.inflight > 0) return;
    this.current = "GRACE";
    this.armTimer();
  }

  async close(): Promise<void> {
    this.cancelTimer();
    await this.suspending?.catch(() => undefined);
  }

  private armTimer(): void {
    this.cancelTimer();
    if (this.options.idleMs <= 0) return;
    this.timer = this.clock.schedule(() => {
      this.timer = undefined;
      void this.onIdle();
    }, this.options.idleMs);
  }

  private cancelTimer(): void {
    if (this.timer === undefined) return;
    this.clock.cancel(this.timer);
    this.timer = undefined;
  }

  private async onIdle(): Promise<void> {
    if (this.current !== "GRACE" || this.inflight > 0) return;
    const { actor } = this.options;
    this.current = "SUSPENDING";
    this.options.count?.("suspends");
    this.suspending = this.options
      .suspend(actor)
      .then(() => {
        // A prompt that raced the suspend owns the actor now; keep it ACTIVE.
        if (this.current === "SUSPENDING") this.current = "SUSPENDED";
        this.log(`suspended ${actor.atespace}/${actor.name} after the idle window`);
      })
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        this.options.count?.("suspend_failures");
        this.log(`suspend ${actor.name} failed: ${message}; retrying after the idle window`);
        if (this.current === "SUSPENDING") {
          this.current = "GRACE";
          this.armTimer();
        }
      })
      .finally(() => {
        this.suspending = undefined;
      });
    await this.suspending;
  }
}
