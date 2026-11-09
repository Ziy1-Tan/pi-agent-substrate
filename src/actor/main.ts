#!/usr/bin/env node
/**
 * Actor entry point. One process per sandbox:
 *
 *   node dist/src/actor/main.js
 *
 * Configuration is environment only, because an ActorTemplate carries literal
 * env values and the bridge must not depend on files outside `/workspace`.
 *
 *   PI_BRIDGE_PORT                 WebSocket port inside the sandbox (default 8787)
 *   PI_PROVIDER / PI_MODEL         Provider id and model id the Harness calls
 *   PI_PROVIDER_BASE_URL           Provider endpoint
 *   PI_PROVIDER_API                Wire protocol; only openai-completions is supported
 *   PI_PROVIDER_API_KEY_ENV        Name of the env var holding the key (egress-injected)
 *   PI_MODEL_CONTEXT_WINDOW        Optional, default 128000
 *   PI_MODEL_MAX_TOKENS            Optional, default 16384
 *   PI_TOOLS                       none (default) or bash
 */
import { mkdir } from "node:fs/promises";

import { startBridge } from "./bridge.js";
import { providerFromEnv } from "./provider.js";

const WORKSPACE = "/workspace";
const STORAGE_DIR = `${WORKSPACE}/.pi-durable`;

process.chdir(WORKSPACE);
await mkdir(STORAGE_DIR, { recursive: true });

const provider = providerFromEnv(process.env);
// The key is replaced on egress in production; the placeholder only has to exist.
if (process.env[provider.apiKeyEnv] === undefined)
  process.env[provider.apiKeyEnv] = "egress-injected";

const bridge = await startBridge({
  storageDir: STORAGE_DIR,
  workspace: WORKSPACE,
  provider,
  env: process.env,
  tools: process.env.PI_TOOLS === "bash" ? "bash" : "none",
  log: (message) => console.error(`[bridge] ${message}`),
});

console.error(`[bridge] actor bridge ready on :${bridge.port}, storage in ${STORAGE_DIR}`);

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => {
    void bridge.close().finally(() => process.exit(0));
  });
}
