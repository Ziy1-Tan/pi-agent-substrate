import { createModels, createProvider } from "@earendil-works/pi-ai/models";
import { envApiKeyAuth } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";

/** The model the Harness calls. Built from environment in production (see main.ts). */
export interface ProviderConfig {
  /** Provider id; also the auth namespace for `apiKeyEnv`. */
  id: string;
  modelId: string;
  baseUrl: string;
  /** Name of the env var holding the key. The egress proxy replaces its value in production. */
  apiKeyEnv: string;
  contextWindow: number;
  maxTokens: number;
}

/** Pi's defaults, as documented in README.md. */
const DEFAULT_CONTEXT_WINDOW = 128_000;
const DEFAULT_MAX_TOKENS = 16_384;

/** Reads the provider from environment. The wire protocol is always `openai-completions`. */
export function providerFromEnv(env: NodeJS.ProcessEnv): ProviderConfig {
  return {
    id: requireEnv(env, "PI_PROVIDER"),
    modelId: requireEnv(env, "PI_MODEL"),
    baseUrl: requireEnv(env, "PI_PROVIDER_BASE_URL"),
    apiKeyEnv: env.PI_PROVIDER_API_KEY_ENV || "PI_PROVIDER_API_KEY",
    contextWindow: positiveInt(env, "PI_MODEL_CONTEXT_WINDOW", DEFAULT_CONTEXT_WINDOW),
    maxTokens: positiveInt(env, "PI_MODEL_MAX_TOKENS", DEFAULT_MAX_TOKENS),
  };
}

/**
 * Builds the pi-ai models registry with the single configured model. The key is
 * read from `env`, passed explicitly, so no code path depends on `process.env`.
 * File-based credentials are not used, so `fileExists` always reports false.
 */
export function modelsFor(config: ProviderConfig, env: NodeJS.ProcessEnv) {
  const models = createModels({
    authContext: {
      env: async (name) => env[name] || undefined,
      fileExists: async () => false,
    },
  });
  models.setProvider(
    createProvider({
      id: config.id,
      baseUrl: config.baseUrl,
      api: openAICompletionsApi(),
      auth: { apiKey: envApiKeyAuth(config.id, [config.apiKeyEnv]) },
      models: [
        {
          id: config.modelId,
          name: config.modelId,
          provider: config.id,
          api: "openai-completions",
          baseUrl: config.baseUrl,
          input: ["text"],
          reasoning: false,
          contextWindow: config.contextWindow,
          maxTokens: config.maxTokens,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        },
      ],
    }),
  );
  return models;
}

function requireEnv(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function positiveInt(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1)
    throw new Error(`${name} must be a positive integer, got ${raw}`);
  return value;
}
