/** A conversation's actor, identified the way the lifecycle controller sees it. */
export interface ActorRef {
	atespace: string;
	name: string;
}

export type ActorState = "running" | "suspended" | "suspending" | "unknown" | "crashed";

/**
 * The control-plane operations the lifecycle needs. Resume is deliberately
 * absent: atenet-router resumes on the next connect, so the gateway never
 * races it with an explicit call.
 */
export interface ActorControl {
	/** Creates the actor if it is absent. Absence and already-exists are success. */
	ensure(actor: ActorRef): Promise<void>;
	/** Asks the control plane to suspend. Resolves when the request is accepted. */
	suspend(actor: ActorRef): Promise<void>;
	/** Best-effort read used for diagnostics and for ending SUSPENDING. */
	state(actor: ActorRef): Promise<ActorState>;
}

export type LifecycleReason =
	| "turn_started"
	| "turn_settled"
	| "idle_elapsed"
	| "prompt_during_suspend"
	| "suspend_requested"
	| "suspend_failed"
	| "actor_running"
	| "actor_crashed";

export interface LifecycleEvent {
	reason: LifecycleReason;
	actor: ActorRef;
	/** Milliseconds since the actor settled, for the decisions that depend on it. */
	idleMs?: number;
	error?: string;
}

export type LifecycleListener = (event: LifecycleEvent) => void;

/** Injectable clock so idle timing can be tested without sleeping. */
export interface LifecycleClock {
	now(): number;
	schedule(callback: () => void, delayMs: number): unknown;
	cancel(handle: unknown): void;
}

export const systemClock: LifecycleClock = {
	now: () => Date.now(),
	schedule: (callback, delayMs) => {
		const timer = setTimeout(callback, delayMs);
		timer.unref?.();
		return timer;
	},
	cancel: (handle) => clearTimeout(handle as NodeJS.Timeout),
};
