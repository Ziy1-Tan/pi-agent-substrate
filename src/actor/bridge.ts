import { createServer, type Server } from "node:http";

import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import {
  AssistantEntry,
  createRegistry,
  defineExtension,
  Harness,
  type Conversation,
  type EntryId,
  type SettledSubmissionRecord,
} from "@earendil-works/pi-durable";
import { createBashTool } from "@earendil-works/pi-durable/tools";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { openNodeJsonlStorage } from "@earendil-works/pi-durable/storage/jsonl/node";
import { WebSocket, WebSocketServer } from "ws";

import { modelsFor, type ProviderConfig } from "./provider.js";

/** The actor's configuration. Environment fills it in production (see main.ts). */
export interface BridgeOptions {
  /** Port the bridge listens on inside the sandbox. */
  port?: number;
  log?: (message: string) => void;
  /** Directory for the JSONL storage; one per conversation. */
  storageDir: string;
  /** Workspace the agent's shell runs in. */
  workspace: string;
  provider: ProviderConfig;
  /** Environment the provider key is read from; production passes `process.env`. */
  env: NodeJS.ProcessEnv;
  /** Tools to enable; the default is none. */
  tools?: "none" | "bash";
}

export interface Bridge {
  port: number;
  close(): Promise<void>;
}

/**
 * One turn on the wire. The gateway sends `{ id, prompt }` and the bridge
 * answers on the same socket with `{ id, text }`, or `{ id, text: "", error }`
 * when the model request failed.
 */
export interface TurnRequest {
  id: string;
  prompt: string;
}

export interface TurnResult {
  id: string;
  text: string;
  error?: string;
}

/**
 * Serves /healthz and the WebSocket the gateway sends turns over. Each turn
 * runs in pi-durable's Harness, in this process.
 */
export async function startBridge(options: BridgeOptions): Promise<Bridge> {
  const log = options.log ?? ((message: string) => console.error(`[bridge] ${message}`));
  const tools = options.tools ?? "none";

  const registry = createRegistry();
  const shell = defineExtension({ name: "shell", tools: [createBashTool()] });
  if (tools === "bash") registry.install(shell);

  const storage = await openNodeJsonlStorage(options.storageDir, context);
  const harness = await Harness.open(
    storage,
    {
      models: modelsFor(options.provider, options.env),
      registry,
      env: ({ cwd }) => new NodeExecutionEnv({ cwd: cwd ?? options.workspace }),
      settings: { retry: { enabled: false } },
    },
    context,
  );
  const root = await harness.root(context, {
    agent: {
      model: { provider: options.provider.id, modelId: options.provider.modelId },
      extensions: tools === "bash" ? [shell] : [],
    },
  });

  const server: Server = createServer((request, response) => {
    const ok = request.url === "/healthz";
    response.writeHead(ok ? 200 : 404, { "content-type": "text/plain" });
    response.end(ok ? "ok" : "not found");
  });
  const wss = new WebSocketServer({ server });
  wss.on("connection", (socket: WebSocket) => {
    socket.on("message", (data: Buffer) => {
      const request = parseTurn(String(data));
      if (!request) {
        socket.send(JSON.stringify({ id: "", text: "", error: "expected {id, prompt}" }));
        return;
      }
      void runTurn(root, request).then(
        (result) => socket.send(JSON.stringify(result)),
        (error: unknown) => {
          const message = error instanceof Error ? error.message : String(error);
          log(`turn ${request.id} failed: ${message}`);
          socket.send(JSON.stringify({ id: request.id, text: "", error: message }));
        },
      );
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
    server.listen(options.port ?? 8787, "0.0.0.0");
  });
  const bound = server.address();
  const port = typeof bound === "object" && bound !== null ? bound.port : (options.port ?? 8787);
  log(`listening on :${port}`);

  return {
    port,
    async close() {
      for (const client of wss.clients) client.close();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await harness.close(context);
    },
  };
}

function parseTurn(raw: string): TurnRequest | undefined {
  try {
    const value = JSON.parse(raw) as { id?: unknown; prompt?: unknown };
    if (typeof value.id === "string" && typeof value.prompt === "string")
      return { id: value.id, prompt: value.prompt };
  } catch {
    // fall through
  }
  return undefined;
}

async function runTurn(root: Conversation, request: TurnRequest): Promise<TurnResult> {
  const submission = await root.submit(
    { type: "input", content: request.prompt, requestId: request.id },
    context,
  );
  const settled = await submission.wait(context);
  if (settled.status === "unanswered") {
    return { id: request.id, text: "", error: failureText(settled) };
  }
  const answer = (settled as SettledSubmissionRecord & { answer?: EntryId }).answer;
  const text = answer === undefined ? "" : await assistantText(root, answer);
  return { id: request.id, text };
}

async function assistantText(conversation: Conversation, id: EntryId): Promise<string> {
  const page = await conversation.entries(
    { minEntryId: id, maxEntryId: id },
    1,
    undefined,
    context,
  );
  const record = page.items.find((item) => item.id === id);
  if (!record || record.kind !== AssistantEntry.kind) return "";
  const message = (record as { model?: Array<{ content?: unknown }> }).model?.[0];
  const content = Array.isArray(message?.content) ? message.content : [];
  return content
    .filter(
      (block): block is { type: "text"; text: string } =>
        typeof block === "object" &&
        block !== null &&
        (block as { type?: unknown }).type === "text" &&
        typeof (block as { text?: unknown }).text === "string",
    )
    .map((block) => block.text)
    .join("");
}

/** `detail` is JSON, so a non-string is serialized rather than dropped. */
function failureText(settled: { reason: string; detail?: unknown }): string {
  if (typeof settled.detail === "string" && settled.detail.length > 0) return settled.detail;
  if (settled.detail !== undefined) return JSON.stringify(settled.detail);
  return settled.reason || "the model request failed";
}
