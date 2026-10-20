import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { StubBackend } from "./support/stub-backend.js";
import { startHttpServer, type HttpServer } from "../src/host/channel/server.js";
import { TelegramChannel } from "../src/host/channel/telegram.js";
import { TelegramPoll } from "../src/host/channel/telegram-poll.js";
import { GatewayManager } from "../src/host/manager.js";

interface Setup {
	server: HttpServer;
	manager: GatewayManager;
	root: string;
}

async function setup(t: test.TestContext, telegram = false): Promise<Setup> {
	const root = await mkdtemp(join(tmpdir(), "pi-entry-"));
	const manager = new GatewayManager({
		dataDir: root,
		actorUrl: "ws://127.0.0.1:1",
		control: {
			async ensure() {},
			async suspend() {},
			async state() {
				return "running" as const;
			},
		},
		createBackend: () => new StubBackend({ chunkSize: 40, delayMs: 0 }),
		createChannel: telegram
			? (conversation) =>
					new TelegramChannel({
						botToken: "token",
						chatId: conversation.conversationId.replace("telegram/", ""),
						apiBase: "http://telegram.test",
						previewIntervalMs: 0,
						fetchImpl: telegramApi().fetchImpl,
					})
			: undefined,
	});
	const server = await startHttpServer({
		manager,
		port: 0,
		specFor: (conversationId) => ({
			conversationId,
			atespace: "pi-agents",
			template: "pi-actor",
			idleMs: 60_000,
		}),
	});
	t.after(async () => {
		await server.close();
		await manager.close();
		await rm(root, { recursive: true, force: true });
	});
	return { server, manager, root };
}

test("curl posts a message and reads the settled reply in the response", async (t) => {
	const { server } = await setup(t);
	const response = await fetch(`http://127.0.0.1:${server.port}/messages`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ conversation: "cli/one", text: "hello from curl" }),
	});
	assert.equal(response.status, 200);
	const body = (await response.json()) as { conversation: string; messageId: string; text: string };
	assert.equal(body.conversation, "cli/one");
	assert.equal(body.text, "Reply: hello from curl");
	assert.ok(body.messageId.length > 0);
});

test("a second turn in the same conversation sees the earlier one", async (t) => {
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
	const body = (await metrics.json()) as { counters: Record<string, number>; timings: Record<string, unknown> };
	assert.deepEqual(body.counters, {});
	assert.deepEqual(body.timings, {});

	const missing = await fetch(`http://127.0.0.1:${server.port}/`);
	assert.equal(missing.status, 404);
});

test("a telegram chat becomes its own conversation and replies in the chat", async (t) => {
	const api = telegramApi();
	const root = await mkdtemp(join(tmpdir(), "pi-entry-telegram-"));
	const manager = new GatewayManager({
		dataDir: root,
		actorUrl: "ws://127.0.0.1:1",
		control: {
			async ensure() {},
			async suspend() {},
			async state() {
				return "running" as const;
			},
		},
		createBackend: () => new StubBackend({ chunkSize: 40, delayMs: 0 }),
		createChannel: (conversation) =>
			new TelegramChannel({
				botToken: "token",
				chatId: conversation.conversationId.replace("telegram/", ""),
				apiBase: "http://telegram.test",
				previewIntervalMs: 0,
				fetchImpl: api.fetchImpl,
			}),
	});
	t.after(async () => {
		await manager.close();
		await rm(root, { recursive: true, force: true });
	});

	const poll = new TelegramPoll(manager, {
		botToken: "token",
		apiBase: "http://telegram.test",
		fetchImpl: api.fetchImpl,
		specFor: (conversationId) => ({
			conversationId,
			atespace: "pi-agents",
			template: "pi-actor",
			idleMs: 60_000,
		}),
	});
	// One update, then the poll is stopped by the abort signal.
	await poll.run(asSoonAsAborted());
	assert.equal(manager.get("telegram/42") !== undefined, true, "the chat opened a conversation");
	const sends = api.calls.filter((call) => call.method === "sendMessage");
	assert.ok(sends.length > 0, "the bot replied in the chat");
	assert.equal(sends.at(-1)?.body.chat_id, "42");
	assert.match(String(sends.at(-1)?.body.text), /Reply: hello from telegram/);
});

interface Api {
	fetchImpl: typeof fetch;
	calls: Array<{ method: string; body: Record<string, unknown> }>;
}

/** A Bot API stand-in: getUpdates yields one message, sends are recorded. */
function telegramApi(): Api {
	const calls: Array<{ method: string; body: Record<string, unknown> }> = [];
	let delivered = false;
	let nextId = 500;
	const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
		const url = String(input);
		const method = url.slice(url.lastIndexOf("/") + 1);
		const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
		calls.push({ method, body });
		if (method === "getUpdates") {
			if (delivered) {
				// Block until the caller aborts, like a real long poll.
				await new Promise((resolve) => setTimeout(resolve, 50));
				return Response.json({ ok: true, result: [] });
			}
			delivered = true;
			return Response.json({
				ok: true,
				result: [
					{
						update_id: 1,
						message: {
							message_id: 7,
							text: "hello from telegram",
							chat: { id: 42, type: "private" },
							from: { id: 9, username: "alice" },
						},
					},
				],
			});
		}
		const result = method === "sendMessage" ? { message_id: nextId++ } : true;
		return Response.json({ ok: true, result });
	}) as typeof fetch;
	return { fetchImpl, calls };
}

/** An abort signal that fires shortly after the first update is handled. */
function asSoonAsAborted(): AbortSignal {
	const controller = new AbortController();
	setTimeout(() => controller.abort(), 300);
	return controller.signal;
}
