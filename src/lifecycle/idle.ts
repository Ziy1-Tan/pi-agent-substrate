import {
	systemClock,
	type ActorControl,
	type ActorRef,
	type LifecycleClock,
	type LifecycleEvent,
	type LifecycleListener,
} from "./types.js";

export type IdleState = "IDLE" | "ACTIVE" | "GRACE" | "SUSPENDING" | "SUSPENDED";

export interface IdleLifecycleOptions {
	actor: ActorRef;
	control: ActorControl;
	/** How long the actor must be idle after a settled turn before suspending. */
	idleMs: number;
	clock?: LifecycleClock;
	onEvent?: LifecycleListener;
	log?: (message: string) => void;
}

/**
 * The per-conversation lifecycle from the design doc:
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
	private readonly actor: ActorRef;
	private readonly control: ActorControl;
	private readonly idleMs: number;
	private readonly clock: LifecycleClock;
	private readonly onEvent: LifecycleListener | undefined;
	private readonly log: (message: string) => void;

	private current: IdleState = "IDLE";
	/** Turns the gateway has started but not yet acknowledged as complete. */
	private inflight = 0;
	private idleSince: number | undefined;
	private timer: unknown;
	private suspending: Promise<void> | undefined;

	constructor(options: IdleLifecycleOptions) {
		this.actor = options.actor;
		this.control = options.control;
		this.idleMs = Math.max(0, options.idleMs);
		this.clock = options.clock ?? systemClock;
		this.onEvent = options.onEvent;
		this.log = options.log ?? (() => undefined);
	}

	get state(): IdleState {
		return this.current;
	}

	/** A prompt was accepted for this conversation. Cancels any pending suspend. */
	turnStarted(): void {
		this.inflight += 1;
		this.cancelTimer();
		if (this.current === "SUSPENDING") {
			// The request is already with the control plane; the next connect
			// resumes the actor. Do not issue a second suspend.
			this.emit("prompt_during_suspend");
		}
		this.current = "ACTIVE";
		this.idleSince = undefined;
		this.emit("turn_started");
	}

	/** A turn was fully recorded. This is the only path into GRACE. */
	turnSettled(): void {
		this.inflight = Math.max(0, this.inflight - 1);
		if (this.current !== "ACTIVE" && this.current !== "SUSPENDING") return;
		if (this.inflight > 0) return;
		this.current = "GRACE";
		this.idleSince = this.clock.now();
		this.emit("turn_settled");
		this.armTimer();
	}

	/** Called when the actor stops being usable; the next prompt recreates it. */
	actorCrashed(error?: string): void {
		this.cancelTimer();
		this.inflight = 0;
		this.current = "SUSPENDED";
		this.emit("actor_crashed", { error });
	}

	/** Creates the actor if absent. Safe to call before every turn. */
	async ready(): Promise<void> {
		await this.control.ensure(this.actor);
		if (this.current === "SUSPENDED" || this.current === "IDLE") {
			const state = await this.control.state(this.actor).catch(() => "unknown" as const);
			if (state === "running") {
				this.current = "IDLE";
				this.emit("actor_running");
			}
		}
	}

	async close(): Promise<void> {
		this.cancelTimer();
		await this.suspending?.catch(() => undefined);
	}

	private armTimer(): void {
		this.cancelTimer();
		this.timer = this.clock.schedule(() => {
			this.timer = undefined;
			void this.onIdle();
		}, this.idleMs);
	}

	private cancelTimer(): void {
		if (this.timer === undefined) return;
		this.clock.cancel(this.timer);
		this.timer = undefined;
	}

	private async onIdle(): Promise<void> {
		if (this.current !== "GRACE" || this.inflight > 0) return;
		const idleMs = this.idleSince === undefined ? this.idleMs : this.clock.now() - this.idleSince;
		this.emit("idle_elapsed", { idleMs });
		this.current = "SUSPENDING";
		this.emit("suspend_requested");
		this.suspending = this.control
			.suspend(this.actor)
			.then(() => {
				// A prompt that arrived while the request was in flight has already
				// moved the state back to ACTIVE, and the router wakes the actor for
				// that turn. Recording SUSPENDED here would lose that turn's boundary.
				this.current = this.inflight > 0 ? "ACTIVE" : "SUSPENDED";
				this.log(`actor ${this.actor.atespace}/${this.actor.name} suspended after ${idleMs}ms idle`);
			})
			.catch((error: unknown) => {
				const message = error instanceof Error ? error.message : String(error);
				this.emit("suspend_failed", { error: message });
				this.log(`suspend ${this.actor.name} failed: ${message}; retrying after the idle window`);
				// Fall back to GRACE so the next idle window retries instead of
				// leaving the conversation stuck in SUSPENDING forever.
				this.current = this.inflight > 0 ? "ACTIVE" : "GRACE";
				this.idleSince = this.clock.now();
				if (this.current === "GRACE") this.armTimer();
			})
			.finally(() => {
				this.suspending = undefined;
			});
		await this.suspending;
	}

	private emit(reason: LifecycleEvent["reason"], extra: Partial<LifecycleEvent> = {}): void {
		this.onEvent?.({ reason, actor: this.actor, ...extra });
	}
}
