import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import WebSocket from "ws";

import { startBridge, type Bridge } from "../../src/actor/bridge.js";
import { providerFromEnv } from "../../src/actor/provider.js";

/**
 * A minimal OpenAI-compatible chat server for the bridge tests. It streams a
 * fixed reply in small chunks and records what it was asked, so a test can
 * assert on the prompt Pi built without depending on a real provider.
 */
export async function startMockLlm(text: string): Promise<{
  url: string;
  requests: Array<Record<string, unknown>>;
  /** Makes every following completion request fail with this HTTP error. */
  failWith(status: number, message: string): void;
  close(): Promise<void>;
}> {
  const requests: Array<Record<string, unknown>> = [];
  let failure: { status: number; message: string } | undefined;
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      if (req.url?.endsWith("/models")) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ object: "list", data: [{ id: "mock-model", object: "model" }] }));
        return;
      }
      requests.push(JSON.parse(body) as Record<string, unknown>);
      if (failure) {
        res.writeHead(failure.status, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: failure.message, type: "server_error" } }));
        return;
      }
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      const chunks = text.match(/.{1,3}/gu) ?? [text];
      let index = 0;
      const timer = setInterval(() => {
        if (index >= chunks.length) {
          clearInterval(timer);
          res.write(
            `data: ${JSON.stringify({
              id: "mock-1",
              object: "chat.completion.chunk",
              created: 1,
              model: "mock-model",
              choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
            })}\n\n`,
          );
          res.end("data: [DONE]\n\n");
          return;
        }
        res.write(
          `data: ${JSON.stringify({
            id: "mock-1",
            object: "chat.completion.chunk",
            created: 1,
            model: "mock-model",
            choices: [{ index: 0, delta: { content: chunks[index++] }, finish_reason: null }],
          })}\n\n`,
        );
      }, 5);
    });
  });
  await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  const address = server.address();
  if (typeof address === "string" || address === null) throw new Error("mock LLM did not bind");
  return {
    url: `http://127.0.0.1:${address.port}/v1`,
    requests,
    failWith(status, message) {
      failure = { status, message };
    },
    async close() {
      await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
    },
  };
}

export interface BridgeHarness {
  bridge: Bridge;
  llm: Awaited<ReturnType<typeof startMockLlm>>;
  open(): Promise<BridgeClient>;
  close(): Promise<void>;
}

export async function createBridgeHarness(
  text = "Hello from pi rpc.",
  options: { log?: (message: string) => void; tools?: "none" | "bash" } = {},
): Promise<BridgeHarness> {
  const root = await mkdtemp(join(tmpdir(), "pi-bridge-"));
  const llm = await startMockLlm(text);
  const workspace = join(root, "workspace");
  await mkdir(workspace, { recursive: true });
  const env = mockProviderEnv(llm.url);
  const bridge = await startBridge({
    port: 0,
    log: options.log,
    storageDir: join(workspace, ".pi-durable"),
    workspace,
    provider: providerFromEnv(env),
    env,
    tools: options.tools,
  });
  return {
    bridge,
    llm,
    open: () => BridgeClient.connect(bridge.port),
    async close() {
      await bridge.close().catch(() => undefined);
      await llm.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

/** The env a production actor would receive, pointed at the mock LLM. */
export function mockProviderEnv(baseUrl: string): NodeJS.ProcessEnv {
  return {
    PI_PROVIDER: "mock",
    PI_MODEL: "mock-model",
    PI_PROVIDER_BASE_URL: baseUrl,
    PI_PROVIDER_API: "openai-completions",
    PI_PROVIDER_API_KEY_ENV: "MOCK_KEY",
    MOCK_KEY: "mock-key",
  };
}

export class BridgeClient {
  readonly events: Array<Record<string, unknown>> = [];
  private readonly socket: WebSocket;
  private waiters: Array<() => void> = [];

  private constructor(socket: WebSocket) {
    this.socket = socket;
  }

  static async connect(port: number): Promise<BridgeClient> {
    const socket = new WebSocket(`ws://127.0.0.1:${port}`);
    const client = new BridgeClient(socket);
    socket.on("message", (data: Buffer) => {
      client.events.push(JSON.parse(String(data)) as Record<string, unknown>);
      for (const wake of client.waiters.splice(0)) wake();
    });
    await new Promise<void>((resolveOpen, reject) => {
      socket.once("open", () => resolveOpen());
      socket.once("error", reject);
    });
    return client;
  }

  send(command: Record<string, unknown>): void {
    this.socket.send(JSON.stringify(command));
  }

  async waitFor(
    predicate: (event: Record<string, unknown>) => boolean,
    timeoutMs = 30_000,
  ): Promise<Record<string, unknown>> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const found = this.events.find(predicate);
      if (found) return found;
      if (Date.now() > deadline) {
        throw new Error(`timed out; last events: ${JSON.stringify(this.events.slice(-5))}`);
      }
      await new Promise<void>((resolveWait) => this.waiters.push(resolveWait));
    }
  }

  async request(
    command: Record<string, unknown>,
    timeoutMs = 30_000,
  ): Promise<Record<string, unknown>> {
    this.send(command);
    return this.waitFor((event) => event.type === "response" && event.id === command.id, timeoutMs);
  }

  async close(): Promise<void> {
    this.socket.close();
  }
}
