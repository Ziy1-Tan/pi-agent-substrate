import assert from "node:assert/strict";
import test from "node:test";

import { Gateway } from "../src/gateway/gateway.js";
import { IdleLifecycle } from "../src/gateway/idle.js";
import { echoTurn, FakeClock, FakeControl } from "./support/fakes.js";

const actor = { atespace: "pi-agents", name: "pi-conv" };

function lifecycleSetup(idleMs = 1_000) {
  const clock = new FakeClock();
  const control = new FakeControl();
  const lifecycle = new IdleLifecycle({
    actor,
    suspend: (target) => control.suspend(target),
    idleMs,
    clock,
  });
  return { clock, control, lifecycle };
}

function gatewaySetup(idleMs: number, runTurn = echoTurn()) {
  const clock = new FakeClock();
  const control = new FakeControl();
  const gateway = new Gateway({ control, atespace: "pi-agents", idleMs, clock, runTurn });
  return { clock, control, gateway };
}

// --- the state machine on its own ---

test("an idle window after a settled turn suspends exactly once", async () => {
  const { clock, control, lifecycle } = lifecycleSetup();

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
});

test("a prompt cancels the idle timer", async () => {
  const { clock, control, lifecycle } = lifecycleSetup();
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
  const { clock, control, lifecycle } = lifecycleSetup();
  control.holdNextSuspend();

  lifecycle.turnStarted();
  lifecycle.turnSettled();
  await clock.advance(1_000);
  assert.equal(lifecycle.state, "SUSPENDING");

  lifecycle.turnStarted();
  assert.equal(lifecycle.state, "ACTIVE");

  control.releaseSuspend();
  await lifecycle.close();

  assert.equal(control.suspends, 1, "the racing prompt never issues a second suspend");
  // The prompt that raced the suspend owns the actor now: the suspend landing
  // late must not overwrite that, or its settled turn would arm no timer.
  assert.equal(lifecycle.state, "ACTIVE");
  lifecycle.turnSettled();
  assert.equal(lifecycle.state, "GRACE");
});

test("a turn settled while another is still in flight does not arm the timer", async () => {
  const { clock, control, lifecycle } = lifecycleSetup();
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

test("a failed suspend is counted and retried after another idle window", async () => {
  const clock = new FakeClock();
  const control = new FakeControl();
  const counted: string[] = [];
  const lifecycle = new IdleLifecycle({
    actor,
    suspend: (target) => control.suspend(target),
    idleMs: 1_000,
    clock,
    count: (name) => counted.push(name),
  });
  control.failSuspend = new Error("ateapi unavailable");

  lifecycle.turnStarted();
  lifecycle.turnSettled();
  await clock.advance(1_000);
  assert.equal(lifecycle.state, "GRACE", "a failed suspend leaves the actor eligible again");
  assert.deepEqual(counted, ["suspends", "suspend_failures"]);
  assert.equal(lifecycle.snapshot().lastSuspendError, "ateapi unavailable");

  control.failSuspend = undefined;
  await clock.advance(1_000);
  assert.equal(control.suspends, 2);
  assert.deepEqual(lifecycle.snapshot(), { state: "SUSPENDED", inflight: 0 });
});

test("an idle window of zero disables the suspend entirely", async () => {
  // `IDLE_SECONDS=0` is documented as "disables it". A zero-delay timer would
  // instead suspend the moment a turn settles, so the next message pays a full
  // resume for what was never idle.
  const { clock, control, lifecycle } = lifecycleSetup(0);

  lifecycle.turnStarted();
  lifecycle.turnSettled();
  await clock.advance(60_000);

  assert.equal(control.suspends, 0);
  assert.equal(lifecycle.state, "GRACE");
});

// --- the same machine driven through the gateway ---

test("the gateway suspends after the idle window and counts the resumed turn", async (t) => {
  const { clock, control, gateway } = gatewaySetup(1_000);
  t.after(() => gateway.close());

  assert.equal((await gateway.receive("local/chat", "hello")).text, "Reply: hello");
  assert.equal(control.suspends, 0, "no suspend while or right after a turn");

  await clock.advance(1_000);
  assert.equal(control.suspends, 1);

  assert.equal((await gateway.receive("local/chat", "again")).text, "Reply: again");
  assert.deepEqual(gateway.metrics().counters, { turns: 2, suspends: 1, resumed_turns: 1 });
});

test("a turn in flight is never suspended", async (t) => {
  const { clock, control, gateway } = gatewaySetup(100, echoTurn(200));
  t.after(() => gateway.close());

  const turn = gateway.receive("local/chat", "slow");
  await new Promise((resolve) => setTimeout(resolve, 20));
  await clock.advance(60_000);
  assert.equal(control.suspends, 0, "the idle window cannot expire mid-turn");

  await turn;
  await clock.advance(100);
  assert.equal(control.suspends, 1);
});

test("a failed turn still settles, so the idle window can arm", async (t) => {
  // A provider outage fails the turn after `turnStarted`. If the lifecycle
  // never hears the matching settle, it stays ACTIVE and the actor is never
  // suspended again: one transient error would pin a worker forever.
  const { clock, control, gateway } = gatewaySetup(1_000, async () => {
    throw new Error("provider unreachable");
  });
  t.after(() => gateway.close());

  await assert.rejects(gateway.receive("local/chat", "does not matter"), /provider unreachable/);
  await clock.advance(1_000);
  assert.equal(control.suspends, 1, "the actor still goes idle after a failed turn");
});
