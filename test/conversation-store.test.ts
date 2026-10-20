import assert from "node:assert/strict";
import { appendFile, copyFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import { Gateway } from "../src/host/gateway.js";
import { ConversationStore, createConversation } from "../src/host/conversation/store.js";
import { readRecords, recordTypes } from "./support/records.js";
import { StubBackend } from "./support/stub-backend.js";
import { TestChannel } from "./support/test-channel.js";

/** A log the vendored pi-chat runtime wrote: one finished turn, one cut off after dispatch. */
const LEGACY_LOG = resolve("test/fixtures/legacy-channel.jsonl");

async function tempRoot(t: test.TestContext): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "pi-store-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	return root;
}

test("a log written by the earlier runtime resumes its unfinished turn", async (t) => {
	const conversation = await createConversation(await tempRoot(t), "local/chat");
	await copyFile(LEGACY_LOG, conversation.logPath);

	const store = await ConversationStore.open(conversation, "test-owner");
	const pending = store.unfinishedJobs();
	assert.equal(pending.length, 1, "only the cut-off turn is unfinished");
	const [job] = pending;
	assert.ok(job);
	const state = store.jobState(job.jobId);
	assert.equal(state.requestId, job.jobId, "the recorded request id is reused");
	assert.equal(state.outbound, undefined);
	const { prompt, triggerMessageId } = store.promptFor(job);
	assert.equal(triggerMessageId, "m2");
	assert.match(prompt, /alice: second$/);
	assert.doesNotMatch(prompt, /first/, "the answered message is not asked again");
	await store.close();

	const backend = new StubBackend({ delayMs: 0 });
	const channel = new TestChannel();
	const gateway = new Gateway({ conversation, channel, backend });
	await gateway.start();
	await gateway.waitForIdle();
	await gateway.stop();

	assert.deepEqual(backend.executedRequestIds, [job.jobId]);
	assert.equal(channel.sent[0]?.text, "Reply: second");
	const records = await readRecords(conversation.logPath);
	assert.deepEqual(recordTypes(records).slice(-3), ["checkpoint", "outbound", "job_completed"]);
	assert.equal(records.at(-1)?.recordId, 11, "record ids continue past the legacy records");
});

test("a line cut short by a crash is dropped, damage elsewhere is reported", async (t) => {
	const conversation = await createConversation(await tempRoot(t), "local/chat");
	await copyFile(LEGACY_LOG, conversation.logPath);
	await appendFile(conversation.logPath, '{"type":"outbound","recordId":10,"te');

	const store = await ConversationStore.open(conversation, "test-owner");
	assert.equal(store.unfinishedJobs().length, 1);
	await store.close();

	const log = await readFile(LEGACY_LOG, "utf8");
	await writeFile(conversation.logPath, `{"type":"inbound",\n${log}`);
	await assert.rejects(ConversationStore.open(conversation, "test-owner"), /channel\.jsonl:1 is not a JSON record/);
});

test("a lock held by a live gateway is respected, one left by a dead one is taken over", async (t) => {
	const conversation = await createConversation(await tempRoot(t), "local/chat");
	const held = await ConversationStore.open(conversation, `gateway-${process.pid}-held`);
	await assert.rejects(ConversationStore.open(conversation, "second"), /already locked/);
	await held.close();

	// No process has pid 2^22 + 1 on Linux or macOS; `pi-chat-` is the format
	// the earlier runtime wrote.
	await writeFile(conversation.lockPath, `pi-chat-${2 ** 22 + 1}-stale\n`);
	const taken = await ConversationStore.open(conversation, "third");
	assert.equal((await readFile(conversation.lockPath, "utf8")).trim(), "third");
	await taken.close();
});
