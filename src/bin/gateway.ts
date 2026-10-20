#!/usr/bin/env node
/**
 * Gateway entry point. Two ways in, one gateway behind them:
 *
 *   curl   POST /messages with {conversation, text} and read the reply in the
 *          response.
 *   chat   when PI_TELEGRAM_TOKEN is set, every Telegram chat becomes a
 *          conversation and the bot replies in that chat.
 *
 * An incoming message is the only thing that wakes an actor: the gateway
 * creates it on first use, the router resumes a suspended one, and the idle
 * lifecycle suspends it again once the turn is fully recorded.
 *
 * Configuration is environment only:
 *
 *   PI_HTTP_PORT           HTTP port (default 8788)
 *   PI_HTTP_HOST           listen address (default 127.0.0.1)
 *   PI_GATEWAY_DATA_DIR    conversation storage root (default `/tmp/pi-gateway`)
 *   PI_ACTOR_URL           bridge WebSocket, usually the router's port-forward
 *   PI_ACTOR_TEMPLATE      template used to create a missing actor
 *   PI_EGRESS_POLICY       manifest applied to each new actor (default
 *                          `deploy/test/egress-policy.yaml`; empty disables it)
 *   PI_IDLE_SECONDS        idle window before suspend (0 disables, default 60)
 *   PI_TELEGRAM_TOKEN      bot token; enables the Telegram entry point
 *   PI_TELEGRAM_CHATS      comma-separated chat ids to answer (default: any)
 *   PI_TELEGRAM_API        Bot API base (default https://api.telegram.org)
 *   KUBECTL_ATE            kubectl-ate binary (default on PATH)
 *   KUBE_CONTEXT           kubectl context
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { GatewayManager, type ConversationSpec } from "../gateway/manager.js";
import { startHttpServer } from "../channel/server.js";
import { TelegramChannel } from "../channel/telegram.js";
import { TelegramPoll } from "../channel/telegram-poll.js";
import { KubectlAteControl } from "../lifecycle/kubectl.js";
import type { ActorControl } from "../lifecycle/types.js";

const run = promisify(execFile);

const atespace = process.env.PI_ATESPACE ?? "pi-agents";
const idleSeconds = Number(process.env.PI_IDLE_SECONDS ?? 60);
const template = process.env.PI_ACTOR_TEMPLATE ?? "pi-actor";
const egressPolicy = process.env.PI_EGRESS_POLICY ?? "deploy/test/egress-policy.yaml";
const telegramToken = process.env.PI_TELEGRAM_TOKEN;
const telegramApi = process.env.PI_TELEGRAM_API;
const telegramChats = (process.env.PI_TELEGRAM_CHATS ?? "")
	.split(",")
	.map((value) => value.trim())
	.filter(Boolean);

const control: ActorControl = new KubectlAteControl({
	binary: process.env.KUBECTL_ATE,
	context: process.env.KUBE_CONTEXT,
	template,
	log: (message) => console.error(`[lifecycle] ${message}`),
});

/**
 * Applies the egress policy to a new actor. Without it the sandbox cannot
 * reach the model, and the failure looks like an empty reply rather than an
 * error, so this runs before the first turn is dispatched.
 */
async function provision(actor: { atespace: string; name: string }): Promise<void> {
	if (!egressPolicy) return;
	const command = [
		process.env.KUBECTL_ATE ?? "kubectl-ate",
		...(process.env.KUBE_CONTEXT ? ["--context", process.env.KUBE_CONTEXT] : []),
		"create",
		"egress-policy",
		actor.name,
		"-a",
		actor.atespace,
		"-f",
		egressPolicy,
	];
	try {
		await run(command[0] ?? "kubectl-ate", command.slice(1));
		console.error(`[lifecycle] applied egress policy to ${actor.atespace}/${actor.name}`);
	} catch (error) {
		const text = error instanceof Error ? `${error.message}\n${(error as { stderr?: string }).stderr ?? ""}` : String(error);
		if (!text.includes("AlreadyExists")) throw error;
	}
}

const manager = new GatewayManager({
	dataDir: process.env.PI_GATEWAY_DATA_DIR ?? "/tmp/pi-gateway",
	actorUrl: process.env.PI_ACTOR_URL ?? "ws://127.0.0.1:8000",
	control,
	provision,
	// Telegram chats reply in place; every other conversation answers through
	// POST /messages, which reads the conversation's turn recorder.
	createChannel: (conversation) =>
		telegramToken && conversation.conversationId.startsWith("telegram/")
			? new TelegramChannel({
					botToken: telegramToken,
					chatId: conversation.conversationId.slice("telegram/".length),
					apiBase: telegramApi,
				})
			: undefined,
	log: (message) => console.error(`[gateway] ${message}`),
});

const specFor = (conversationId: string): ConversationSpec => ({
	conversationId,
	atespace,
	template,
	idleMs: idleSeconds * 1000,
});

const server = await startHttpServer({
	manager,
	port: Number(process.env.PI_HTTP_PORT ?? 8788),
	host: process.env.PI_HTTP_HOST ?? "127.0.0.1",
	specFor,
	log: (message) => console.error(`[http] ${message}`),
});

console.log(`gateway on http://127.0.0.1:${server.port}/messages`);
if (telegramToken) {
	console.log(`telegram polling as bot; chats: ${telegramChats.join(", ") || "any"}`);
}

const stop = new AbortController();
if (telegramToken) {
	const poll = new TelegramPoll(manager, {
		botToken: telegramToken,
		specFor,
		apiBase: telegramApi,
		allowedChatIds: telegramChats,
		log: (message) => console.error(`[telegram] ${message}`),
	});
	await poll.skipBacklog();
	void poll.run(stop.signal);
}

for (const signal of ["SIGTERM", "SIGINT"] as const) {
	process.on(signal, () => {
		stop.abort();
		void server.close().finally(() => manager.close()).finally(() => process.exit(0));
	});
}
