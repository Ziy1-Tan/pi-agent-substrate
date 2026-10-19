import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { WebChannel } from "../src/channel/web.js";
import { EchoBackend } from "../src/backend/echo.js";
import { createConversation } from "../src/gateway/conversations.js";
import { Gateway } from "../src/gateway/gateway.js";
import { GatewayManager, actorNameFor } from "../src/gateway/manager.js";
import { Metrics } from "../src/metrics.js";
import { TestChannel } from "./support/test-channel.js";

async function tempRoot(t: test.TestContext): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "pi-m4-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	return root;
}

test("actor names are deterministic and legal", () => {
	assert.equal(actorNameFor("local/chat"), "pi-local-chat");
	assert.equal(actorNameFor("Team Alpha/General"), "pi-team-alpha-general");
	assert.equal(actorNameFor("///"), "pi-conversation");
	assert.ok(actorNameFor("x".repeat(100)).length <= 43);
	assert.equal(actorNameFor("local/chat"), actorNameFor("local/chat"));
});

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
		backend: new EchoBackend({ chunkSize: 4 }),
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
	assert.equal(finals[0]?.value.text, "Echo: replay this");

	// Reconnecting twice with the same cursor yields the same window.
	assert.deepEqual(
		channel.replay(seen).map((event) => event.seq),
		replayed.map((event) => event.seq),
	);
	assert.equal(channel.hasGap(seen), false);
});

test("an upload lands in the conversation's incoming directory and shows up in the prompt", async (t) => {
	const root = await tempRoot(t);
	const conversation = await createConversation(root, "local/chat");
	const channel = new WebChannel({
		conversationId: "local/chat",
		filesDir: conversation.filesDir,
	});
	const gateway = new Gateway({ conversation, channel, backend: new EchoBackend() });
	await gateway.start();
	t.after(() => gateway.stop());

	const saved = await channel.saveUploads("msg-1", [
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
	const channel = new WebChannel({ conversationId: "local/chat", filesDir: conversation.filesDir });

	const saved = await channel.saveUploads("msg-2", [
		{ name: "../../escape.txt", data: Buffer.from("x").toString("base64") },
	]);
	assert.equal(saved[0]?.name, "escape.txt");
	assert.ok(saved[0]?.path.startsWith(conversation.filesDir), saved[0]?.path);
});

test("the manager keeps one actor per conversation and isolates failures", async (t) => {
	const root = await tempRoot(t);
	const ensured: string[] = [];
	const manager = new GatewayManager({
		dataDir: root,
		actorUrl: "ws://127.0.0.1:1",
		control: {
			async ensure(actor) {
				ensured.push(actor.name);
			},
			async suspend() {},
			async state() {
				return "running" as const;
			},
		},
	});

	const spec = (conversationId: string) => ({
		conversationId,
		atespace: "pi-agents",
		template: "pi-actor",
		idleMs: 60_000,
	});

	const a = await manager.ensure(spec("local/a"));
	const again = await manager.ensure(spec("local/a"));
	assert.equal(a, again, "the same conversation is opened once");
	const b = await manager.ensure(spec("local/b"));
	assert.notEqual(a.actor.name, b.actor.name, "conversations never share an actor");
	assert.deepEqual(ensured.sort(), ["pi-local-a", "pi-local-b"]);

	// A conversation that never opened reports a clear error and leaves the
	// others untouched.
	await assert.rejects(
		manager.receive("local/missing", { userId: "u", text: "hi" }),
		/unknown conversation/,
	);

	await manager.close();
});

test("metrics report percentiles over recent turns and mark resumed turns", async (t) => {
	const root = await tempRoot(t);
	const conversation = await createConversation(root, "local/chat");
	const metrics = new Metrics();
	let resumedNext = false;
	const gateway = new Gateway({
		conversation,
		channel: new TestChannel(),
		backend: new EchoBackend({ chunkSize: 8 }),
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
