import { randomUUID } from "node:crypto";

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

const CONNECT_TIMEOUT_MS = 10_000;

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
    let settled = false;
    const finish = (outcome: Reply | Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.terminate();
      if (outcome instanceof Error) reject(outcome);
      else resolve(outcome);
    };
    const timer = setTimeout(
      () => finish(new Error(`turn did not settle in ${timeoutMs}ms`)),
      timeoutMs,
    );

    socket.on("open", () => socket.send(JSON.stringify({ id, prompt })));
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
    socket.on("error", (error: Error) => finish(error));
    socket.on("close", () => finish(new Error("actor connection closed during the turn")));
  });
}
