import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { EchoBackend } from "../src/backend/echo.js";
import { createConversation } from "../src/gateway/conversations.js";
import { Gateway } from "../src/gateway/gateway.js";
import { IdleLifecycle } from "../src/lifecycle/idle.js";
import type { ActorControl, ActorRef, ActorState, LifecycleClock } from "../src/lifecycle/types.js";
import { TestChannel } from "./support/test-channel.js";

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
	async suspend(_actor: ActorRef): Promise<void> {
		this.suspends += 1;
	}
	async state(_actor: ActorRef): Promise<ActorState> {
		return "running";
	}
}

test("the gateway suspends after the idle window and wakes for the next turn", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "pi-m3-"));
	const conversation = await createConversation(root);
	const channel = new TestChannel();
	const clock = new ManualClock();
	const control = new RecordingControl();
	const lifecycle = new IdleLifecycle({
		actor: { atespace: "pi-agents", name: "pi-conv-1" },
		control,
		idleMs: 1_000,
		clock,
	});
	const gateway = new Gateway({ conversation, channel, backend: new EchoBackend(), lifecycle });
	await gateway.start();
	t.after(async () => {
		await gateway.stop();
		await lifecycle.close();
		await rm(root, { recursive: true, force: true });
	});

	await gateway.receive({ userId: "u", userName: "alice", text: "hello" });
	await gateway.waitForIdle();
	assert.equal(control.suspends, 0, "no suspend while or right after a turn");
	assert.equal(lifecycle.state, "GRACE");

	await clock.advance(1_000);
	assert.equal(control.suspends, 1);
	assert.equal(lifecycle.state, "SUSPENDED");

	await gateway.receive({ userId: "u", userName: "alice", text: "again" });
	await gateway.waitForIdle();
	assert.equal(channel.sent.length, 2);
	assert.equal(channel.sent[1]?.text, "Echo: again");
	assert.equal(lifecycle.state, "GRACE", "the resumed turn settles into a fresh grace window");
});

test("a turn in flight is never suspended", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "pi-m3-"));
	const conversation = await createConversation(root);
	const clock = new ManualClock();
	const control = new RecordingControl();
	const lifecycle = new IdleLifecycle({
		actor: { atespace: "pi-agents", name: "pi-conv-2" },
		control,
		idleMs: 100,
		clock,
	});
	const gateway = new Gateway({
		conversation,
		channel: new TestChannel(),
		backend: new EchoBackend({ delayMs: 1_000 }),
		lifecycle,
	});
	await gateway.start();
	t.after(async () => {
		await gateway.stop();
		await lifecycle.close();
		await rm(root, { recursive: true, force: true });
	});

	const turn = gateway.receive({ userId: "u", userName: "alice", text: "slow" });
	await new Promise((resolve) => setTimeout(resolve, 20));
	assert.equal(lifecycle.state, "ACTIVE");
	await clock.advance(60_000);
	assert.equal(control.suspends, 0, "the idle window cannot expire mid-turn");

	await turn;
	await gateway.waitForIdle();
	assert.equal(lifecycle.state, "GRACE");
});

test("a failed turn still ends, so the idle window can arm", async (t) => {
	// A provider outage fails the turn after `turnStarted`. If the lifecycle
	// never hears the matching settle, it stays ACTIVE and the actor is never
	// suspended again: one transient error would pin a worker forever.
	const root = await mkdtemp(join(tmpdir(), "pi-m3-"));
	const conversation = await createConversation(root);
	const channel = new TestChannel();
	const clock = new ManualClock();
	const control = new RecordingControl();
	const lifecycle = new IdleLifecycle({
		actor: { atespace: "pi-agents", name: "pi-conv-3" },
		control,
		idleMs: 1_000,
		clock,
	});
	const backend = new EchoBackend();
	const original = backend.submit.bind(backend);
	backend.submit = async () => {
		throw new Error("provider unreachable");
	};
	const gateway = new Gateway({ conversation, channel, backend, lifecycle });
	await gateway.start();
	t.after(async () => {
		await gateway.stop();
		await lifecycle.close();
		await rm(root, { recursive: true, force: true });
	});

	await gateway.receive({ userId: "u", userName: "alice", text: "does not matter" });
	await gateway.waitForIdle();
	assert.equal(lifecycle.state, "GRACE", "a failed turn leaves the state machine able to suspend");
	assert.equal(channel.errors.at(-1), "provider unreachable", "the failure reaches the user");

	await clock.advance(1_000);
	assert.equal(control.suspends, 1, "the actor still goes idle after a failed turn");

	// And the conversation recovers: the next turn uses the real backend.
	backend.submit = original;
	await gateway.receive({ userId: "u", userName: "alice", text: "hello again" });
	await gateway.waitForIdle();
	assert.equal(channel.sent.at(-1)?.text, "Echo: hello again");
});
