#!/usr/bin/env node
/**
 * Gateway entry point. One HTTP entry per turn:
 *
 *   curl   POST /messages with {conversation, text} and read the reply in the
 *          response; GET /metrics reports turn and lifecycle counters.
 *
 * An incoming message is the only thing that wakes an actor: the gateway
 * creates it on first use, the router resumes a suspended one, and the idle
 * lifecycle suspends it again once the turn is recorded.
 *
 * Configuration is environment only:
 *
 *   PI_ACTOR_URL           bridge WebSocket (required)
 *   PI_ROUTER_CA           CA bundle for a wss router (in-cluster gateway)
 *   PI_ROUTER_CERT         client certificate chain for the router
 *   PI_ROUTER_KEY          private key for PI_ROUTER_CERT
 *   PI_ATESPACE            atespace that holds the actors
 *   PI_ACTOR_TEMPLATE      template used to create a missing actor
 *   PI_EGRESS_POLICY       manifest applied to each new actor (default
 *                          `deploy/e2e/egress-policy.yaml`; empty disables it)
 *   PI_IDLE_SECONDS        idle window before suspend (0 disables, default 60)
 */
import { GatewayManager, type ConversationSpec } from "./manager.js";
import { startHttpServer } from "./channel/server.js";
import { KubectlAteControl } from "./substrate/kubectl.js";
import { ActorProvisioner } from "./substrate/provisioner.js";

const idleSeconds = Number(process.env.PI_IDLE_SECONDS ?? 60);
const egressPolicy = process.env.PI_EGRESS_POLICY ?? "deploy/e2e/egress-policy.yaml";

const routerTls = {
	ca: process.env.PI_ROUTER_CA,
	cert: process.env.PI_ROUTER_CERT,
	key: process.env.PI_ROUTER_KEY,
};

const actorUrl = process.env.PI_ACTOR_URL;
if (!actorUrl) throw new Error("PI_ACTOR_URL is required");

const control = new KubectlAteControl({
	template: process.env.PI_ACTOR_TEMPLATE ?? "pi-actor",
	log: (message) => console.error(`[substrate] ${message}`),
});

// Without an egress policy the sandbox cannot reach the model, and the failure
// looks like an empty reply rather than an error.
const actors = new ActorProvisioner({
	atespace: process.env.PI_ATESPACE ?? "pi-agents",
	control,
	applyEgress: egressPolicy ? (actor) => control.createEgressPolicy(actor, egressPolicy) : undefined,
});

const manager = new GatewayManager({
	actorUrl,
	transportTls: routerTls.ca || routerTls.cert || routerTls.key ? routerTls : undefined,
	actors,
	log: (message) => console.error(`[gateway] ${message}`),
});

const specFor = (conversationId: string): ConversationSpec => ({
	conversationId,
	idleMs: idleSeconds * 1000,
});

const server = await startHttpServer({
	manager,
	port: 8788,
	host: "0.0.0.0",
	specFor,
	log: (message) => console.error(`[http] ${message}`),
});

console.log(`gateway on http://127.0.0.1:${server.port}/messages`);

for (const signal of ["SIGTERM", "SIGINT"] as const) {
	process.on(signal, () => {
		void server.close().finally(() => manager.close()).finally(() => process.exit(0));
	});
}
