import assert from "node:assert/strict";
import test from "node:test";

import { PiBackend, type ActorTransport } from "../src/gateway/backend.js";
import { WebSocketTransport } from "../src/gateway/websocket.js";

/** A transport whose connection can be dropped by the test. */
class DoorTransport implements ActorTransport {
  connected = false;
  sent: Array<Record<string, unknown>> = [];

  private readonly records: Array<(record: Record<string, unknown>) => void> = [];
  private readonly closes: Array<() => void> = [];

  async connect(): Promise<void> {
    this.connected = true;
  }

  send(record: Record<string, unknown>): void {
    if (!this.connected) throw new Error("not connected");
    this.sent.push(record);
  }

  onRecord(listener: (record: Record<string, unknown>) => void): void {
    this.records.push(listener);
  }

  onClose(listener: () => void): void {
    this.closes.push(listener);
  }

  async close(): Promise<void> {
    this.connected = false;
  }

  /** Simulates the actor going away without the client closing first. */
  drop(): void {
    this.connected = false;
    for (const listener of this.closes) listener();
  }

  /** Delivers a record as if it came from the actor. */
  deliver(record: Record<string, unknown>): void {
    for (const listener of this.records) listener(record);
  }
}

async function untilSent(transport: DoorTransport): Promise<void> {
  for (let i = 0; i < 100 && transport.sent.length === 0; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test("a bridge_result settles the turn", async () => {
  const transport = new DoorTransport();
  const backend = new PiBackend({ transport, turnTimeoutMs: 1_000 });
  const turn = backend.submit({ requestId: "r1", prompt: "hi" });
  await untilSent(transport);

  assert.deepEqual(transport.sent[0], { id: "r1", type: "prompt", message: "hi" });
  transport.deliver({ type: "bridge_result", requestId: "r1", text: "hello" });
  assert.equal((await turn).text, "hello");
});

test("a dropped connection fails the turn in flight", async () => {
  const transport = new DoorTransport();
  const backend = new PiBackend({ transport, turnTimeoutMs: 1_000 });
  const turn = backend.submit({ requestId: "r1", prompt: "hi" });
  await untilSent(transport);

  transport.drop();
  await assert.rejects(turn, /connection closed/);
});

test("the websocket transport does not reconnect on its own", async () => {
  // A reconnect wakes a suspended actor, which would undo the idle window.
  // Pinning this down keeps a future auto-reconnect from reintroducing the
  // wake loop.
  const transport = new WebSocketTransport({ url: "ws://127.0.0.1:1" });
  let closed = 0;
  transport.onClose(() => {
    closed += 1;
  });
  await transport.connect().catch(() => undefined);
  assert.equal(closed, 0, "a failed first connect is not a reconnect");
  await transport.close();
});
