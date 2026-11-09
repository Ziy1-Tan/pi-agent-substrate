/**
 * HTTP side of the gateway: one turn per request, plus metrics. It
 * deliberately knows nothing about actors or Pi; it turns a JSON body into a
 * manager call and the settled reply into JSON.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

import { GatewayManager } from "./manager.js";
import type { AgentResponse } from "./backend.js";

export interface HttpServerOptions {
  manager: GatewayManager;
  port?: number;
  /** Listen address; defaults to 0.0.0.0. */
  host?: string;
  log?: (message: string) => void;
}

export interface HttpServer {
  port: number;
  close(): Promise<void>;
}

const MAX_BODY_BYTES = 1024 * 1024;

export async function startHttpServer(options: HttpServerOptions): Promise<HttpServer> {
  const log = options.log ?? ((message: string) => console.error(`[http] ${message}`));
  const port = options.port ?? 8788;

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
    response.writeHead(404, { "content-type": "text/plain" });
    response.end("not found");
  }

  /** `POST /messages` -> one turn, with the settled reply in the response. */
  async function handleHttpMessage(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
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
    if (text.trim().length === 0) {
      respond(response, 400, { error: "text required" });
      return;
    }

    // The reply is this request's own turn result, so two callers on one
    // conversation each get their own answer rather than the last to settle.
    let reply: AgentResponse;
    try {
      reply = await options.manager.receive(conversationId, text);
    } catch (error) {
      respond(response, 502, { error: describe(error) });
      return;
    }
    if (reply.error !== undefined) {
      respond(response, 502, { error: reply.error });
      return;
    }
    respond(response, 200, { conversation: conversationId, text: reply.text });
  }

  server.listen(port, options.host ?? "0.0.0.0");
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
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

/** Reads a request body with a hard cap, so an oversized request cannot exhaust memory. */
function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error(`request body exceeds ${MAX_BODY_BYTES} bytes`));
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

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
