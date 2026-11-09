import assert from "node:assert/strict";
import test from "node:test";

import { actorNameFor, Gateway } from "../src/gateway/gateway.js";
import { echoTurn, FakeControl } from "./support/fakes.js";

test("actor names are deterministic and legal", () => {
  assert.equal(actorNameFor("local/chat"), "pi-local-chat");
  assert.equal(actorNameFor("Team Alpha/General"), "pi-team-alpha-general");
  assert.equal(actorNameFor("///"), "pi-conversation");
  assert.ok(actorNameFor("x".repeat(100)).length <= 43);
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
  assert.deepEqual(control.calls, ["ensure pi-local-chat", "egress pi-local-chat"]);
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
  assert.deepEqual(seen, ["pi-local-a", "pi-local-b"]);
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
