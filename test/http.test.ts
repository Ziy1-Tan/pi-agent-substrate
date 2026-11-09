import assert from "node:assert/strict";
import test from "node:test";

import { Gateway } from "../src/gateway/gateway.js";
import { startHttpServer } from "../src/gateway/http.js";
import { echoTurn, FakeControl } from "./support/fakes.js";

async function setup(t: test.TestContext) {
  const gateway = new Gateway({
    control: new FakeControl(),
    atespace: "pi-agents",
    idleMs: 60_000,
    runTurn: async (actor, prompt) =>
      prompt === "fail" ? { text: "", error: "upstream is down" } : echoTurn()(actor, prompt),
  });
  const server = await startHttpServer({ gateway, port: 0, log: () => undefined });
  t.after(async () => {
    await server.close();
    await gateway.close();
  });
  return { server };
}

test("curl posts a message and reads the settled reply in the response", async (t) => {
  const { server } = await setup(t);
  const response = await fetch(`http://127.0.0.1:${server.port}/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ conversation: "cli/one", text: "hello from curl" }),
  });
  assert.equal(response.status, 200);
  const body = (await response.json()) as { conversation: string; text: string };
  assert.equal(body.conversation, "cli/one");
  assert.equal(body.text, "Reply: hello from curl");
});

test("each turn in a conversation gets its own reply", async (t) => {
  const { server } = await setup(t);
  const post = async (text: string) =>
    (await (
      await fetch(`http://127.0.0.1:${server.port}/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ conversation: "cli/one", text }),
      })
    ).json()) as { text: string };

  assert.equal((await post("first")).text, "Reply: first");
  assert.equal((await post("second")).text, "Reply: second");
});

test("a bad request is answered with a status, not a hang", async (t) => {
  const { server } = await setup(t);
  const empty = await fetch(`http://127.0.0.1:${server.port}/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ conversation: "cli/one", text: "  " }),
  });
  assert.equal(empty.status, 400);

  const wrongMethod = await fetch(`http://127.0.0.1:${server.port}/messages`);
  assert.equal(wrongMethod.status, 405);

  const notJson = await fetch(`http://127.0.0.1:${server.port}/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{",
  });
  assert.equal(notJson.status, 400);
});

test("a failed turn is answered with 502 and its reason", async (t) => {
  const { server } = await setup(t);
  const response = await fetch(`http://127.0.0.1:${server.port}/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ conversation: "cli/one", text: "fail" }),
  });
  assert.equal(response.status, 502);
  assert.deepEqual(await response.json(), { error: "upstream is down" });
});

test("metrics are served and unknown paths are not", async (t) => {
  const { server } = await setup(t);
  const metrics = await fetch(`http://127.0.0.1:${server.port}/metrics`);
  assert.equal(metrics.status, 200);
  const body = (await metrics.json()) as { counters: Record<string, number> };
  assert.deepEqual(body.counters, {});

  const missing = await fetch(`http://127.0.0.1:${server.port}/`);
  assert.equal(missing.status, 404);
});
