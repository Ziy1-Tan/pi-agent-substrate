#!/usr/bin/env node
/**
 * Clustered gateway e2e: the HTTP entry point against a real actor.
 *
 * The gateway runs in the cluster, so the conversation-to-actor mapping, the
 * idle lifecycle, the router ingress, and the metrics are all the deployed
 * code paths. The shell script deploys it and forwards its port.
 *
 * A kind WorkerPool is small, so the two conversations are exercised in
 * sequence: the first one finishes and suspends before the second opens. The
 * point is that each conversation owns a distinct actor, not that two actors
 * run at once.
 *
 *   1. `POST /messages` answers a curl-sized request with the settled reply
 *   2. /metrics reports the turn, and `/` answers 404 since the page is gone
 *   3. the idle window suspends the actor with no command, and the next
 *      message resumes it; the counters show it
 *   4. a second conversation gets a different actor
 */
import { actorNameFor, actorState as readActorState, ateClient, createChecks, removeActor, waitFor } from "./lib.js";

const { atespace, ate } = ateClient();
const idleSeconds = Number(process.env.PI_IDLE_SECONDS ?? 12);
const port = Number(process.env.PI_HTTP_PORT ?? 8899);
const actorPrefix = process.env.PI_ACTOR_PREFIX ?? "pi-";
const conversations = (process.env.PI_E2E_CONVERSATIONS ?? "web/alpha,web/beta").split(",");

const log = (message) => console.log(`[gateway-e2e] ${message}`);
const { check, checks } = createChecks(log);
const client = { ate, atespace };
const actorState = (name) => readActorState(client, name);
const dropActor = (name) => removeActor(client, name, log);

/** One turn through the HTTP entry point; returns the parsed response body. */
async function post(conversationId, text) {
	const response = await fetch(`http://127.0.0.1:${port}/messages`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ conversation: conversationId, text }),
	});
	return { status: response.status, body: await response.json() };
}

async function main() {
	// Both conversations get an actor on first use. Clear whatever an earlier
	// run left so this run tests the template it was given; the same cleanup
	// runs after the checks, so a passing run leaves nothing behind either.
	for (const conversationId of conversations) await dropActor(actorNameFor(conversationId, actorPrefix));

	try {
		await waitFor(
			async () => {
				try {
					return (await fetch(`http://127.0.0.1:${port}/metrics`)).status;
				} catch {
					return 0;
				}
			},
			(status) => status === 200,
			60_000,
			"the gateway HTTP server",
		);

		const missing = await fetch(`http://127.0.0.1:${port}/`);
		check("the browser page is gone", missing.status === 404, String(missing.status));

		const [alphaId, betaId] = conversations;
		if (!alphaId || !betaId) throw new Error("PI_E2E_CONVERSATIONS needs two ids");

		// The curl entry point: one request, one settled reply.
		const curl = await post(alphaId, "hello from curl");
		check(
			"POST /messages answers with the settled reply",
			curl.status === 200 && /Hello from the mock model/.test(curl.body.text ?? ""),
			JSON.stringify(curl.body),
		);
		check(
			"the conversation is bound to a deterministic actor",
			(await actorState(actorNameFor(alphaId, actorPrefix))) !== undefined,
			actorNameFor(alphaId, actorPrefix),
		);

		// The idle lifecycle owns the actor now: no suspend command here.
		log(`waiting ${idleSeconds}s for the idle window to suspend ${alphaId}`);
		const suspended = await waitFor(
			async () => (await (await fetch(`http://127.0.0.1:${port}/metrics`)).json()),
			(snapshot) => (snapshot.counters?.suspends ?? 0) >= 1,
			(idleSeconds + 40) * 1000,
			"an automatic suspend",
		);
		check("an idle conversation suspends on its own", (suspended.counters?.suspends ?? 0) >= 1);

		// The lifecycle reports the suspend as soon as the control plane
		// accepts it; the worker is only free once the actor is actually down.
		await waitFor(
			() => actorState(actorNameFor(alphaId, actorPrefix)),
			(state) => state === "ACTOR_STATE_SUSPENDED",
			(idleSeconds + 40) * 1000,
			"alpha to leave its worker",
		);

		const resumed = await post(alphaId, "are you awake");
		check(
			"the suspended conversation resumes on the next message",
			resumed.status === 200 && /Hello from the mock model/.test(resumed.body.text ?? ""),
			JSON.stringify(resumed.body),
		);

		// A kind WorkerPool is small, so the second conversation runs after the
		// first one has suspended. It still gets its own actor.
		const beta = await post(betaId, "say hello to beta");
		check(
			"the second conversation gets its own reply",
			beta.status === 200 && /Hello from the mock model/.test(beta.body.text ?? ""),
			JSON.stringify(beta.body),
		);

		const alphaActor = actorNameFor(alphaId, actorPrefix);
		const betaActor = actorNameFor(betaId, actorPrefix);
		check("the conversation names map to distinct actors", alphaActor !== betaActor, `${alphaActor} / ${betaActor}`);
		check(
			"both actors exist in the atespace",
			(await actorState(alphaActor)) !== undefined && (await actorState(betaActor)) !== undefined,
			`${alphaActor}=${await actorState(alphaActor)} ${betaActor}=${await actorState(betaActor)}`,
		);
		check("the replies name their own conversation", beta.body.conversation === betaId, beta.body.conversation);

		const metrics = await (await fetch(`http://127.0.0.1:${port}/metrics`)).json();
		check("turns are counted", (metrics.counters?.turns ?? 0) >= 3, JSON.stringify(metrics.counters));
		check("resumed turns are counted", (metrics.counters?.resumed_turns ?? 0) >= 1, JSON.stringify(metrics.counters));
	} finally {
		// Without a second worker slot, an actor left RUNNING here takes a slot
		// from a real conversation and makes its next turn fail with a 503, so
		// remove what this run created. Removing an actor also drops its egress
		// policy. The shell removes the gateway itself.
		for (const conversationId of conversations) await dropActor(actorNameFor(conversationId, actorPrefix));
	}

	const failed = checks.filter((entry) => !entry.ok);
	log(`${checks.length - failed.length}/${checks.length} checks passed`);
	if (failed.length > 0) process.exit(1);
}

main().catch((error) => {
	console.error(`[gateway-e2e] ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
	process.exit(1);
});
