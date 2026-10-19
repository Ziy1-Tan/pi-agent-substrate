/**
 * Browser-facing side of the gateway: a static page, one WebSocket per
 * conversation, and the metrics endpoint. It deliberately knows nothing about
 * actors or Pi; it translates browser commands into manager calls and manager
 * events into JSON frames.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { WebSocket, WebSocketServer } from "ws";

import type { Sequenced } from "./events.js";
import type { WebChannel, WebChannelEvent } from "./web.js";
import { MAX_UPLOAD_BYTES, saveUploads, type UploadInput } from "./uploads.js";
import { GatewayManager, type ConversationSpec } from "../gateway/manager.js";

export interface WebServerOptions {
	manager: GatewayManager;
	port?: number;
	/** Resolves a conversation id to its actor and lifecycle settings. */
	specFor: (conversationId: string) => ConversationSpec;
	/** Directory holding `ui.html`; defaults to the compiled module's folder. */
	uiDir?: string;
	log?: (message: string) => void;
}

export interface WebServer {
	port: number;
	close(): Promise<void>;
}

const MAX_FRAME_BYTES = 16 * 1024 * 1024;

export async function startWebServer(options: WebServerOptions): Promise<WebServer> {
	const log = options.log ?? ((message: string) => console.error(`[web] ${message}`));
	const port = options.port ?? Number(process.env.PI_WEB_PORT ?? 8788);
	const uiDir = options.uiDir ?? import.meta.dirname;
	const sockets = new Set<WebSocket>();

	const server: Server = createServer((request, response) => {
		void route(request, response);
	});

	async function route(request: IncomingMessage, response: ServerResponse): Promise<void> {
		const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
		if (url.pathname === "/messages") {
			if (request.method !== "POST") {
				response.writeHead(405, { "content-type": "application/json", allow: "POST" });
				response.end(JSON.stringify({ error: "use POST" }));
				return;
			}
			await handleHttpMessage(request, response);
			return;
		}
		if (url.pathname === "/metrics") {
			response.writeHead(200, { "content-type": "application/json" });
			response.end(JSON.stringify(options.manager.getMetrics().snapshot(), null, 2));
			return;
		}
		if (url.pathname === "/status") {
			const conversationId = url.searchParams.get("conversation") ?? "";
			const channel = options.manager.get(conversationId);
			response.writeHead(200, { "content-type": "application/json" });
			response.end(
				JSON.stringify({
					conversationId,
					open: channel !== undefined,
					lastSeq: channel?.lastSeq ?? 0,
				}),
			);
			return;
		}
		if (url.pathname === "/" || url.pathname === "/index.html") {
			try {
				const page = await readFile(join(uiDir, "ui.html"));
				response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
				response.end(page);
			} catch {
				response.writeHead(500, { "content-type": "text/plain" });
				response.end("ui.html is missing from the build");
			}
			return;
		}
		response.writeHead(404, { "content-type": "text/plain" });
		response.end("not found");
	}

	/** `POST /messages` -> one turn, with the settled reply in the response. */
	async function handleHttpMessage(request: IncomingMessage, response: ServerResponse): Promise<void> {
		let body: Record<string, unknown>;
		try {
			body = JSON.parse(await readBody(request)) as Record<string, unknown>;
		} catch (error) {
			respond(response, 400, { error: describe(error) });
			return;
		}
		const conversationId =
			typeof body.conversation === "string" && body.conversation ? body.conversation : "local/chat";
		const text = typeof body.text === "string" ? body.text : "";
		const messageId = typeof body.messageId === "string" ? body.messageId : randomUUID();
		const uploads = Array.isArray(body.attachments) ? (body.attachments as UploadInput[]) : undefined;
		if (text.trim().length === 0 && !uploads?.length) {
			respond(response, 400, { error: "text or attachments required" });
			return;
		}

		let entry: Awaited<ReturnType<GatewayManager["ensure"]>>;
		try {
			entry = await options.manager.ensure(options.specFor(conversationId));
		} catch (error) {
			respond(response, 502, { error: `cannot open ${conversationId}: ${describe(error)}` });
			return;
		}

		// The reply is settled before the call returns, so the caller reads it
		// as ordinary JSON. The conversation's own event log still has every
		// preview, for a browser attached at the same time.
		let reply: string | undefined;
		let failure: string | undefined;
		const listener = (event: Sequenced<WebChannelEvent>) => {
			if (event.value.type === "final") reply = event.value.text;
			if (event.value.type === "error") failure = event.value.text;
		};
		entry.channel.onEvent(listener);
		try {
			const attachments = await saveUploads(entry.conversation.filesDir, messageId, uploads);
			await options.manager.receive(conversationId, {
				userId: typeof body.userId === "string" ? body.userId : "curl",
				userName: typeof body.userName === "string" ? body.userName : "curl",
				text,
				messageId,
				attachments,
			});
		} catch (error) {
			respond(response, 502, { error: describe(error), messageId });
			return;
		} finally {
			entry.channel.offEvent(listener);
		}
		if (failure) {
			respond(response, 502, { error: failure, messageId });
			return;
		}
		// A conversation can deliver through Telegram while a browser watches
		// the same log; the frame is what keeps the two views in step.
		if (entry.outbound !== entry.channel && reply !== undefined) {
			entry.channel.recordHistory([{ type: "outbound", text: reply, messageId }]);
		}
		respond(response, 200, { conversation: conversationId, messageId, text: reply ?? "" });
	}

	const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME_BYTES });
	server.on("upgrade", (request, socket, head) => {
		const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
		if (url.pathname !== "/events") {
			socket.destroy();
			return;
		}
		wss.handleUpgrade(request, socket, head, (client) => {
			wss.emit("connection", client, request);
		});
	});

	wss.on("connection", (client: WebSocket, request: IncomingMessage) => {
		sockets.add(client);
		client.on("close", () => sockets.delete(client));
		const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
		const requested = url.searchParams.get("conversation") ?? "local/chat";
		const since = Number(url.searchParams.get("since") ?? 0);
		void attach(client, requested, Number.isFinite(since) ? since : 0);
	});

	async function attach(client: WebSocket, conversationId: string, since: number): Promise<void> {
		let entry: Awaited<ReturnType<GatewayManager["ensure"]>>;
		try {
			entry = await options.manager.ensure(options.specFor(conversationId));
		} catch (error) {
			send(client, { type: "error", text: `cannot open ${conversationId}: ${describe(error)}` });
			return;
		}
		const channel = entry.channel;
		// Flattened on the wire: the client reads `type` at the top level and
		// uses `seq` only to drop frames it has already seen.
		const listener = (event: Sequenced<WebChannelEvent>) => send(client, { seq: event.seq, ...event.value });
		channel.onEvent(listener);
		client.on("close", () => channel.offEvent(listener));

		// Replay only the window the client missed. A gap older than the ring
		// means the client cannot reconstruct the stream from previews alone, so
		// it gets the recorded history instead and restarts from the tail.
		if (channel.hasGap(since)) {
			send(client, {
				type: "error",
				text: "replay window expired; reloading history",
			});
			channel.recordHistory(entry.gateway.history(50));
		} else if (since > 0) {
			for (const event of channel.replay(since)) send(client, { seq: event.seq, ...event.value });
		}
		send(client, { type: "hello", conversation: conversationId, lastSeq: channel.lastSeq });
		send(client, { type: "status", ...(entry.gateway.status() ?? {}) });

		client.on("message", (data: Buffer) => {
			void handleCommand(entry, conversationId, client, String(data));
		});
	}

	async function handleCommand(
		entry: Awaited<ReturnType<GatewayManager["ensure"]>>,
		conversationId: string,
		client: WebSocket,
		raw: string,
	): Promise<void> {
		let command: Record<string, unknown>;
		try {
			command = JSON.parse(raw) as Record<string, unknown>;
		} catch {
			send(client, { type: "error", text: "command is not JSON" });
			return;
		}
		const type = typeof command.type === "string" ? command.type : "";
		try {
			if (type === "message") {
				const text = typeof command.text === "string" ? command.text : "";
				const messageId = typeof command.messageId === "string" ? command.messageId : randomUUID();
				const uploads = Array.isArray(command.attachments)
					? (command.attachments as UploadInput[])
					: undefined;
				const attachments = await entry.channel.saveUploads(messageId, uploads);
				await options.manager.receive(conversationId, {
					userId: typeof command.userId === "string" ? command.userId : "browser",
					userName: typeof command.userName === "string" ? command.userName : "you",
					text,
					messageId,
					attachments,
				});
				return;
			}
			if (type === "stop") {
				await options.manager.stop(conversationId);
				return;
			}
			if (type === "new") {
				await options.manager.reset(conversationId);
				return;
			}
			if (type === "status") {
				send(client, { type: "status", ...(entry.gateway.status() ?? {}) });
			} else if (type === "history") {
				entry.channel.recordHistory(entry.gateway.history(Number(command.limit) || 50));
			} else {
				send(client, { type: "error", text: `unknown command: ${type}` });
			}
		} catch (error) {
			const message = describe(error);
			entry.channel.recordError(message, typeof command.messageId === "string" ? command.messageId : undefined);
			log(`${conversationId}: ${message}`);
		}
	}

	server.listen(port, "0.0.0.0");
	await new Promise<void>((resolve, reject) => {
		server.once("listening", () => resolve());
		server.once("error", reject);
	});
	const bound = server.address();
	const actualPort = typeof bound === "object" && bound !== null ? bound.port : port;
	log(`listening on :${actualPort}`);

	return {
		port: actualPort,
		async close() {
			for (const client of sockets) client.close();
			await new Promise<void>((resolve) => wss.close(() => resolve()));
			await new Promise<void>((resolve) => server.close(() => resolve()));
		},
	};
}

/** Reads a request body with a hard cap, so a stray upload cannot exhaust memory. */
function readBody(request: IncomingMessage): Promise<string> {
	return new Promise((resolve, reject) => {
		let size = 0;
		const chunks: Buffer[] = [];
		request.on("data", (chunk: Buffer) => {
			size += chunk.length;
			if (size > MAX_FRAME_BYTES) {
				reject(new Error(`request body exceeds ${MAX_FRAME_BYTES} bytes`));
				request.destroy();
				return;
			}
			chunks.push(chunk);
		});
		request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
		request.on("error", reject);
	});
}

function respond(response: ServerResponse, status: number, body: unknown): void {
	response.writeHead(status, { "content-type": "application/json" });
	response.end(JSON.stringify(body));
}

function send(client: WebSocket, payload: unknown): void {
	if (client.readyState === WebSocket.OPEN) client.send(JSON.stringify(payload));
}

function describe(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
