import assert from "node:assert/strict";
import { appendFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ConversationStore, createConversation } from "../src/host/conversation/store.js";

async function tempRoot(t: test.TestContext): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "pi-store-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	return root;
}

test("a line cut short by a crash is dropped, damage elsewhere is reported", async (t) => {
	const conversation = await createConversation(await tempRoot(t), "local/chat");
	const store = await ConversationStore.open(conversation, "test-owner");
	await store.appendInbound({
		userId: "u1",
		userName: "alice",
		text: "hello",
		messageId: "m1",
	});
	await store.close();
	await appendFile(conversation.logPath, '{"type":"outbound","recordId":10,"te');

	const reopened = await ConversationStore.open(conversation, "test-owner");
	assert.equal(reopened.unfinishedJobs().length, 1);
	await reopened.close();

	const log = await readFile(conversation.logPath, "utf8");
	await writeFile(conversation.logPath, `{"type":"inbound",\n${log}`);
	await assert.rejects(ConversationStore.open(conversation, "test-owner"), /channel\.jsonl:1 is not a JSON record/);
});

test("a lock held by a live gateway is respected, one left by a dead one is taken over", async (t) => {
	const conversation = await createConversation(await tempRoot(t), "local/chat");
	const held = await ConversationStore.open(conversation, `gateway-${process.pid}-held`);
	await assert.rejects(ConversationStore.open(conversation, "second"), /already locked/);
	await held.close();

	// No process has pid 2^22 + 1 on Linux or macOS.
	await writeFile(conversation.lockPath, `gateway-${2 ** 22 + 1}-stale\n`);
	const taken = await ConversationStore.open(conversation, "third");
	assert.equal((await readFile(conversation.lockPath, "utf8")).trim(), "third");
	await taken.close();
});
