import assert from "node:assert/strict";
import test from "node:test";

import { StubBackend } from "./support/stub-backend.js";
import { startHttpServer } from "../src/gateway/server.js";
import { GatewayManager } from "../src/gateway/manager.js";

interface Setup {
	server: { port: number };
	manager: GatewayManager;
}

async function setup(t: test.TestContext): Promise<Setup> {
	const manager = new GatewayManager({
		actorUrl: "ws://127.0.0.1:1",
		control: {
			async ensure() {},
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
	const server = await startHttpServer({
		manager,
		port: 0,
	});
	t.after(async () => {
		await server.close();
		await manager.close();
	});
	return { server, manager };
}

test("curl posts a message and reads the settled reply in the response", async (t) => {
	const { server } = await setup(t);
	const response = await fetch(`http://127.0.0.1:${server.port}/messages`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ conversation: "cli/one", text: "hello from curl" }),
	});
	assert.equal(response.status, 200);
	const body = (await response.json()) as { conversation: string; text: string };
	assert.equal(body.conversation, "cli/one");
	assert.equal(body.text, "Reply: hello from curl");
});

test("each turn in a conversation gets its own reply", async (t) => {
	const { server } = await setup(t);
	const post = async (text: string) =>
		(await (
			await fetch(`http://127.0.0.1:${server.port}/messages`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ conversation: "cli/one", text }),
			})
		).json()) as { text: string };

	assert.equal((await post("first")).text, "Reply: first");
	assert.equal((await post("second")).text, "Reply: second");
});

test("a bad request is answered with a status, not a hang", async (t) => {
	const { server } = await setup(t);
	const empty = await fetch(`http://127.0.0.1:${server.port}/messages`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ conversation: "cli/one", text: "  " }),
	});
	assert.equal(empty.status, 400);

	const wrongMethod = await fetch(`http://127.0.0.1:${server.port}/messages`);
	assert.equal(wrongMethod.status, 405);

	const notJson = await fetch(`http://127.0.0.1:${server.port}/messages`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: "{",
	});
	assert.equal(notJson.status, 400);
});

test("metrics are served and unknown paths are not", async (t) => {
	const { server } = await setup(t);
	const metrics = await fetch(`http://127.0.0.1:${server.port}/metrics`);
	assert.equal(metrics.status, 200);
	const body = (await metrics.json()) as { counters: Record<string, number> };
	assert.deepEqual(body.counters, {});

	const missing = await fetch(`http://127.0.0.1:${server.port}/`);
	assert.equal(missing.status, 404);
});
