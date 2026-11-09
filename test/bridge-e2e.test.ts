import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import { PiBackend } from "../src/gateway/backend.js";
import { startBridge, type Bridge } from "../src/actor/bridge.js";
import { providerFromEnv } from "../src/actor/provider.js";
import { Conversation } from "../src/gateway/manager.js";
import { WebSocketTransport } from "../src/gateway/websocket.js";
import { mockProviderEnv, startMockLlm } from "./support/bridge-harness.js";

interface E2EHarness {
  gateway: Conversation;
  /** Stops the actor the way a suspend would, keeping its workspace. */
  suspend(): Promise<void>;
  /** Starts a fresh actor process over the same workspace. */
  resume(): Promise<void>;
  close(): Promise<void>;
}

async function createE2E(t: TestContext, text: string): Promise<E2EHarness> {
  const root = await mkdtemp(join(tmpdir(), "pi-e2e-"));
  const llm = await startMockLlm(text);
  const workspace = join(root, "workspace");
  // One port for the conversation: a resume puts a new process on it.
  const port = 18_700 + Math.floor(Math.random() * 200);

  let bridge: Bridge | undefined;
  const env = mockProviderEnv(llm.url);
  const startActor = async () => {
    bridge = await startBridge({
      port,
      storageDir: join(workspace, "durable"),
      workspace,
      provider: providerFromEnv(env),
      env,
      log: process.env.PI_E2E_LOG
        ? (message) => console.error(`[bridge] ${message}`)
        : () => undefined,
    });
  };
  await startActor();

  const transport = new WebSocketTransport({
    url: `ws://127.0.0.1:${port}`,
    log: process.env.PI_E2E_LOG
      ? (message) => console.error(`[transport] ${message}`)
      : () => undefined,
  });
  const backend = new PiBackend({ transport, turnTimeoutMs: 30_000 });
  const gateway = new Conversation({ actor: { atespace: "pi-agents", name: "pi-test" }, backend });

  const harness: E2EHarness = {
    gateway,
    async suspend() {
      await bridge?.close();
      bridge = undefined;
      // No lifecycle controller here: close the socket the way a
      // restart would, so the next message opens a fresh one.
      await transport.close();
    },
    async resume() {
      if (!bridge) await startActor();
    },
    async close() {
      await gateway.close().catch(() => undefined);
      await bridge?.close().catch(() => undefined);
      await llm.close();
      await rm(root, { recursive: true, force: true });
    },
  };
  t.after(() => harness.close());
  return harness;
}

test("a message reaches real pi and returns its reply", async (t) => {
  const harness = await createE2E(t, "Hello from pi rpc.");

  const reply = await harness.gateway.receive("hello pi");
  assert.equal(reply.text, "Hello from pi rpc.");
});

test("a suspended actor answers the next message after a fresh start", async (t) => {
  const harness = await createE2E(t, "still here");

  assert.equal((await harness.gateway.receive("remember: 41")).text, "still here");

  await harness.suspend();
  await harness.resume();

  assert.equal((await harness.gateway.receive("what did I say?")).text, "still here");
});
