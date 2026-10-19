import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { WebChannel } from "../src/channel/web.js";
import { Gateway } from "../src/gateway/gateway.js";
import { createConversation } from "../src/gateway/conversations.js";
import { StubBackend } from "./support/stub-backend.js";

async function tempRoot(t: test.TestContext): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "pi-web-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	return root;
}

test("a reconnect replays only the frames it missed", async (t) => {
	const root = await tempRoot(t);
	const conversation = await createConversation(root, "local/chat");
	const channel = new WebChannel({
		conversationId: "local/chat",
		filesDir: conversation.filesDir,
	});
	const delivered: number[] = [];
	channel.onEvent((event) => delivered.push(event.seq));

	const gateway = new Gateway({
		conversation,
		channel,
		backend: new StubBackend({ chunkSize: 4 }),
	});
	await gateway.start();
	t.after(() => gateway.stop());

	await gateway.receive({ userId: "u", userName: "alice", text: "replay this" });
	await gateway.waitForIdle();

	assert.ok(delivered.length > 2, "previews plus the final event were recorded");
	const lastLive = delivered.at(-1) ?? 0;
	const seen = delivered[Math.floor(delivered.length / 2)] ?? 0;

	const replayed = channel.replay(seen);
	assert.equal(replayed[0]?.seq, seen + 1, "replay starts immediately after what the client saw");
	assert.equal(replayed.at(-1)?.seq, lastLive, "replay reaches the newest event");
	assert.equal(replayed.length, delivered.length - delivered.indexOf(seen) - 1);

	// The authoritative final text is present exactly once.
	const finals = channel.replay(0).filter((event) => event.value.type === "final");
	assert.equal(finals.length, 1);
	assert.equal(finals[0]?.value.text, "Reply: replay this");

	// Reconnecting twice with the same cursor yields the same window.
	assert.deepEqual(
		channel.replay(seen).map((event) => event.seq),
		replayed.map((event) => event.seq),
	);
	assert.equal(channel.hasGap(seen), false);
});

