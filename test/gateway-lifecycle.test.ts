import assert from "node:assert/strict";
import test from "node:test";

import { StubBackend } from "./support/stub-backend.js";
import { Conversation } from "../src/gateway/manager.js";
import { IdleLifecycle } from "../src/gateway/substrate/idle.js";
import type { ActorControl, ActorRef, ActorState, LifecycleClock } from "../src/gateway/substrate/control.js";

class ManualClock implements LifecycleClock {
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

	async advance(ms: number): Promise<void> {
		const due = [...this.timers.entries()]
			.filter(([, timer]) => timer.at <= this.time + ms)
			.sort((a, b) => a[1].at - b[1].at);
		for (const [id, timer] of due) {
			this.timers.delete(id);
			this.time = timer.at;
			timer.callback();
			await Promise.resolve();
		}
		this.time += ms;
	}
}

class RecordingControl implements ActorControl {
	suspends = 0;
	async ensure(_actor: ActorRef): Promise<void> {}
	async applyEgress(_actor: ActorRef, _manifest: string): Promise<void> {}
	async suspend(_actor: ActorRef): Promise<void> {
		this.suspends += 1;
	}
	async state(_actor: ActorRef): Promise<ActorState> {
		return "running";
	}
}

function setup(idleMs: number, backend = new StubBackend()) {
	const clock = new ManualClock();
	const control = new RecordingControl();
	const lifecycle = new IdleLifecycle({
		actor: { atespace: "pi-agents", name: "pi-conv" },
		control,
		idleMs,
		clock,
	});
	const gateway = new Conversation({ actor: { atespace: "pi-agents", name: "pi-test" }, backend, lifecycle });
	return { clock, control, lifecycle, gateway, backend };
}

test("the gateway suspends after the idle window and wakes for the next turn", async (t) => {
	const { clock, control, lifecycle, gateway } = setup(1_000);
	t.after(() => lifecycle.close());

	const first = await gateway.receive("hello");
	assert.equal(first.text, "Reply: hello");
	assert.equal(control.suspends, 0, "no suspend while or right after a turn");
	assert.equal(lifecycle.state, "GRACE");

	await clock.advance(1_000);
	assert.equal(control.suspends, 1);
	assert.equal(lifecycle.state, "SUSPENDED");

	const second = await gateway.receive("again");
	assert.equal(second.text, "Reply: again");
	assert.equal(lifecycle.state, "GRACE", "the resumed turn settles into a fresh grace window");
});

test("a turn in flight is never suspended", async (t) => {
	const { clock, control, lifecycle, gateway } = setup(100, new StubBackend({ delayMs: 1_000 }));
	t.after(() => lifecycle.close());

	const turn = gateway.receive("slow");
	await new Promise((resolve) => setTimeout(resolve, 20));
	assert.equal(lifecycle.state, "ACTIVE");
	await clock.advance(60_000);
	assert.equal(control.suspends, 0, "the idle window cannot expire mid-turn");

	await turn;
	assert.equal(lifecycle.state, "GRACE");
});

test("a failed turn still ends, so the idle window can arm", async (t) => {
	// A provider outage fails the turn after `turnStarted`. If the lifecycle
	// never hears the matching settle, it stays ACTIVE and the actor is never
	// suspended again: one transient error would pin a worker forever.
	const backend = new StubBackend();
	backend.submit = async () => {
		throw new Error("provider unreachable");
	};
	const { clock, control, lifecycle, gateway } = setup(1_000, backend);
	t.after(() => lifecycle.close());

	await assert.rejects(gateway.receive("does not matter"), /provider unreachable/);
	assert.equal(lifecycle.state, "GRACE", "a failed turn leaves the state machine able to suspend");

	await clock.advance(1_000);
	assert.equal(control.suspends, 1, "the actor still goes idle after a failed turn");
});
