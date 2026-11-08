#!/usr/bin/env node
/**
 * Actor entry point. One process per sandbox:
 *
 *   node dist/src/actor/main.js
 *
 * Configuration is environment only, because an ActorTemplate carries literal
 * env values and the bridge must not depend on files outside `/workspace`.
 *
 *   PI_BRIDGE_PORT        WebSocket port inside the sandbox (default 8787)
 *   PI_BIN                Pi executable (default `pi` on PATH)
 *   PI_PROVIDER / PI_MODEL  Model selection passed to Pi
 *   PI_PROVIDER_BASE_URL  Provider endpoint for models.json
 *   PI_PROVIDER_API       Wire protocol, e.g. openai-completions
 *   PI_MODEL_CONTEXT_WINDOW / PI_MODEL_MAX_TOKENS  Optional model metadata
 */
import { mkdir, writeFile } from "node:fs/promises";

import { startBridge } from "./bridge.js";

const WORKSPACE = "/workspace";
const AGENT_DIR = `${WORKSPACE}/.pi`;
const SESSION_DIR = `${AGENT_DIR}/sessions`;

// An actor runs with an arbitrary initial cwd; Pi reads project-local context
// from the working directory, so pin it to the durable workspace.
process.chdir(WORKSPACE);
await mkdir(SESSION_DIR, { recursive: true });
await mkdir(AGENT_DIR, { recursive: true });

// An ActorTemplate carries literal env values only, and Pi reads its catalog
// from a file. Build the one provider the actor needs here. The key is a
// placeholder: the egress gateway replaces the Authorization header, so the
// real key never enters the sandbox.
const providerId = process.env.PI_PROVIDER;
const modelId = process.env.PI_MODEL;
const baseUrl = process.env.PI_PROVIDER_BASE_URL;
const api = process.env.PI_PROVIDER_API;
if (!providerId || !modelId || !baseUrl || !api) {
	throw new Error("PI_PROVIDER, PI_MODEL, PI_PROVIDER_BASE_URL and PI_PROVIDER_API are required");
}
const model: Record<string, unknown> = { id: modelId };
const contextWindow = positiveNumber(process.env.PI_MODEL_CONTEXT_WINDOW);
if (contextWindow) model.contextWindow = contextWindow;
const maxTokens = positiveNumber(process.env.PI_MODEL_MAX_TOKENS);
if (maxTokens) model.maxTokens = maxTokens;
await writeFile(
	`${AGENT_DIR}/models.json`,
	JSON.stringify({
		providers: {
			[providerId]: { baseUrl, api, apiKey: "egress-injected", models: [model] },
		},
	}),
);

function positiveNumber(value: string | undefined): number | undefined {
	if (!value) return undefined;
	const parsed = Number(value);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

const bridge = await startBridge({
	piArgs: ["--provider", providerId, "--model", modelId],
	sessionDir: SESSION_DIR,
	// One conversation per actor, so a restarted Pi child continues the same
	// session instead of starting a new one.
	sessionId: "pi",
	port: Number(process.env.PI_BRIDGE_PORT ?? 8787),
	log: (message) => console.error(`[bridge] ${message}`),
});

console.error(`[bridge] actor bridge ready on :${bridge.port}, sessions in ${SESSION_DIR}`);

for (const signal of ["SIGTERM", "SIGINT"] as const) {
	process.on(signal, () => {
		void bridge.close().finally(() => process.exit(0));
	});
}
