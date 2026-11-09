import assert from "node:assert/strict";
import test from "node:test";

import { StubBackend } from "./support/stub-backend.js";
import { GatewayManager, actorNameFor } from "../src/gateway/manager.js";
import type { ActorControl } from "../src/gateway/substrate/control.js";

test("actor names are deterministic and legal", () => {
  assert.equal(actorNameFor("local/chat"), "pi-local-chat");
  assert.equal(actorNameFor("Team Alpha/General"), "pi-team-alpha-general");
  assert.equal(actorNameFor("///"), "pi-conversation");
  assert.ok(actorNameFor("x".repeat(100)).length <= 43);
  assert.equal(actorNameFor("local/chat"), actorNameFor("local/chat"));
});

/** Records the order of the control calls the manager makes. */
function recordingControl(calls: string[]): ActorControl {
  return {
    async ensure(actor) {
      calls.push(`ensure ${actor.atespace}/${actor.name}`);
    },
    async applyEgress(actor, _manifest) {
      calls.push(`egress ${actor.atespace}/${actor.name}`);
    },
    async suspend() {},
    async state() {
      return "running" as const;
    },
  };
}

test("opening a conversation ensures its actor before its egress policy", async () => {
  const calls: string[] = [];
  const manager = new GatewayManager({
    actorUrl: "ws://127.0.0.1:1",
    control: recordingControl(calls),
    atespace: "pi-agents",
    egressPolicy: "policy.yaml",
    idleMs: 60_000,
    createBackend: () => new StubBackend(),
  });

  await manager.ensure("local/chat");
  assert.deepEqual(calls, ["ensure pi-agents/pi-local-chat", "egress pi-agents/pi-local-chat"]);

  // A turn re-ensures through `ready()` — idempotent by design — but never
  // provisions a second time.
  const reply = await manager.receive("local/chat", "hi");
  assert.equal(reply.text, "Reply: hi");
  assert.equal(
    calls.indexOf("egress pi-agents/pi-local-chat"),
    calls.lastIndexOf("egress pi-agents/pi-local-chat"),
  );

  await manager.close();
});

test("the manager keeps one actor per conversation and isolates failures", async () => {
  const ensured: string[] = [];
  const manager = new GatewayManager({
    actorUrl: "ws://127.0.0.1:1",
    control: {
      async ensure(actor) {
        ensured.push(actor.name);
      },
      async applyEgress() {},
      async suspend() {},
      async state() {
        return "running" as const;
      },
    },
    atespace: "pi-agents",
    idleMs: 60_000,
    createBackend: () => new StubBackend(),
  });

  const a = await manager.ensure("local/a");
  const again = await manager.ensure("local/a");
  assert.equal(a, again, "the same conversation is opened once");
  const b = await manager.ensure("local/b");
  assert.notEqual(a.actor.name, b.actor.name, "conversations never share an actor");
  assert.deepEqual(ensured.sort(), ["pi-local-a", "pi-local-b"]);

  const reply = await manager.receive("local/a", "hi");
  assert.equal(reply.text, "Reply: hi");

  await manager.close();
});
