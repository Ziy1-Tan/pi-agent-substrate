import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { MAX_UPLOAD_BYTES, saveUploads } from "../src/host/channel/files.js";
import { NullChannel } from "../src/host/null-channel.js";
import { Gateway } from "../src/host/gateway.js";
import { createConversation } from "../src/host/conversation/store.js";
import { StubBackend } from "./support/stub-backend.js";

async function tempRoot(t: test.TestContext): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "pi-uploads-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	return root;
}

test("an upload lands in the conversation's incoming directory and shows up in the prompt", async (t) => {
	const root = await tempRoot(t);
	const conversation = await createConversation(root, "local/chat");
	const channel = new NullChannel();
	const gateway = new Gateway({ conversation, channel, backend: new StubBackend() });
	await gateway.start();
	t.after(() => gateway.stop());

	const saved = await saveUploads(conversation.filesDir, "msg-1", [
		{ name: "notes.txt", mimeType: "text/plain", data: Buffer.from("attachment body").toString("base64") },
	]);
	assert.equal(saved.length, 1);
	const source = saved[0]?.path ?? "";
	assert.ok((await stat(source)).isFile());

	await gateway.receive({
		userId: "u",
		userName: "alice",
		text: "what is in the file",
		messageId: "msg-1",
		attachments: saved,
	});
	await gateway.waitForIdle();

	const record = JSON.parse((await readFile(conversation.logPath, "utf8")).trim().split("\n")[0] ?? "{}");
	assert.equal(record.type, "inbound");
	assert.equal(record.attachments.length, 1);
	assert.match(record.attachments[0].localPath, /\/incoming\//);
	assert.equal(await readFile(record.attachments[0].localPath, "utf8"), "attachment body");
});

test("an upload cannot escape the conversation directory", async (t) => {
	const root = await tempRoot(t);
	const conversation = await createConversation(root, "local/chat");

	const saved = await saveUploads(conversation.filesDir, "msg-2", [
		{ name: "../../escape.txt", data: Buffer.from("x").toString("base64") },
	]);
	assert.equal(saved[0]?.name, "escape.txt");
	assert.ok(saved[0]?.path.startsWith(conversation.filesDir), saved[0]?.path);
});


test("uploads are decoded, capped, and kept inside the files directory", async (t) => {
	const dir = await mkdtemp(join(tmpdir(), "pi-uploads-cap-"));
	t.after(() => rm(dir, { recursive: true, force: true }));

	const [saved] = await saveUploads(dir, "msg-1", [
		{ name: "../../escape.txt", data: Buffer.from("body").toString("base64") },
	]);
	assert.equal(saved?.name, "escape.txt");
	assert.ok(saved?.path.startsWith(dir));

	await assert.rejects(
		saveUploads(dir, "msg-2", [
			{ name: "big.bin", data: Buffer.alloc(MAX_UPLOAD_BYTES + 1).toString("base64") },
		]),
		/exceeds/,
	);
	assert.ok((await stat(saved?.path ?? "")).isFile());
});
