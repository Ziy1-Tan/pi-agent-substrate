import assert from "node:assert/strict";
import test from "node:test";

import { splitMessage, TelegramChannel } from "../src/channel/telegram.js";
import { MAX_UPLOAD_BYTES, saveUploads } from "../src/channel/uploads.js";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

interface Call {
	method: string;
	body: Record<string, unknown>;
}

/** A Bot API stand-in that records calls and answers with message ids. */
function telegramStub(): {
	fetchImpl: typeof fetch;
	calls: Call[];
	failNext: () => void;
} {
	const calls: Call[] = [];
	let nextId = 100;
	let fail = false;
	const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
		const url = String(input);
		const method = url.slice(url.lastIndexOf("/") + 1);
		const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
		calls.push({ method, body });
		if (fail) {
			fail = false;
			return new Response(JSON.stringify({ ok: false, description: "Too Many Requests" }), { status: 429 });
		}
		if (method === "editMessageText") {
			return new Response(JSON.stringify({ ok: true, result: { message_id: body.message_id } }), { status: 200 });
		}
		const result = method === "sendMessage" ? { message_id: nextId++ } : true;
		return new Response(JSON.stringify({ ok: true, result }), { status: 200 });
	}) as typeof fetch;
	return {
		fetchImpl,
		calls,
		failNext: () => {
			fail = true;
		},
	};
}

test("a turn is one message edited in place, then split when it is long", async () => {
	const stub = telegramStub();
	const channel = new TelegramChannel({
		botToken: "token",
		chatId: "42",
		apiBase: "http://telegram.test",
		previewIntervalMs: 0,
		fetchImpl: stub.fetchImpl,
	});

	await channel.syncPreview("Hel");
	await channel.syncPreview("Hello");
	const sentId = await channel.send({ deliveryId: "req-1", text: "Hello there" });

	assert.equal(stub.calls[0]?.method, "sendMessage");
	assert.equal(stub.calls[0]?.body.chat_id, "42");
	assert.equal(stub.calls.at(-1)?.method, "editMessageText", "the final text overwrites the preview");
	assert.equal(sentId, String(stub.calls[0]?.body.message_id ?? 100));
});

test("a reply longer than the platform limit arrives as several messages", async () => {
	const stub = telegramStub();
	const channel = new TelegramChannel({
		botToken: "token",
		chatId: "42",
		apiBase: "http://telegram.test",
		fetchImpl: stub.fetchImpl,
	});
	const long = ["a".repeat(3_000), "b".repeat(3_000)].join("\n\n");
	await channel.send({ deliveryId: "req-2", text: long });

	const sends = stub.calls.filter((call) => call.method === "sendMessage");
	assert.equal(sends.length, 2);
	assert.ok(String(sends[0]?.body.text).length <= 4_096);
	// The split trims the blank line it breaks on; nothing else is lost.
	assert.equal(
		`${sends[0]?.body.text}\n\n${sends[1]?.body.text}`,
		long,
	);
});

test("previews are throttled but the first one always goes out", async () => {
	const stub = telegramStub();
	const channel = new TelegramChannel({
		botToken: "token",
		chatId: "42",
		apiBase: "http://telegram.test",
		previewIntervalMs: 10_000,
		fetchImpl: stub.fetchImpl,
	});
	await channel.syncPreview("a");
	await channel.syncPreview("ab");
	await channel.syncPreview("abc");
	assert.equal(stub.calls.filter((call) => call.method === "sendMessage").length, 1);
});

test("a failed edit falls back to a fresh message", async () => {
	const stub = telegramStub();
	const channel = new TelegramChannel({
		botToken: "token",
		chatId: "42",
		apiBase: "http://telegram.test",
		fetchImpl: stub.fetchImpl,
	});
	await channel.syncPreview("draft");
	stub.failNext();
	const id = await channel.send({ deliveryId: "req-3", text: "final" });
	assert.ok(id !== undefined, "the reply still lands");
	assert.equal(stub.calls.at(-1)?.method, "sendMessage");
});

test("splitMessage prefers paragraph breaks and never drops text", () => {
	const text = `${"x".repeat(50)}\n\n${"y".repeat(50)}`;
	const parts = splitMessage(text, 60);
	assert.equal(parts.join("\n\n"), text);
	assert.ok(parts.every((part) => part.length <= 60));
});

test("uploads are decoded, capped, and kept inside the files directory", async (t) => {
	const dir = await mkdtemp(join(tmpdir(), "pi-uploads-"));
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
