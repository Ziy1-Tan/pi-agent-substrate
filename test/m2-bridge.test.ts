import assert from "node:assert/strict";
import test from "node:test";

import { createBridgeHarness } from "./support/bridge-harness.js";

/** Pi sends content as blocks; the mock provider sees them as chat messages. */
function promptText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((block): block is { type: string; text?: string } => typeof block === "object" && block !== null)
		.map((block) => (block.type === "text" ? (block.text ?? "") : ""))
		.join("");
}

test("bridge relays a prompt to pi and streams the reply back", async (t) => {
	const harness = await createBridgeHarness("Hello from pi rpc.");
	t.after(() => harness.close());
	const client = await harness.open();
	t.after(() => client.close());

	const response = await client.request({ id: "req-1", type: "prompt", message: "say hi" });
	assert.equal(response.command, "prompt");
	assert.equal(response.success, true);
	assert.equal(response.id, "req-1");

	const result = await client.waitFor((event) => event.type === "bridge_result");
	assert.equal(result.requestId, "req-1");
	assert.equal(result.text, "Hello from pi rpc.");
	assert.ok(
		client.events.some((event) => event.type === "message_update"),
		"streaming deltas reached the client",
	);
	assert.ok(client.events.some((event) => event.type === "agent_settled"), "settled event reached the client");

	const prompt = harness.llm.requests.at(-1);
	assert.ok(prompt, "the mock provider received the turn");
	const messages = prompt.messages as Array<{ role: string; content: unknown }>;
	assert.ok(messages.some((message) => message.role === "user" && promptText(message.content).includes("say hi")));
});

test("bridge answers get_state through pi", async (t) => {
	const harness = await createBridgeHarness("ok");
	t.after(() => harness.close());
	const client = await harness.open();
	t.after(() => client.close());

	const response = await client.request({ id: "state-1", type: "get_state" });
	assert.equal(response.command, "get_state");
	const data = response.data as Record<string, unknown>;
	assert.equal(typeof data.sessionId, "string");
});

test("bridge serves bridge_state and retains the last turn result", async (t) => {
	const harness = await createBridgeHarness("remember me");
	t.after(() => harness.close());
	const client = await harness.open();
	t.after(() => client.close());

	await client.request({ id: "req-1", type: "prompt", message: "hello" });
	await client.waitFor((event) => event.type === "bridge_result" && event.requestId === "req-1");

	client.send({ id: "state-1", type: "bridge_get_state", requestId: "req-1" });
	const state = await client.waitFor((event) => event.type === "bridge_state" && event.id === "state-1");
	assert.equal(state.streaming, false);
	assert.deepEqual(state.result, { requestId: "req-1", text: "remember me" });

	client.send({ id: "lookup-1", type: "bridge_result", requestId: "req-1" });
	const lookup = await client.waitFor((event) => event.type === "bridge_result_reply" && event.id === "lookup-1");
	assert.equal(lookup.found, true);
	assert.deepEqual(lookup.result, { requestId: "req-1", text: "remember me" });
});

test("a second prompt continues the same session", async (t) => {
	const harness = await createBridgeHarness("second reply");
	t.after(() => harness.close());
	const client = await harness.open();
	t.after(() => client.close());

	await client.request({ id: "req-1", type: "prompt", message: "first" });
	await client.waitFor((event) => event.type === "bridge_result" && event.requestId === "req-1");
	await client.request({ id: "req-2", type: "prompt", message: "second" });
	await client.waitFor((event) => event.type === "bridge_result" && event.requestId === "req-2");

	const second = harness.llm.requests.at(-1);
	const messages = second?.messages as Array<{ role: string; content: unknown }>;
	const users = messages.filter((message) => message.role === "user").map((message) => promptText(message.content));
	assert.equal(users.length, 2, "the second request carries the first turn's history");
	assert.ok(users[0]?.includes("first"));
	assert.ok(users[1]?.includes("second"));
});

test("a provider failure is reported as an error, not an empty reply", async (t) => {
	// Pi turns a provider failure into an assistant message with
	// `stopReason: "error"`. The bridge has to say so: otherwise the gateway
	// records an empty reply and the user sees silence instead of the reason.
	const harness = await createBridgeHarness("unused");
	t.after(() => harness.close());
	const client = await harness.open();
	t.after(() => client.close());
	harness.llm.failWith(503, "upstream is down");

	await client.request({ id: "req-fail", type: "prompt", message: "say hi" });
	const result = await client.waitFor(
		(event) => event.type === "bridge_result" && event.requestId === "req-fail",
	);
	assert.equal(result.text, "");
	assert.match(String(result.error), /upstream is down/);
});
