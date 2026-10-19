import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import WebSocket from "ws";

import { EchoBackend } from "../src/backend/echo.js";
import { startWebServer, type WebServer } from "../src/channel/server.js";
import { GatewayManager } from "../src/gateway/manager.js";

interface Frame {
	seq?: number;
	type?: string;
	text?: string;
	state?: string;
	lastSeq?: number;
	conversation?: string;
	records?: unknown[];
	queueLength?: number;
	hasActiveJob?: boolean;
}

/** Opens a browser-side socket and collects frames in arrival order. */
async function connect(port: number, conversation: string, since?: number): Promise<{
	socket: WebSocket;
	frames: Frame[];
	waitFor: (predicate: (frame: Frame) => boolean, label: string) => Promise<Frame>;
	send: (payload: unknown) => void;
}> {
	const query = `conversation=${encodeURIComponent(conversation)}${since === undefined ? "" : `&since=${since}`}`;
	const socket = new WebSocket(`ws://127.0.0.1:${port}/events?${query}`);
	const frames: Frame[] = [];
	const waiting: Array<() => void> = [];
	socket.on("message", (data: Buffer) => {
		frames.push(JSON.parse(String(data)) as Frame);
		for (const wake of waiting.splice(0)) wake();
	});
	await new Promise<void>((resolve, reject) => {
		socket.once("open", () => resolve());
		socket.once("error", reject);
	});
	return {
		socket,
		frames,
		async waitFor(predicate, label) {
			const deadline = Date.now() + 5_000;
			for (;;) {
				const found = frames.find(predicate);
				if (found) return found;
				if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}: ${JSON.stringify(frames)}`);
				await new Promise<void>((resolve) => {
					waiting.push(resolve);
					setTimeout(resolve, 50);
				});
			}
		},
		send(payload) {
			socket.send(JSON.stringify(payload));
		},
	};
}

async function setup(t: test.TestContext): Promise<{ server: WebServer; root: string }> {
	const root = await mkdtemp(join(tmpdir(), "pi-m4-web-"));
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
		createBackend: () => new EchoBackend({ chunkSize: 5 }),
	});
	const server = await startWebServer({
		manager,
		port: 0,
		uiDir: join(process.cwd(), "src/channel"),
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
	return { server, root };
}

test("the page and metrics endpoints are served", async (t) => {
	const { server } = await setup(t);
	const page = await fetch(`http://127.0.0.1:${server.port}/`);
	assert.equal(page.status, 200);
	assert.match(await page.text(), /pi-agent-substrate/);

	const metrics = await fetch(`http://127.0.0.1:${server.port}/metrics`);
	assert.equal(metrics.status, 200);
	const body = (await metrics.json()) as { counters: Record<string, number>; timings: Record<string, unknown> };
	assert.deepEqual(body.counters, {});
	assert.deepEqual(body.timings, {});
});

test("a browser turn streams previews and ends with the final text", async (t) => {
	const { server } = await setup(t);
	const client = await connect(server.port, "local/chat");
	t.after(() => client.socket.close());

	await client.waitFor((frame) => frame.type === "hello", "hello");
	client.send({ type: "message", text: "hello from the browser" });

	const final = await client.waitFor((frame) => frame.type === "final", "final");
	assert.equal(final.text, "Echo: hello from the browser");
	// Previews carry the accumulated reply, so the newest one already matches.
	const previews = client.frames.filter((frame) => frame.type === "preview").map((frame) => frame.text ?? "");
	assert.ok(previews.length > 1, "the reply arrived in pieces");
	assert.equal(previews.at(-1), final.text);
	for (let index = 1; index < previews.length; index++) {
		assert.ok((previews[index] ?? "").startsWith(previews[index - 1] ?? ""));
	}

	const sequences = client.frames.filter((frame) => frame.seq !== undefined).map((frame) => frame.seq ?? 0);
	assert.deepEqual(sequences, [...sequences].sort((a, b) => a - b), "sequence numbers arrive in order");
});

test("reconnecting with a cursor replays the missed frames without duplicates", async (t) => {
	const { server } = await setup(t);
	const first = await connect(server.port, "local/chat");
	await first.waitFor((frame) => frame.type === "hello", "hello");

	// Drop the socket as soon as the stream is under way, then resume from the
	// last sequence the client actually saw.
	first.send({ type: "message", text: "drop me mid stream" });
	const early = await first.waitFor((frame) => frame.type === "preview", "first preview");
	first.socket.close();
	const seenUpTo = early.seq ?? 0;

	const resumed = await connect(server.port, "local/chat", seenUpTo);
	t.after(() => resumed.socket.close());
	const hello = await resumed.waitFor((frame) => frame.type === "hello", "hello after reconnect");
	assert.ok((hello.lastSeq ?? 0) > seenUpTo);

	const replayed = resumed.frames.filter((frame) => frame.type === "preview").map((frame) => frame.seq ?? 0);
	assert.ok(replayed.length > 0, "the missed previews were replayed");
	assert.equal(Math.min(...replayed), seenUpTo + 1, "replay begins right after the last seen sequence");
	assert.equal(new Set(replayed).size, replayed.length, "no frame is delivered twice");

	const final = await resumed.waitFor((frame) => frame.type === "final", "final after reconnect");
	assert.equal(final.text, "Echo: drop me mid stream");
});

test("status, history, and stop are answered per conversation", async (t) => {
	const { server } = await setup(t);
	const client = await connect(server.port, "local/chat");
	t.after(() => client.socket.close());
	await client.waitFor((frame) => frame.type === "hello", "hello");

	client.send({ type: "message", text: "remember this" });
	await client.waitFor((frame) => frame.type === "final", "final");

	client.send({ type: "history" });
	const history = await client.waitFor((frame) => frame.type === "history", "history");
	const records = (history.records ?? []) as Array<{ type: string; text?: string }>;
	assert.deepEqual(
		records.map((record) => record.type),
		["inbound", "outbound"],
	);
	assert.equal(records.at(-1)?.text, "Echo: remember this");

	client.send({ type: "status" });
	const status = await client.waitFor((frame) => frame.type === "status" && frame.queueLength !== undefined, "status");
	assert.equal(status.hasActiveJob, false);

	client.send({ type: "stop" });
	client.send({ type: "bogus" });
	const error = await client.waitFor((frame) => frame.type === "error", "error for unknown command");
	assert.match(error.text ?? "", /unknown command/);
});

test("two conversations keep separate logs and separate actors", async (t) => {
	const { server, root } = await setup(t);
	const alpha = await connect(server.port, "team/alpha");
	const beta = await connect(server.port, "team/beta");
	t.after(() => {
		alpha.socket.close();
		beta.socket.close();
	});
	await alpha.waitFor((frame) => frame.type === "hello", "alpha hello");
	await beta.waitFor((frame) => frame.type === "hello", "beta hello");

	alpha.send({ type: "message", text: "alpha only" });
	beta.send({ type: "message", text: "beta only" });
	await alpha.waitFor((frame) => frame.type === "final", "alpha final");
	await beta.waitFor((frame) => frame.type === "final", "beta final");

	assert.equal(alpha.frames.some((frame) => frame.text === "Echo: beta only"), false);
	assert.equal(beta.frames.some((frame) => frame.text === "Echo: alpha only"), false);
	assert.ok((await readLogs(root)).some((path) => path.includes("alpha")));
	assert.ok((await readLogs(root)).some((path) => path.includes("beta")));
});

async function readLogs(root: string): Promise<string[]> {
	const { readdir } = await import("node:fs/promises");
	const found: string[] = [];
	for (const account of await readdir(join(root, "accounts"))) {
		for (const channel of await readdir(join(root, "accounts", account, "channels"))) {
			found.push(join(root, "accounts", account, "channels", channel));
		}
	}
	return found;
}
