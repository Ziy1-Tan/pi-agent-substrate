import assert from "node:assert/strict";
import test from "node:test";

import { Conversation, Metrics } from "../src/gateway/manager.js";
import { IdleLifecycle } from "../src/gateway/substrate/idle.js";
import { StubBackend } from "./support/stub-backend.js";

test("turns that follow a suspend are counted as resumed", async () => {
	const metrics = new Metrics();
	const lifecycle = new IdleLifecycle({
		actor: { atespace: "pi-agents", name: "pi-test" },
		control: {
			async ensure() {},
			async applyEgress() {},
			async suspend() {},
			async state() {
				return "running" as const;
			},
		},
		idleMs: 1,
	});
	const gateway = new Conversation({
		actor: { atespace: "pi-agents", name: "pi-test" },
		backend: new StubBackend(),
		lifecycle,
		onTurn: (report) => {
			metrics.increment("turns");
			if (report.resumed) metrics.increment("resumed_turns");
		},
	});
	test.after(() => lifecycle.close());

	await gateway.receive("one");
	await new Promise((resolve) => setTimeout(resolve, 25));
	assert.equal(lifecycle.state, "SUSPENDED");
	await gateway.receive("two");

	assert.deepEqual(metrics.snapshot(), { counters: { turns: 2, resumed_turns: 1 } });
});
