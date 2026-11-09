import { randomUUID } from "node:crypto";
import type { IncomingMessage } from "node:http";

import WebSocket from "ws";

import type { ActorRef } from "./ateapi.js";
import { readIdentity, type IdentityPaths } from "./identity.js";

/** A turn's outcome. `error` is set when the turn failed, so it is never mistaken for silence. */
export interface Reply {
  text: string;
  error?: string;
}

export interface ActorEndpoint {
  /** The router, e.g. `wss://atenet-router.ate-system.svc:443`; a bridge's `ws://` in tests. */
  url: string;
  /** Required for `wss`: the router admits only listed pod identities. */
  identity?: IdentityPaths;
  turnTimeoutMs?: number;
}

/**
 * Where a turn was when it failed. In `connect` the prompt never left the
 * gateway, so the turn can be retried without running it twice; in `turn` the
 * actor may already be working on it.
 */
export type TurnPhase = "connect" | "turn";

/** A turn that failed before a reply, with the router's HTTP status when it refused the connection. */
export class TurnError extends Error {
  constructor(
    message: string,
    readonly phase: TurnPhase,
    readonly status?: number,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "TurnError";
  }
}

const CONNECT_TIMEOUT_MS = 10_000;
const MAX_REFUSAL_BYTES = 4096;

/**
 * Runs one turn: connects through the router, which resumes a suspended
 * actor, sends the prompt, and closes once the matching result arrives.
 *
 * The connection lives exactly as long as the turn. Connecting wakes the
 * actor, so nothing may reconnect outside a turn; with no connection to keep,
 * nothing can.
 */
export function sendTurn(endpoint: ActorEndpoint, actor: ActorRef, prompt: string): Promise<Reply> {
  const id = randomUUID();
  const timeoutMs = endpoint.turnTimeoutMs ?? 10 * 60_000;
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(endpoint.url, {
      headers: { "ate-target-actor": `${actor.atespace}/${actor.name}` },
      handshakeTimeout: CONNECT_TIMEOUT_MS,
      ...(endpoint.identity ? readIdentity(endpoint.identity) : {}),
    });
    let phase: TurnPhase | "settled" = "connect";
    // Once the router's refusal is being read, it owns the failure: a close or
    // error that follows must not replace the status with a generic message.
    let refusing = false;
    const finish = (outcome: Reply | Error) => {
      if (phase === "settled") return;
      phase = "settled";
      clearTimeout(timer);
      socket.terminate();
      if (outcome instanceof Error) reject(outcome);
      else resolve(outcome);
    };
    const fail = (message: string, status?: number, cause?: unknown) => {
      if (phase !== "settled")
        finish(new TurnError(message, phase, status, cause === undefined ? undefined : { cause }));
    };
    const timer = setTimeout(() => fail(`turn did not settle in ${timeoutMs}ms`), timeoutMs);

    // The router refuses with an HTTP status and a short reason, such as
    // `actor pi-agents/pi-x not found`; keep both instead of ws's bare
    // "Unexpected server response".
    socket.on("unexpected-response", (request, response: IncomingMessage) => {
      refusing = true;
      void readRefusal(response).then((body) => {
        request.destroy();
        fail(
          `router answered ${response.statusCode}${body ? `: ${body}` : ""}`,
          response.statusCode,
        );
      });
    });
    socket.on("open", () => {
      phase = "turn";
      socket.send(JSON.stringify({ id, prompt }));
    });
    socket.on("message", (data: Buffer) => {
      let record: { id?: unknown; text?: unknown; error?: unknown };
      try {
        record = JSON.parse(String(data)) as typeof record;
      } catch {
        return;
      }
      if (record.id !== id) return;
      finish(
        typeof record.error === "string"
          ? { text: "", error: record.error }
          : { text: typeof record.text === "string" ? record.text : "" },
      );
    });
    // The original error is kept as the cause: ws errors carry `code`, and a
    // TurnError built from the message alone would lose it.
    socket.on("error", (error: Error) => {
      if (!refusing) fail(error.message, undefined, error);
    });
    socket.on("close", () => {
      if (!refusing) fail("actor connection closed during the turn");
    });
  });
}

function readRefusal(response: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let body = "";
    // A refusal whose body never completes still carries its status, so resolve
    // on the close as well; the partial body is all the router sent.
    const done = () => resolve(body.trim().slice(0, MAX_REFUSAL_BYTES));
    response.setEncoding("utf8");
    response.on("data", (chunk: string) => {
      if (body.length < MAX_REFUSAL_BYTES) body += chunk;
    });
    response.on("end", done);
    response.on("close", done);
    response.on("error", done);
  });
}
