import type { Reply } from "../../src/gateway/turn.js";
import type { ActorControl, ActorRef } from "../../src/gateway/ateapi.js";
import type { Clock } from "../../src/gateway/idle.js";

/** A clock tests advance by hand. */
export class FakeClock implements Clock {
  private time = 0;
  private next = 1;
  private readonly timers = new Map<number, { at: number; callback: () => void }>();

  schedule(callback: () => void, delayMs: number): unknown {
    const id = this.next++;
    this.timers.set(id, { at: this.time + delayMs, callback });
    return id;
  }

  cancel(handle: unknown): void {
    this.timers.delete(handle as number);
  }

  /** Advances time, firing due timers in order and letting their handlers run. */
  async advance(ms: number): Promise<void> {
    const target = this.time + ms;
    for (;;) {
      const due = [...this.timers.entries()]
        .filter(([, timer]) => timer.at <= target)
        .sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      this.timers.delete(due[0]);
      this.time = due[1].at;
      due[1].callback();
      await new Promise((resolve) => setImmediate(resolve));
    }
    this.time = target;
  }

  get pending(): number {
    return this.timers.size;
  }
}

/** Records control calls; a suspend can be held open or made to fail. */
export class FakeControl implements ActorControl {
  readonly calls: string[] = [];
  failSuspend: Error | undefined;
  private hold = false;
  private release: (() => void) | undefined;

  get suspends(): number {
    return this.calls.filter((call) => call.startsWith("suspend")).length;
  }

  async ensure(actor: ActorRef): Promise<void> {
    this.calls.push(`ensure ${actor.name}`);
  }

  async applyEgress(actor: ActorRef): Promise<void> {
    this.calls.push(`egress ${actor.name}`);
  }

  async suspend(actor: ActorRef): Promise<void> {
    this.calls.push(`suspend ${actor.name}`);
    if (this.failSuspend) throw this.failSuspend;
    if (this.hold) {
      this.hold = false;
      await new Promise<void>((resolve) => (this.release = resolve));
    }
  }

  holdNextSuspend(): void {
    this.hold = true;
  }

  releaseSuspend(): void {
    this.release?.();
    this.release = undefined;
  }
}

/** Answers every turn with the prompt, optionally after a delay. */
export function echoTurn(delayMs = 0) {
  return async (_actor: ActorRef, prompt: string): Promise<Reply> => {
    if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
    return { text: `Reply: ${prompt}` };
  };
}
