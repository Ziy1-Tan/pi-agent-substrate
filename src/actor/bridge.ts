import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import {
  createRegistry,
  defineExtension,
  Harness,
  type SettledSubmissionRecord,
} from "@earendil-works/pi-durable";
import { createBashTool } from "@earendil-works/pi-durable/tools";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { openNodeJsonlStorage } from "@earendil-works/pi-durable/storage/jsonl/node";

import { modelsFor, type ProviderConfig } from "./provider.js";
import { outcomeOf, streamText, type TurnResult } from "./stream.js";
import { startTransport } from "./transport.js";

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
 * Serves the WebSocket contract the gateway relies on. Each turn runs in
 * pi-durable's Harness, in the actor process; there is no child process.
 *
 * Record contract the gateway depends on (see src/gateway/backend.ts):
 *   response         one per command, echoing `id`
 *   message_update   `assistantMessageEvent` text_delta records while streaming
 *   bridge_result    { requestId, text, error? } before agent_settled
 *   agent_settled    the turn is over
 *   bridge_exit      only when the engine stops
 */
export async function startBridge(options: BridgeOptions): Promise<Bridge> {
  const log = options.log ?? ((message: string) => console.error(`[durable-bridge] ${message}`));
  const port = options.port ?? Number(process.env.PI_BRIDGE_PORT ?? 8787);
  const tools = options.tools ?? "none";

  const registry = createRegistry();
  const shell = defineExtension({ name: "shell", tools: [createBashTool()] });
  // The shell extension is offered to the model only when enabled. An empty
  // registry gives the root no tools, so `none` needs no filter at all.
  if (tools === "bash") registry.install(shell);

  const storage = await openNodeJsonlStorage(options.storageDir, context);
  const harness = await Harness.open(
    storage,
    {
      models: modelsFor(options.provider, options.env),
      registry,
      env: ({ cwd }) => new NodeExecutionEnv({ cwd: cwd ?? options.workspace }),
      settings: {
        progress: { partialIntervalMs: 0, outputIntervalMs: 0, persistWithinMs: 0 },
        retry: { enabled: false },
      },
    },
    context,
  );
  const root = await harness.root(context, {
    agent: {
      model: { provider: options.provider.id, modelId: options.provider.modelId },
      extensions: tools === "bash" ? [shell] : [],
    },
  });

  const transport = await startTransport({
    port,
    log,
    onCommand: (command, reply) => {
      if (command.type === "prompt") {
        void runTurn(command).catch((error) => {
          log(`turn failed: ${error instanceof Error ? error.message : String(error)}`);
        });
        return;
      }
      if (command.type === "get_state") {
        reply({
          type: "response",
          command: "get_state",
          id: command.id,
          success: true,
          data: { sessionId: "durable-root" },
        });
        return;
      }
      reply({
        type: "response",
        command: String(command.type),
        id: command.id,
        success: false,
        error: `unsupported command: ${String(command.type)}`,
      });
    },
  });

  /**
   * Runs one prompt. Its watch lives for exactly this turn, so no shared map of
   * in-flight turns is needed.
   */
  async function runTurn(command: Record<string, unknown>): Promise<void> {
    const requestId =
      typeof command.requestId === "string" ? command.requestId : String(command.id ?? "");
    const message = typeof command.message === "string" ? command.message : "";
    transport.emit({ type: "response", command: "prompt", id: command.id, success: true });

    const stop = streamText(root, requestId, transport.emit, context);
    let settled: SettledSubmissionRecord;
    try {
      const submission = await root.submit({ type: "input", content: message, requestId }, context);
      settled = await submission.wait(context);
    } finally {
      stop();
    }
    const result: TurnResult = await outcomeOf(root, settled, requestId, context);
    transport.emit({ type: "bridge_result", ...result });
    transport.emit({ type: "agent_settled", aborted: false });
  }

  return {
    port: transport.port,
    async close() {
      transport.emit({ type: "bridge_exit", code: 0, signal: null });
      await transport.close();
      await harness.close(context);
    },
  };
}
