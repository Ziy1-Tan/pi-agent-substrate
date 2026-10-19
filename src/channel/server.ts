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

import type { Sequenced } from "../channel/events.js";
import type { UploadInput, WebChannel, WebChannelEvent } from "../channel/web.js";
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
		// means the client cannot reconstruct the stream from deltas alone, so
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
				return;
			}
			if (type === "history") {
				entry.channel.recordHistory(entry.gateway.history(Number(command.limit) || 50));
				return;
			}
			send(client, { type: "error", text: `unknown command: ${type}` });
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

function send(client: WebSocket, payload: unknown): void {
	if (client.readyState === WebSocket.OPEN) client.send(JSON.stringify(payload));
}

function describe(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
