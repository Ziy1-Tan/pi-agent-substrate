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
 * The gateway runs as a Deployment next to the workers. It authenticates to
 * both the router and ate-api with its projected pod certificate; the paths
 * below are fixed by that deployment. Configuration is environment only:
 *
 *   ATESPACE             atespace that holds the actors (default pi-agents)
 *   ACTOR_TEMPLATE       template used to create a missing actor (default pi-actor)
 *   EGRESS_POLICY        manifest applied to each new actor (default
 *                        /etc/pi/egress-policy.yaml, where the manifest mounts it)
 *   IDLE_SECONDS         idle window before suspend (0 disables, default 60)
 *
 * The `PI_*` variables configure the model and are read by the actor, not here.
 */
import { readFileSync } from "node:fs";

import { parse } from "yaml";

import {
  AteApi,
  checkEgressPolicy,
  podCertificateCredentials,
  type EgressPolicyManifest,
} from "./ateapi.js";
import { Gateway } from "./gateway.js";
import { startHttpServer } from "./http.js";

const identity = {
  ca: "/run/pi-identity/service-ca.pem",
  bundle: "/run/pi-identity/credential-bundle.pem",
};

const egressPath = process.env.EGRESS_POLICY ?? "/etc/pi/egress-policy.yaml";
const egressPolicy = parse(readFileSync(egressPath, "utf8")) as EgressPolicyManifest;
// Fail at startup, not on the first message, if the manifest has a field the
// proto subset would drop.
checkEgressPolicy(egressPolicy);

const ateApi = new AteApi({
  target: "dns:///api.ate-system.svc:443",
  template: process.env.ACTOR_TEMPLATE ?? "pi-actor",
  credentials: podCertificateCredentials(identity),
});
const gateway = new Gateway({
  control: ateApi,
  endpoint: { url: "wss://atenet-router.ate-system.svc:443", identity },
  atespace: process.env.ATESPACE ?? "pi-agents",
  egressPolicy,
  idleMs: Number(process.env.IDLE_SECONDS ?? 60) * 1000,
  log: (message) => console.error(`[gateway] ${message}`),
});

const server = await startHttpServer({
  gateway,
  port: 8788,
  host: "0.0.0.0",
  log: (message) => console.error(`[http] ${message}`),
});

console.log(`gateway on :${server.port}/messages`);

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => {
    void server
      .close()
      .finally(() => gateway.close())
      .finally(() => ateApi.close())
      .finally(() => process.exit(0));
  });
}
