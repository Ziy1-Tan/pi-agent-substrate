import { createServer, type IncomingMessage, type Server } from "node:http";

import { WebSocket, WebSocketServer } from "ws";

import { parseRecord } from "./lines.js";
import type { RpcCommand } from "./rpc.js";
import { PiActivity, PiProcess } from "./pi-process.js";

export interface BridgeOptions {
  /** Command that starts Pi. Defaults to `PI_BIN` or `pi` on PATH. */
  piCommand?: string;
  /** Arguments after `--mode rpc`; the bridge appends `--session-dir`. */
  piArgs?: string[];
  /** Session directory under the durable volume. */
  sessionDir?: string;
  /**
   * Session id Pi is told to use. A restored snapshot may bring back a bridge
   * whose `pi` child did not survive (gVisor does not restore every syscall
   * path), so the bridge starts Pi lazily and restarts it on this same id;
   * Pi then continues the session file instead of starting a new one.
   */
  sessionId?: string;
  /** Extra environment for the Pi child. */
  piEnv?: NodeJS.ProcessEnv;
  /** Port the bridge listens on inside the sandbox. */
  port?: number;
  log?: (message: string) => void;
}

export interface Bridge {
  port: number;
  close(): Promise<void>;
}

export interface TurnResult {
  requestId: string;
  text: string;
  /** Set when the turn ended in a provider error; `text` is then empty. */
  error?: string;
}

/**
 * Runtime-agnostic bridge: it exposes Pi's stdio RPC as a WebSocket inside the
 * actor. atenet-router resolves the actor before a record reaches this port,
 * so the bridge carries no per-client identity and takes no lifecycle
 * decisions.
 *
 * When a turn settles the bridge emits `bridge_result` alongside Pi's own
 * `agent_settled`, because Pi's event does not carry the request id.
 */
export async function startBridge(options: BridgeOptions = {}): Promise<Bridge> {
  const log = options.log ?? ((message: string) => console.error(`[bridge] ${message}`));
  const port = options.port ?? Number(process.env.PI_BRIDGE_PORT ?? 8787);
  const activity = new PiActivity();
  let currentRequestId: string | undefined;

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
  server.listen(port, "0.0.0.0");
  await new Promise<void>((resolve, reject) => {
    server.once("listening", () => resolve());
    server.once("error", reject);
  });
  // Port 0 asks the OS for one; the resolved address is what callers use.
  const bound = server.address();
  const actualPort = typeof bound === "object" && bound !== null ? bound.port : port;

  const broadcast = (record: unknown) => {
    const payload = JSON.stringify(record);
    for (const client of wss.clients) {
      if (client.readyState === WebSocket.OPEN) client.send(payload);
    }
  };

  let closing = false;
  const piArgs = [
    "--mode",
    "rpc",
    ...(options.piArgs ?? []),
    ...(options.sessionDir ? ["--session-dir", options.sessionDir] : []),
  ];
  if (options.sessionId) piArgs.push("--session-id", options.sessionId);
  const pi = new PiProcess({
    command: options.piCommand ?? process.env.PI_BIN ?? "pi",
    args: piArgs,
    cwd: process.cwd(),
    env: { ...process.env, ...options.piEnv },
    onStderr: (line) => log(`pi stderr: ${line}`),
    // A new child has no in-memory stream state.
    onStart: () => activity.beginTurn(),
    onEvent: (event) => {
      activity.observe(event);
      // The authoritative result goes out before Pi's own event: the
      // gateway settles on the first record it sees, and a bare
      // `agent_settled` would turn a provider failure into an empty reply.
      const settled = activity.settled(event);
      if (settled && currentRequestId !== undefined) {
        const result: TurnResult = { requestId: currentRequestId, ...settled };
        broadcast({ type: "bridge_result", ...result });
        currentRequestId = undefined;
      }
      broadcast(event);
    },
    onExit: (code, signal) => {
      log(`pi exited code=${code} signal=${signal}`);
      broadcast({ type: "bridge_exit", code, signal });
      // A snapshot restore can leave a dead child behind; bring it back on the
      // same session id so the conversation continues in place. Waiting for a
      // client avoids burning a restart on an actor nobody is talking to.
      if (!closing) {
        setTimeout(() => {
          if (!closing && wss.clients.size > 0) startPi();
        }, 250).unref?.();
      }
    },
  });
  const startPi = () => {
    if (pi.ready) return;
    try {
      pi.start();
      log(`pi started pid=${pi.pid ?? "?"}`);
    } catch (error) {
      log(`pi failed to start: ${error instanceof Error ? error.message : String(error)}`);
    }
  };
  // Pi spends a cold start loading extensions and skills; defer it until a
  // client connects so the golden snapshot captures an idle bridge rather
  // than a half-started child.
  log(`bridge listening on :${actualPort}`);

  wss.on("connection", (socket: WebSocket, request: IncomingMessage) => {
    log(`client connected from ${request.socket.remoteAddress ?? "?"}`);
    if (!pi.ready) startPi();
    socket.on("message", (data: Buffer) => {
      const parsed = parseRecord(String(data).trim());
      if (parsed === undefined || typeof parsed !== "object") {
        sendError(socket, undefined, "command is not a JSON object");
        return;
      }
      const command = parsed as RpcCommand;
      if (command.type === "prompt") {
        // Pi's own id field is optional; the gateway's requestId is what
        // the settled result is keyed by, so accept either.
        const requestId = stringField(command.requestId) ?? stringField(command.id);
        if (requestId !== undefined) {
          activity.beginTurn();
          currentRequestId = requestId;
        }
      }
      try {
        pi.send(command as unknown as Record<string, unknown>);
      } catch (error) {
        sendError(socket, command.id, error);
      }
    });
  });

  return {
    port: actualPort,
    async close() {
      closing = true;
      for (const client of wss.clients) client.close();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await pi.stop();
    },
  };
}

function stringField(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function sendError(socket: WebSocket, id: unknown, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  socket.send(JSON.stringify({ type: "bridge_error", id, error: message }));
}
