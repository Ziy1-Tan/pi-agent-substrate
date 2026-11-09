import assert from "node:assert/strict";
import test from "node:test";

import { actorNameFor, Gateway } from "../src/gateway/gateway.js";
import { TurnError } from "../src/gateway/turn.js";
import { echoTurn, FakeControl } from "./support/fakes.js";

test("actor names are deterministic, legal, and collision-free", () => {
  const name = actorNameFor("local/chat");
  assert.match(name, /^pi-local-chat-[0-9a-f]{8}$/);
  assert.equal(actorNameFor("local/chat"), name);
  assert.match(actorNameFor("///"), /^pi-conversation-[0-9a-f]{8}$/);
  assert.ok(actorNameFor("x".repeat(100)).length <= 63);

  // Ids that sanitize to the same text must not share an actor.
  assert.notEqual(actorNameFor("web/alpha"), actorNameFor("web-alpha"));
  // An id cut at 40 characters must keep its identity.
  assert.notEqual(actorNameFor("x".repeat(100)), actorNameFor(`${"x".repeat(99)}y`));
});

test("a conversation's actor is created, then given its egress policy, once", async (t) => {
  const control = new FakeControl();
  const gateway = new Gateway({
    control,
    atespace: "pi-agents",
    egressPolicy: { rules: [] },
    idleMs: 60_000,
    runTurn: echoTurn(),
  });
  t.after(() => gateway.close());

  await Promise.all([gateway.receive("local/chat", "a"), gateway.receive("local/chat", "b")]);
  await gateway.receive("local/chat", "c");
  assert.deepEqual(control.calls, [
    `ensure ${actorNameFor("local/chat")}`,
    `egress ${actorNameFor("local/chat")}`,
  ]);
});

test("each conversation gets its own actor", async (t) => {
  const control = new FakeControl();
  const seen: string[] = [];
  const gateway = new Gateway({
    control,
    atespace: "pi-agents",
    idleMs: 60_000,
    runTurn: async (actor, prompt) => {
      seen.push(actor.name);
      return { text: prompt };
    },
  });
  t.after(() => gateway.close());

  await gateway.receive("local/a", "hi");
  await gateway.receive("local/b", "hi");
  assert.deepEqual(seen, [actorNameFor("local/a"), actorNameFor("local/b")]);
});

test("turns in one conversation run one at a time", async (t) => {
  let running = 0;
  let overlapped = false;
  const gateway = new Gateway({
    control: new FakeControl(),
    atespace: "pi-agents",
    idleMs: 60_000,
    runTurn: async (_actor, prompt) => {
      running += 1;
      if (running > 1) overlapped = true;
      await new Promise((resolve) => setTimeout(resolve, 10));
      running -= 1;
      return { text: prompt };
    },
  });
  t.after(() => gateway.close());

  const replies = await Promise.all(
    ["one", "two", "three"].map((text) => gateway.receive("local/chat", text)),
  );
  assert.deepEqual(
    replies.map((reply) => reply.text),
    ["one", "two", "three"],
  );
  assert.equal(overlapped, false);
});

test("a failed open is retried by the next message", async (t) => {
  const control = new FakeControl();
  let failures = 1;
  control.ensure = async (actor) => {
    control.calls.push(`ensure ${actor.name}`);
    if (failures-- > 0) throw new Error("ate-api unavailable");
  };
  const gateway = new Gateway({
    control,
    atespace: "pi-agents",
    idleMs: 60_000,
    runTurn: echoTurn(),
  });
  t.after(() => gateway.close());

  await assert.rejects(gateway.receive("local/chat", "hi"), /ate-api unavailable/);
  assert.equal((await gateway.receive("local/chat", "hi")).text, "Reply: hi");
});

test("an actor deleted behind the gateway's back is recreated before the turn is sent", async (t) => {
  const control = new FakeControl();
  let present = true;
  const gateway = new Gateway({
    control,
    atespace: "pi-agents",
    egressPolicy: { rules: [] },
    idleMs: 60_000,
    runTurn: async (actor, prompt) => {
      if (!present) throw new TurnError("router answered 404", "connect", 404);
      return { text: `${actor.name}: ${prompt}` };
    },
  });
  t.after(() => gateway.close());
  const ensure = control.ensure.bind(control);
  control.ensure = async (actor) => {
    await ensure(actor);
    present = true;
  };

  await gateway.receive("local/chat", "first");
  present = false;
  assert.equal(
    (await gateway.receive("local/chat", "again")).text,
    `${actorNameFor("local/chat")}: again`,
  );
  assert.deepEqual(control.calls, [
    `ensure ${actorNameFor("local/chat")}`,
    `egress ${actorNameFor("local/chat")}`,
    `ensure ${actorNameFor("local/chat")}`,
    `egress ${actorNameFor("local/chat")}`,
  ]);
  assert.equal(gateway.metrics().counters.actors_recreated, 1);
});

test("a failure after the prompt was sent is not retried", async (t) => {
  const control = new FakeControl();
  let attempts = 0;
  const gateway = new Gateway({
    control,
    atespace: "pi-agents",
    idleMs: 60_000,
    runTurn: async () => {
      attempts += 1;
      throw new TurnError("actor connection closed during the turn", "turn");
    },
  });
  t.after(() => gateway.close());

  await assert.rejects(gateway.receive("local/chat", "hi"), /closed during the turn/);
  assert.equal(attempts, 1, "the actor may already be running the turn");
  assert.deepEqual(control.calls, [`ensure ${actorNameFor("local/chat")}`]);
});

test("metrics show each conversation's lifecycle state", async (t) => {
  const control = new FakeControl();
  let releaseEnsure: () => void = () => undefined;
  const ensure = control.ensure.bind(control);
  control.ensure = async (actor) => {
    await new Promise<void>((resolve) => (releaseEnsure = resolve));
    await ensure(actor);
  };
  const gateway = new Gateway({
    control,
    atespace: "pi-agents",
    idleMs: 60_000,
    runTurn: echoTurn(),
  });
  t.after(() => gateway.close());

  const first = gateway.receive("local/chat", "hi");
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(gateway.metrics().conversations, {
    "local/chat": { actor: actorNameFor("local/chat"), state: "OPENING" },
  });
  releaseEnsure();
  await first;
  assert.deepEqual(gateway.metrics().conversations, {
    "local/chat": { actor: actorNameFor("local/chat"), state: "GRACE", inflight: 0 },
  });
});
