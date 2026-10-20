#!/usr/bin/env node
/**
 * Actor entry point. One process per sandbox:
 *
 *   node dist/src/bridge/main.js
 *
 * Configuration is environment only, because an ActorTemplate carries literal
 * env values and the bridge must not depend on files outside `/workspace`.
 *
 *   PI_BRIDGE_PORT        WebSocket port inside the sandbox (default 8787)
 *   PI_BIN                Pi executable (default `pi` on PATH)
 *   PI_BRIDGE_ARGS        Extra Pi args, shell-style, appended after `--mode rpc`
 *   PI_CODING_AGENT_DIR   Pi config directory (default `/workspace/.pi`)
 *   PI_SESSION_DIR        Pi session directory (default `/workspace/.pi/sessions`)
 *   PI_BRIDGE_CWD         Working directory for Pi (default /workspace)
 *   PI_PROVIDER / PI_MODEL  Model selection passed to Pi
 *   PI_PROVIDER_BASE_URL  Provider endpoint for models.json
 *   PI_PROVIDER_API       Wire protocol, e.g. openai-completions
 *   PI_MODEL_CONTEXT_WINDOW / PI_MODEL_MAX_TOKENS  Optional model metadata
 */
import { mkdir, writeFile } from "node:fs/promises";

import { startBridge } from "../bridge/bridge.js";

// An actor runs with an arbitrary initial cwd; Pi reads project-local context
// from the working directory, so pin it to the durable workspace.
const workspace = process.env.PI_BRIDGE_CWD ?? "/workspace";
try {
	process.chdir(workspace);
} catch {
	// The directory may be absent outside an actor; the bridge still serves.
}

const sessionDir = process.env.PI_SESSION_DIR ?? "/workspace/.pi/sessions";
const agentDir = process.env.PI_CODING_AGENT_DIR ?? "/workspace/.pi";
await mkdir(sessionDir, { recursive: true });
await mkdir(agentDir, { recursive: true });

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
	`${agentDir}/models.json`,
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

const extraArgs = (process.env.PI_BRIDGE_ARGS ?? "")
	.split(/\s+/)
	.map((part) => part.trim())
	.filter((part) => part.length > 0);

const modelArgs: string[] = [];
if (process.env.PI_PROVIDER) modelArgs.push("--provider", process.env.PI_PROVIDER);
if (process.env.PI_MODEL) modelArgs.push("--model", process.env.PI_MODEL);

const bridge = await startBridge({
	piArgs: [...extraArgs, ...modelArgs],
	sessionDir,
	// One conversation per actor, so the id can be stable across restarts.
	sessionId: process.env.PI_SESSION_ID,
	port: Number(process.env.PI_BRIDGE_PORT ?? 8787),
	log: (message) => console.error(`[bridge] ${message}`),
});

console.error(`[bridge] actor bridge ready on :${bridge.port}, sessions in ${sessionDir}`);

for (const signal of ["SIGTERM", "SIGINT"] as const) {
	process.on(signal, () => {
		void bridge.close().finally(() => process.exit(0));
	});
}
