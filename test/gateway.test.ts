import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import { createConversation } from "../src/gateway/conversations.js";
import { Gateway, GatewayAbort } from "../src/gateway/gateway.js";
import type { GatewayHooks } from "../src/gateway/types.js";
import { readRecords, recordTypes } from "./support/records.js";
import { StubBackend } from "./support/stub-backend.js";
import { TestChannel } from "./support/test-channel.js";

interface Harness {
	root: string;
	conversation: Awaited<ReturnType<typeof createConversation>>;
	channel: TestChannel;
	backend: StubBackend;
	open(hooks?: GatewayHooks): Promise<Gateway>;
}

async function createHarness(t: TestContext, delayMs = 0): Promise<Harness> {
	const root = await mkdtemp(join(tmpdir(), "pi-gateway-"));
	const conversation = await createConversation(root);
	const channel = new TestChannel();
	const backend = new StubBackend({ chunkSize: 3, delayMs });
	const gateways: Gateway[] = [];
	t.after(async () => {
		for (const gateway of gateways) await gateway.stop().catch(() => undefined);
		await rm(root, { recursive: true, force: true });
	});
	return {
		root,
		conversation,
		channel,
		backend,
		async open(hooks?: GatewayHooks): Promise<Gateway> {
			const gateway = new Gateway({ conversation, channel, backend, hooks });
			await gateway.start();
			gateways.push(gateway);
			return gateway;
		},
	};
}

const message = { userId: "user-1", userName: "alice", text: "hello" };

test("test channel is unavailable outside test builds", () => {
	const previous = process.env.NODE_ENV;
	process.env.NODE_ENV = "production";
	try {
		assert.throws(() => new TestChannel(), /only available in test builds/);
	} finally {
		process.env.NODE_ENV = previous;
	}
});

function counts(records: { type: string }[], type: string): number {
	return records.filter((record) => record.type === type).length;
}

test("test channel delivers a message with streaming edits", async (t) => {
	const harness = await createHarness(t);
	const gateway = await harness.open();
	await gateway.receive(message);
	await gateway.waitForIdle();

	assert.equal(harness.channel.sent.length, 1);
	assert.equal(harness.channel.sent[0]?.text, "Reply: hello");
	assert.ok(harness.channel.sent[0]?.replyToMessageId, "outbound replies to the inbound message");
	assert.ok(harness.channel.previews.length >= 2, "reply arrived as more than one preview edit");
	assert.equal(harness.channel.previews.at(-1), "Reply: hello");
	assert.equal(harness.channel.previewClears, 1);

	const records = await readRecords(harness.conversation.logPath);
	assert.deepEqual(recordTypes(records), [
		"inbound",
		"job_queued",
		"job_dispatched",
		"outbound",
		"job_completed",
	]);
	const dispatch = records.find((record) => record.type === "job_dispatched");
	assert.ok(dispatch && "requestId" in dispatch && dispatch.requestId.length > 0);
	assert.equal(harness.backend.executedRequestIds.length, 1);
});

test("restart before submit delivers the queued turn exactly once", async (t) => {
	const harness = await createHarness(t);
	const crashing = await harness.open({
		beforeSubmit: () => {
			throw new GatewayAbort("crash before submit");
		},
	});
	await crashing.receive(message);
	await assert.rejects(crashing.waitForIdle(), GatewayAbort);
	await crashing.stop();

	const before = await readRecords(harness.conversation.logPath);
	assert.deepEqual(recordTypes(before), ["inbound", "job_queued"]);
	assert.equal(harness.backend.executedRequestIds.length, 0);
	assert.equal(harness.channel.sent.length, 0);

	const restarted = await harness.open();
	await restarted.waitForIdle();

	const after = await readRecords(harness.conversation.logPath);
	assert.equal(counts(after, "job_dispatched"), 1);
	assert.equal(counts(after, "outbound"), 1);
	assert.equal(counts(after, "job_completed"), 1);
	assert.equal(harness.backend.executedRequestIds.length, 1);
	assert.equal(harness.channel.sent.length, 1);
	assert.equal(harness.channel.sent[0]?.text, "Reply: hello");
});

test("restart after submit but before response reuses the request id", async (t) => {
	const harness = await createHarness(t, 5);
	const crashing = await harness.open({
		afterSubmit: () => {
			throw new GatewayAbort("crash after submit");
		},
	});
	await crashing.receive(message);
	await assert.rejects(crashing.waitForIdle(), GatewayAbort);
	await crashing.stop();

	const before = await readRecords(harness.conversation.logPath);
	assert.deepEqual(recordTypes(before), ["inbound", "job_queued", "job_dispatched"]);
	assert.equal(harness.backend.executedRequestIds.length, 1, "backend accepted the turn");
	assert.equal(harness.channel.sent.length, 0, "no response was delivered");

	// Let the external turn finish on its own before the gateway comes back.
	await harness.backend.settle();

	const restarted = await harness.open();
	await restarted.waitForIdle();

	const after = await readRecords(harness.conversation.logPath);
	assert.equal(counts(after, "job_dispatched"), 1, "the same dispatch is retried");
	assert.equal(counts(after, "outbound"), 1);
	assert.equal(counts(after, "job_completed"), 1);
	assert.equal(harness.backend.executedRequestIds.length, 1, "no duplicate execution");
	assert.equal(harness.channel.sent.length, 1);
	assert.equal(harness.channel.sent[0]?.text, "Reply: hello");
});

test("restart after the response was recorded only acknowledges the turn", async (t) => {
	const harness = await createHarness(t);
	const crashing = await harness.open({
		afterOutbound: () => {
			throw new GatewayAbort("crash after outbound");
		},
	});
	await crashing.receive(message);
	await assert.rejects(crashing.waitForIdle(), GatewayAbort);
	await crashing.stop();

	const before = await readRecords(harness.conversation.logPath);
	assert.deepEqual(recordTypes(before), ["inbound", "job_queued", "job_dispatched", "outbound"]);
	assert.equal(harness.channel.sent.length, 1);

	const restarted = await harness.open();
	await restarted.waitForIdle();

	const after = await readRecords(harness.conversation.logPath);
	assert.equal(counts(after, "job_completed"), 1);
	assert.equal(counts(after, "outbound"), 1, "outbound is not written twice");
	assert.equal(harness.backend.executedRequestIds.length, 1, "no re-execution");
	assert.equal(harness.channel.sent.length, 1, "the user sees one message");
	assert.equal(harness.channel.sendAttempts, 1, "the channel is not called again");
});

test("restart after send before outbound suppresses the duplicate delivery", async (t) => {
	const harness = await createHarness(t);
	const crashing = await harness.open({
		afterChannelSend: () => {
			throw new GatewayAbort("crash after channel send");
		},
	});
	await crashing.receive(message);
	await assert.rejects(crashing.waitForIdle(), GatewayAbort);
	await crashing.stop();

	const before = await readRecords(harness.conversation.logPath);
	assert.deepEqual(recordTypes(before), ["inbound", "job_queued", "job_dispatched"]);
	assert.equal(harness.channel.sent.length, 1);

	const restarted = await harness.open();
	await restarted.waitForIdle();

	const after = await readRecords(harness.conversation.logPath);
	assert.equal(counts(after, "outbound"), 1);
	assert.equal(counts(after, "job_completed"), 1);
	assert.equal(harness.backend.executedRequestIds.length, 1, "cached response is reused");
	assert.equal(harness.channel.sent.length, 1, "the user sees one message");
	assert.equal(harness.channel.sendAttempts, 2);
	assert.equal(harness.channel.duplicateDeliveries, 1);
});
