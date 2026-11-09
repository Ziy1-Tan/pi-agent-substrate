import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import { startBridge, type Bridge } from "../src/actor/bridge.js";
import { providerFromEnv } from "../src/actor/provider.js";
import { sendTurn } from "../src/gateway/turn.js";
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

test("an actor that is not listening fails the turn instead of hanging", async () => {
  await assert.rejects(sendTurn({ url: "ws://127.0.0.1:1", turnTimeoutMs: 5_000 }, actor, "hi"));
});
