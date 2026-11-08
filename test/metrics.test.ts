import assert from "node:assert/strict";
import test from "node:test";

import { Conversation, Metrics } from "../src/gateway/manager.js";
import { StubBackend } from "./support/stub-backend.js";

test("turns that follow a suspend are counted as resumed", async () => {
	const metrics = new Metrics();
	let state = "ACTIVE";
	const gateway = new Conversation({
		actor: { atespace: "pi-agents", name: "pi-test" },
		backend: new StubBackend(),
		lifecycle: {
			async ready() {},
			turnStarted() {},
			turnSettled() {},
			get state() {
				return state;
			},
		},
		onTurn: (report) => {
			metrics.increment("turns");
			if (report.resumed) metrics.increment("resumed_turns");
		},
	});

	await gateway.receive("one");
	state = "SUSPENDED";
	await gateway.receive("two");

	assert.deepEqual(metrics.snapshot(), { counters: { turns: 2, resumed_turns: 1 } });
});
