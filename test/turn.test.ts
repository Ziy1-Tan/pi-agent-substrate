import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import test, { type TestContext } from "node:test";

import { startBridge, type Bridge } from "../src/actor/bridge.js";
import { providerFromEnv } from "../src/actor/provider.js";
import { sendTurn, TurnError } from "../src/gateway/turn.js";
import type { ActorRef } from "../src/gateway/ateapi.js";
import { mockProviderEnv, startMockLlm } from "./support/bridge.js";

const actor: ActorRef = { atespace: "pi-agents", name: "pi-test" };

/** A gateway-side client against a real bridge; `restart` stands in for a suspend and resume. */
async function createE2E(t: TestContext, text: string) {
  const root = await mkdtemp(join(tmpdir(), "pi-e2e-"));
  const llm = await startMockLlm(text);
  const workspace = join(root, "workspace");
  const env = mockProviderEnv(llm.url);
  let bridge: Bridge | undefined;
  let port = 0;
  const start = async () => {
    // A resume puts the new process on the same port.
    bridge = await startBridge({
      port,
      storageDir: join(workspace, "durable"),
      workspace,
      provider: providerFromEnv(env),
      env,
      log: () => undefined,
    });
    port = bridge.port;
  };
  await start();
  t.after(async () => {
    await bridge?.close().catch(() => undefined);
    await llm.close();
    await rm(root, { recursive: true, force: true });
  });
  return {
    send: (prompt: string) => sendTurn({ url: `ws://127.0.0.1:${port}` }, actor, prompt),
    async restart() {
      await bridge?.close();
      await start();
    },
  };
}

test("a turn reaches the Harness and returns its reply", async (t) => {
  const e2e = await createE2E(t, "Hello from the bridge.");
  assert.deepEqual(await e2e.send("hello"), { text: "Hello from the bridge." });
});

test("a restarted actor answers the next turn over the same storage", async (t) => {
  const e2e = await createE2E(t, "still here");
  assert.equal((await e2e.send("remember: 41")).text, "still here");
  await e2e.restart();
  assert.equal((await e2e.send("what did I say?")).text, "still here");
});

test("an actor that is not listening fails the turn before sending it", async () => {
  await assert.rejects(
    sendTurn({ url: "ws://127.0.0.1:1", turnTimeoutMs: 5_000 }, actor, "hi"),
    (error: unknown) => error instanceof TurnError && error.phase === "connect",
  );
});

test("a connection failure keeps the original error as its cause", async () => {
  await assert.rejects(
    sendTurn({ url: "ws://127.0.0.1:1", turnTimeoutMs: 5_000 }, actor, "hi"),
    (error: unknown) =>
      error instanceof TurnError &&
      error.cause instanceof Error &&
      /ECONNREFUSED/.test(error.cause.message),
  );
});

test("a refusal whose body never ends still reports its status", async (t) => {
  const router = createServer((_request, response) => {
    response.writeHead(404, { "content-type": "text/plain" });
    response.write("actor pi-agents/pi-test not found");
    // Kill the connection before the body completes, so the client sees a
    // close rather than an end.
    setTimeout(() => response.socket?.destroy(), 25);
  });
  await new Promise<void>((resolve) => router.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve) => router.close(() => resolve())));
  const address = router.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;

  await assert.rejects(
    sendTurn({ url: `ws://127.0.0.1:${port}` }, actor, "hi"),
    (error: unknown) =>
      error instanceof TurnError &&
      error.phase === "connect" &&
      error.status === 404 &&
      error.message.startsWith("router answered 404"),
  );
});

test("a router refusal keeps its status and reason", async (t) => {
  const router = createServer((_request, response) => {
    response.writeHead(404, { "content-type": "text/plain" });
    response.end("actor pi-agents/pi-test not found");
  });
  await new Promise<void>((resolve) => router.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve) => router.close(() => resolve())));
  const address = router.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;

  await assert.rejects(
    sendTurn({ url: `ws://127.0.0.1:${port}` }, actor, "hi"),
    (error: unknown) =>
      error instanceof TurnError &&
      error.phase === "connect" &&
      error.status === 404 &&
      error.message === "router answered 404: actor pi-agents/pi-test not found",
  );
});
