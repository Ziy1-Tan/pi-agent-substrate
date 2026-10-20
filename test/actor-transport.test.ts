import assert from "node:assert/strict";
import test from "node:test";

import { PiBackend, type ActorTransport } from "../src/actor/backend.js";
import { WebSocketTransport } from "../src/actor/websocket.js";

/** A transport whose connection can be dropped by the test. */
class DoorTransport implements ActorTransport {
	connected = false;
	drops = 0;
	sent: Array<Record<string, unknown>> = [];

	private readonly records: Array<(record: Record<string, unknown>) => void> = [];
	private readonly connects: Array<(isReconnect: boolean) => void> = [];
	private readonly closes: Array<() => void> = [];
	private everConnected = false;

	async connect(): Promise<void> {
		if (this.connected) return;
		this.connected = true;
		const isReconnect = this.everConnected;
		this.everConnected = true;
		for (const listener of this.connects) listener(isReconnect);
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

	onConnect(listener: (isReconnect: boolean) => void): void {
		this.connects.push(listener);
	}

	async close(): Promise<void> {
		this.connected = false;
	}

	/** Simulates the actor going away without the client closing first. */
	drop(): void {
		this.connected = false;
		this.drops += 1;
		for (const listener of this.closes) listener();
	}

	/** Delivers a record as if it came from the actor. */
	deliver(record: Record<string, unknown>): void {
		for (const listener of this.records) listener(record);
	}
}

test("a dropped connection invalidates cached turns", async () => {
	const transport = new DoorTransport();
	const backend = new PiBackend({ transport, turnTimeoutMs: 1_000 });
	await backend.connect();

	const turn = backend.submit({ requestId: "r1", conversationId: "c", prompt: "hi" }, () => undefined);
	transport.deliver({ type: "agent_settled" });
	assert.equal((await turn).text, "");

	// The actor can suspend between turns; its bridge cache goes with it. A
	// retry must run the turn again rather than replay a result the restored
	// actor never produced.
	transport.drop();
	transport.sent = [];
	const retried = backend.submit({ requestId: "r1", conversationId: "c", prompt: "hi" }, () => undefined);
	retried.catch(() => undefined);
	await new Promise((resolve) => setTimeout(resolve, 10));
	assert.equal(transport.sent.some((record) => record.type === "prompt"), true);
	transport.deliver({ type: "agent_settled" });
	await retried;
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
