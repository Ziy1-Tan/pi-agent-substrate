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
 * The gateway runs as a Deployment next to the workers and speaks to the
 * router over its projected podidentity certificate; both paths below are
 * fixed by that deployment. Configuration is environment only:
 *
 *   ATESPACE             atespace that holds the actors (default pi-agents)
 *   ACTOR_TEMPLATE       template used to create a missing actor (default pi-actor)
 *   EGRESS_POLICY        manifest applied to each new actor (default
 *                        /etc/pi/egress-policy.yaml, where the manifest mounts it)
 *   IDLE_SECONDS         idle window before suspend (0 disables, default 60)
 *
 * The `PI_*` variables configure the model and are read by the actor, not
 * here: `PI_PROVIDER`, `PI_MODEL`, `PI_PROVIDER_BASE_URL`, and the model metadata.
 */
import { GatewayManager } from "./manager.js";
import { startHttpServer } from "./server.js";
import { KubectlAteControl } from "./substrate/kubectl.js";

const manager = new GatewayManager({
  actorUrl: "wss://atenet-router.ate-system.svc:443",
  transportTls: {
    ca: "/run/pi-router/router-ca.pem",
    cert: "/run/pi-router/credential-bundle.pem",
    key: "/run/pi-router/credential-bundle.pem",
  },
  control: new KubectlAteControl({
    template: process.env.ACTOR_TEMPLATE ?? "pi-actor",
    log: (message) => console.error(`[substrate] ${message}`),
  }),
  atespace: process.env.ATESPACE ?? "pi-agents",
  // Without an egress policy the sandbox cannot reach the model, and the
  // failure looks like an empty reply rather than an error.
  egressPolicy: process.env.EGRESS_POLICY ?? "/etc/pi/egress-policy.yaml",
  idleMs: Number(process.env.IDLE_SECONDS ?? 60) * 1000,
  log: (message) => console.error(`[gateway] ${message}`),
});

const server = await startHttpServer({
  manager,
  port: 8788,
  host: "0.0.0.0",
  log: (message) => console.error(`[http] ${message}`),
});

console.log(`gateway on :${server.port}/messages`);

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => {
    void server
      .close()
      .finally(() => manager.close())
      .finally(() => process.exit(0));
  });
}
