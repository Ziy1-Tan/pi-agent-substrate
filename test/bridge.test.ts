import assert from "node:assert/strict";
import test from "node:test";

import { startTestBridge } from "./support/bridge.js";

/** Pi sends content as blocks; the mock provider sees them as chat messages. */
function promptText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter(
      (block): block is { type: string; text?: string } =>
        typeof block === "object" && block !== null,
    )
    .map((block) => (block.type === "text" ? (block.text ?? "") : ""))
    .join("");
}

test("a turn reaches the Harness and its reply comes back with the turn id", async (t) => {
  const harness = await startTestBridge("Hello from the bridge.");
  t.after(() => harness.close());
  const client = await harness.open();
  t.after(() => client.close());

  const result = await client.turn("req-1", "say hi");
  assert.deepEqual(result, { id: "req-1", text: "Hello from the bridge." });

  const prompt = harness.llm.requests.at(-1);
  assert.ok(prompt, "the mock provider received the turn");
  const messages = prompt.messages as Array<{ role: string; content: unknown }>;
  assert.ok(
    messages.some(
      (message) => message.role === "user" && promptText(message.content).includes("say hi"),
    ),
  );
});

test("a malformed request is answered with an error", async (t) => {
  const harness = await startTestBridge("unused");
  t.after(() => harness.close());
  const client = await harness.open();
  t.after(() => client.close());

  client.sendRaw(JSON.stringify({ type: "get_state" }));
  const result = await client.waitFor((entry) => typeof entry.error === "string");
  assert.match(String(result.error), /expected \{id, prompt\}/);
});

test("a second turn continues the same session", async (t) => {
  const harness = await startTestBridge("second reply");
  t.after(() => harness.close());
  const client = await harness.open();
  t.after(() => client.close());

  await client.turn("req-1", "first");
  await client.turn("req-2", "second");

  const second = harness.llm.requests.at(-1);
  const messages = second?.messages as Array<{ role: string; content: unknown }>;
  const users = messages
    .filter((message) => message.role === "user")
    .map((message) => promptText(message.content));
  assert.equal(users.length, 2, "the second request carries the first turn's history");
  assert.ok(users[0]?.includes("first"));
  assert.ok(users[1]?.includes("second"));
});

test("a provider failure is reported as an error, not an empty reply", async (t) => {
  const harness = await startTestBridge("unused");
  t.after(() => harness.close());
  const client = await harness.open();
  t.after(() => client.close());
  harness.llm.failWith(503, "upstream is down");

  const result = await client.turn("req-fail", "say hi");
  assert.equal(result.text, "");
  assert.match(String(result.error), /upstream is down/);
});

test("the shell tool is offered to the model only when enabled", async (t) => {
  const off = await startTestBridge("ok");
  t.after(() => off.close());
  const offClient = await off.open();
  t.after(() => offClient.close());
  await offClient.turn("off-1", "hi");
  assert.equal(off.llm.requests.at(-1)?.tools, undefined, "no tools are offered by default");

  const on = await startTestBridge("ok", { tools: "bash" });
  t.after(() => on.close());
  const onClient = await on.open();
  t.after(() => onClient.close());
  await onClient.turn("on-1", "hi");
  const tools = (on.llm.requests.at(-1)?.tools ?? []) as Array<{ function?: { name?: string } }>;
  assert.deepEqual(
    tools.map((tool) => tool.function?.name),
    ["bash"],
    "the bash tool is the only tool offered",
  );
});
