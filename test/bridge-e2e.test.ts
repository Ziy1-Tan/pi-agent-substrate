import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import { PiBackend } from "../src/host/backend.js";
import { startBridge, type Bridge } from "../src/sandbox/bridge.js";
import { createConversation } from "../src/host/conversation/store.js";
import { Gateway } from "../src/host/gateway.js";
import { WebSocketTransport } from "../src/host/websocket.js";
import { resolvePiBin, startMockLlm, writePiConfig } from "./support/bridge-harness.js";
import { readRecords, recordTypes } from "./support/records.js";
import { TestChannel } from "./support/test-channel.js";

interface E2EHarness {
	root: string;
	conversation: Awaited<ReturnType<typeof createConversation>>;
	channel: TestChannel;
	gateway: Gateway;
	/** Stops the actor the way a suspend would, keeping its workspace. */
	suspend(): Promise<void>;
	/** Starts a fresh actor process over the same workspace. */
	resume(): Promise<void>;
	close(): Promise<void>;
}

async function createE2E(t: TestContext, text: string): Promise<E2EHarness> {
	const root = await mkdtemp(join(tmpdir(), "pi-e2e-"));
	const llm = await startMockLlm(text);
	const agentDir = join(root, "agent");
	const workspace = join(root, "workspace");
	await writePiConfig(agentDir, llm.url);
	const conversation = await createConversation(join(root, "gateway"));
	const channel = new TestChannel();
	// One port for the conversation: a resume puts a new process on it.
	const port = 18_700 + Math.floor(Math.random() * 200);

	let bridge: Bridge | undefined;
	const startActor = async () => {
		bridge = await startBridge({
			piCommand: resolvePiBin(),
			piArgs: ["--provider", "mock", "--model", "mock-model", "--no-tools"],
			sessionDir: join(workspace, "sessions"),
			piEnv: { PI_CODING_AGENT_DIR: agentDir },
			port,
			log: process.env.PI_E2E_LOG ? (message) => console.error(`[bridge] ${message}`) : () => undefined,
		});
	};
	await startActor();

	const transport = new WebSocketTransport({
		url: `ws://127.0.0.1:${port}`,
		log: process.env.PI_E2E_LOG ? (message) => console.error(`[transport] ${message}`) : () => undefined,
	});
	const backend = new PiBackend({ transport, turnTimeoutMs: 30_000 });
	await backend.connect();
	const gateway = new Gateway({ conversation, channel, backend });
	await gateway.start();

	const harness: E2EHarness = {
		root,
		conversation,
		channel,
		gateway,
		async suspend() {
			await bridge?.close();
			bridge = undefined;
			// No lifecycle controller here: close the socket the way a
			// restart would, so the next message opens a fresh one.
			await transport.close();
		},
		async resume() {
			if (!bridge) {
				await startActor();
				await transport.connect();
			}
		},
		async close() {
			await gateway.stop().catch(() => undefined);
			await bridge?.close().catch(() => undefined);
			await llm.close();
			await rm(root, { recursive: true, force: true });
		},
	};
	t.after(() => harness.close());
	return harness;
}

test("channel message reaches real pi and streams the reply back", async (t) => {
	const harness = await createE2E(t, "Hello from pi rpc.");

	await harness.gateway.receive({ userId: "user-1", userName: "alice", text: "hello pi" });
	await harness.gateway.waitForIdle();

	assert.equal(harness.channel.sent.length, 1);
	assert.equal(harness.channel.sent[0]?.text, "Hello from pi rpc.");
	assert.ok(harness.channel.previews.length > 1, "the reply streamed through preview edits");

	const records = await readRecords(harness.conversation.logPath);
	assert.deepEqual(recordTypes(records), [
		"inbound",
		"job_queued",
		"job_dispatched",
		"outbound",
		"job_completed",
	]);
});

test("a suspended actor resumes on the next message with its session intact", async (t) => {
	const harness = await createE2E(t, "still here");

	await harness.gateway.receive({ userId: "user-1", userName: "alice", text: "remember: 41" });
	await harness.gateway.waitForIdle();
	assert.equal(harness.channel.sent.length, 1);

	await harness.suspend();
	await harness.resume();

	await harness.gateway.receive({ userId: "user-1", userName: "alice", text: "what did I say?" });
	await harness.gateway.waitForIdle();

	assert.equal(harness.channel.sent.length, 2);
	assert.equal(harness.channel.sent[1]?.text, "still here");

	const records = await readRecords(harness.conversation.logPath);
	assert.equal(records.filter((record) => record.type === "outbound").length, 2);
	const dispatches = records.filter((record) => record.type === "job_dispatched");
	assert.equal(new Set(dispatches.map((record) => ("requestId" in record ? record.requestId : ""))).size, 2);
});
