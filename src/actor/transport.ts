import { createServer, type IncomingMessage, type Server } from "node:http";

import { WebSocket, WebSocketServer } from "ws";

import { parseRecord } from "./lines.js";

/**
 * The WebSocket side of the actor. It frames nothing and knows no commands: each
 * client message goes to `onCommand` as an object, and the caller answers through
 * `emit`, which fans out to every connected client.
 */
export interface Transport {
  port: number;
  emit(record: Record<string, unknown>): void;
  close(): Promise<void>;
}

export interface TransportOptions {
  port: number;
  log: (message: string) => void;
  onCommand(
    command: Record<string, unknown>,
    reply: (record: Record<string, unknown>) => void,
  ): void;
}

export async function startTransport(options: TransportOptions): Promise<Transport> {
  const server: Server = createServer((request, response) => {
    if (request.url === "/healthz") {
      response.writeHead(200, { "content-type": "text/plain" });
      response.end("ok");
      return;
    }
    response.writeHead(404, { "content-type": "text/plain" });
    response.end("not found");
  });
  const wss = new WebSocketServer({ server });
  wss.on("connection", (socket: WebSocket, request: IncomingMessage) => {
    options.log(`client connected from ${request.socket.remoteAddress ?? "?"}`);
    socket.on("message", (data: Buffer) => dispatch(socket, data, options));
  });

  await new Promise<void>((resolve, reject) => {
    server.once("listening", () => resolve());
    server.once("error", reject);
    server.listen(options.port, "0.0.0.0");
  });
  const bound = server.address();
  const port = typeof bound === "object" && bound !== null ? bound.port : options.port;
  options.log(`durable bridge listening on :${port}`);

  return {
    port,
    emit(record) {
      const payload = JSON.stringify(record);
      for (const client of wss.clients) {
        if (client.readyState === WebSocket.OPEN) client.send(payload);
      }
    },
    async close() {
      for (const client of wss.clients) client.close();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

function dispatch(socket: WebSocket, data: Buffer, options: TransportOptions): void {
  const parsed = parseRecord(String(data).trim());
  if (typeof parsed !== "object" || parsed === null) {
    socket.send(
      JSON.stringify({
        type: "bridge_error",
        id: undefined,
        error: "command is not a JSON object",
      }),
    );
    return;
  }
  options.onCommand(parsed as Record<string, unknown>, (record) =>
    socket.send(JSON.stringify(record)),
  );
}
