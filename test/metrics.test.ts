import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { Gateway } from "../src/host/gateway.js";
import { createConversation } from "../src/host/conversations.js";
import { Metrics } from "../src/metrics.js";
import { StubBackend } from "./support/stub-backend.js";
import { TestChannel } from "./support/test-channel.js";

async function tempRoot(t: test.TestContext): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "pi-metrics-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	return root;
}

test("metrics report percentiles over recent turns and mark resumed turns", async (t) => {
	const root = await tempRoot(t);
	const conversation = await createConversation(root, "local/chat");
	const metrics = new Metrics();
	let resumedNext = false;
	const gateway = new Gateway({
		conversation,
		channel: new TestChannel(),
		backend: new StubBackend({ chunkSize: 8 }),
		lifecycle: {
			async ready() {},
			turnStarted() {},
			turnSettled() {},
			get state() {
				return resumedNext ? ("SUSPENDED" as const) : ("ACTIVE" as const);
			},
		},
		onTurn: (report) => {
			metrics.increment("turns");
			metrics.observe("turn_millis", report.turnMillis);
			if (report.firstTokenMillis !== undefined) {
				metrics.observe("first_token_millis", report.firstTokenMillis);
				if (report.resumed) metrics.observe("resume_millis", report.firstTokenMillis);
			}
		},
	});
	await gateway.start();
	t.after(() => gateway.stop());

	await gateway.receive({ userId: "u", text: "one" });
	await gateway.waitForIdle();
	resumedNext = true;
	await gateway.receive({ userId: "u", text: "two" });
	await gateway.waitForIdle();

	const snapshot = metrics.snapshot();
	assert.equal(snapshot.counters.turns, 2);
	assert.equal(snapshot.timings.turn_millis?.count, 2);
	assert.equal(snapshot.timings.first_token_millis?.count, 2);
	assert.equal(snapshot.timings.resume_millis?.count, 1, "only the turn after a suspend counts as a resume");
	const p50 = snapshot.timings.turn_millis?.p50 ?? -1;
	const p95 = snapshot.timings.turn_millis?.p95 ?? -1;
	assert.ok(p50 >= 0 && p95 >= p50);
	assert.equal(snapshot.timings.turn_millis?.max, Math.max(p95, snapshot.timings.turn_millis?.max ?? 0));
});
