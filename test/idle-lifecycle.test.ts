import assert from "node:assert/strict";
import test from "node:test";

import { IdleLifecycle } from "../src/host/substrate/idle.js";
import type {
	ActorControl,
	ActorRef,
	ActorState,
	LifecycleClock,
	LifecycleEvent,
	LifecycleReason,
} from "../src/host/substrate/control.js";

/** A clock tests advance by hand. */
class FakeClock implements LifecycleClock {
	private time = 0;
	private next = 1;
	private readonly timers = new Map<number, { at: number; callback: () => void }>();

	now(): number {
		return this.time;
	}

	schedule(callback: () => void, delayMs: number): unknown {
		const id = this.next++;
		this.timers.set(id, { at: this.time + delayMs, callback });
		return id;
	}

	cancel(handle: unknown): void {
		this.timers.delete(handle as number);
	}

	/** Advances time, firing due timers in order and awaiting their handlers. */
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
			await Promise.resolve();
		}
		this.time = target;
	}

	get pending(): number {
		return this.timers.size;
	}
}

class FakeControl implements ActorControl {
	ensured = 0;
	suspends = 0;
	stateValue: ActorState = "running";
	failSuspend: Error | undefined;

	private hold = false;
	private release: (() => void) | undefined;

	async ensure(_actor: ActorRef): Promise<void> {
		this.ensured += 1;
	}

	async suspend(_actor: ActorRef): Promise<void> {
		this.suspends += 1;
		if (this.failSuspend) throw this.failSuspend;
		if (this.hold) {
			this.hold = false;
			await new Promise<void>((resolve) => (this.release = resolve));
		}
		this.stateValue = "suspended";
	}

	async state(_actor: ActorRef): Promise<ActorState> {
		return this.stateValue;
	}

	/** Keeps the next suspend pending until the test releases it. */
	holdNextSuspend(): void {
		this.hold = true;
	}

	releaseSuspend(): void {
		const release = this.release;
		this.release = undefined;
		release?.();
	}
}

const actor: ActorRef = { atespace: "pi-agents", name: "pi-conv-1" };

function setup(idleMs = 1_000): {
	clock: FakeClock;
	control: FakeControl;
	events: LifecycleEvent[];
	lifecycle: IdleLifecycle;
} {
	const clock = new FakeClock();
	const control = new FakeControl();
	const events: LifecycleEvent[] = [];
	const lifecycle = new IdleLifecycle({
		actor,
		control,
		idleMs,
		clock,
		onEvent: (event) => events.push(event),
	});
	return { clock, control, events, lifecycle };
}

function reasons(events: LifecycleEvent[]): LifecycleReason[] {
	return events.map((event) => event.reason);
}

test("an idle window after a settled turn suspends exactly once", async () => {
	const { clock, control, events, lifecycle } = setup();

	await lifecycle.ready();
	assert.equal(control.ensured, 1);

	lifecycle.turnStarted();
	assert.equal(lifecycle.state, "ACTIVE");
	await clock.advance(5_000);
	assert.equal(control.suspends, 0, "no timer is armed while a turn is in flight");

	lifecycle.turnSettled();
	assert.equal(lifecycle.state, "GRACE");
	await clock.advance(999);
	assert.equal(control.suspends, 0);
	await clock.advance(1);
	assert.equal(control.suspends, 1);
	assert.equal(lifecycle.state, "SUSPENDED");

	await clock.advance(60_000);
	assert.equal(control.suspends, 1, "a suspended actor is not suspended again");
	assert.deepEqual(reasons(events), ["actor_running", "turn_started", "turn_settled", "idle_elapsed", "suspend_requested"]);
});

test("a prompt cancels the idle timer", async () => {
	const { clock, control, lifecycle } = setup();
	lifecycle.turnStarted();
	lifecycle.turnSettled();
	assert.equal(clock.pending, 1);

	await clock.advance(500);
	lifecycle.turnStarted();
	assert.equal(clock.pending, 0, "the timer is gone the moment a prompt arrives");
	await clock.advance(10_000);
	assert.equal(control.suspends, 0);
});

test("a prompt that arrives while suspending produces one suspend and no second one", async () => {
	const { clock, control, events, lifecycle } = setup();
	control.holdNextSuspend();

	lifecycle.turnStarted();
	lifecycle.turnSettled();
	const idle = clock.advance(1_000);
	await idle;
	assert.equal(lifecycle.state, "SUSPENDING");

	lifecycle.turnStarted();
	assert.equal(lifecycle.state, "ACTIVE");
	assert.ok(reasons(events).includes("prompt_during_suspend"));

	control.releaseSuspend();
	await clock.advance(0);
	await lifecycle.close();

	assert.equal(control.suspends, 1, "the racing prompt never issues a second suspend");
	// The prompt that raced the suspend owns the actor now: the suspend landing
	// late must not overwrite that, or its settled turn would arm no timer.
	assert.equal(lifecycle.state, "ACTIVE");
	lifecycle.turnSettled();
	assert.equal(lifecycle.state, "GRACE");
	lifecycle.turnStarted();
	assert.equal(lifecycle.state, "ACTIVE");
});

test("a turn settled while another is still in flight does not arm the timer", async () => {
	const { clock, control, lifecycle } = setup();
	lifecycle.turnStarted();
	lifecycle.turnStarted();
	lifecycle.turnSettled();
	assert.equal(clock.pending, 0, "one turn is still running");
	assert.equal(lifecycle.state, "ACTIVE");

	lifecycle.turnSettled();
	assert.equal(lifecycle.state, "GRACE");
	await clock.advance(1_000);
	assert.equal(control.suspends, 1);
});

test("a failed suspend is reported and retried after another idle window", async () => {
	const { clock, control, events, lifecycle } = setup();
	control.failSuspend = new Error("ateapi unavailable");

	lifecycle.turnStarted();
	lifecycle.turnSettled();
	await clock.advance(1_000);
	assert.equal(lifecycle.state, "GRACE", "a failed suspend leaves the actor eligible again");
	assert.ok(reasons(events).includes("suspend_failed"));
	assert.equal(events.find((event) => event.reason === "suspend_failed")?.error, "ateapi unavailable");

	control.failSuspend = undefined;
	await clock.advance(1_000);
	assert.equal(control.suspends, 2);
	assert.equal(lifecycle.state, "SUSPENDED");
});

test("an idle window of zero disables the suspend entirely", async () => {
	// `PI_IDLE_SECONDS=0` is documented as "disables it". A zero-delay timer
	// would instead suspend the moment a turn settles, so the next message
	// pays a full resume for what was never idle.
	const { clock, control, lifecycle } = setup(0);

	lifecycle.turnStarted();
	lifecycle.turnSettled();
	await clock.advance(60_000);

	assert.equal(control.suspends, 0);
	assert.equal(lifecycle.state, "GRACE");
});
