#!/usr/bin/env node
/**
 * Clustered gateway e2e: the HTTP entry point against a real actor.
 *
 * The gateway runs locally against the router port-forward, so the
 * conversation-to-actor mapping, the idle lifecycle, and the metrics are all
 * the deployed code paths.
 *
 * A kind WorkerPool is small, so the two conversations are exercised in
 * sequence: the first one finishes and suspends before the second opens. The
 * point is that each conversation owns a distinct actor and its own log, not
 * that two actors run at once.
 *
 *   1. `POST /messages` answers a curl-sized request with the settled reply
 *   2. /metrics reports the turn, and the page is gone (404)
 *   3. the idle window suspends the actor with no command, and the next
 *      message resumes it; the resume latency lands in /metrics
 *   4. a second conversation gets a different actor and its own log
 */
import { spawn, execFile } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const atespace = process.env.PI_ATESPACE ?? "pi-agents";
const router = process.env.PI_ROUTER_URL ?? "http://127.0.0.1:8000";
const idleSeconds = Number(process.env.PI_IDLE_SECONDS ?? 12);
const port = Number(process.env.PI_WEB_PORT ?? 8899);
const actorPrefix = process.env.PI_ACTOR_PREFIX ?? "pi-";
const kubectlAte = process.env.KUBECTL_ATE ?? "kubectl-ate";
const kubeContext = process.env.KUBE_CONTEXT;
/**
 * The template the gateway creates actors from. Without an explicit value the
 * gateway falls back to `pi-actor`, which is the manual template, not the one
 * the run just built; a leftover actor from an earlier run would then resume
 * against a snapshot its worker no longer holds.
 */
const actorTemplate = process.env.PI_ACTOR_TEMPLATE ?? "pi-e2e";
const conversations = (process.env.PI_E2E_CONVERSATIONS ?? "web/alpha,web/beta").split(",");

/** Mirrors `actorNameFor` in the gateway; the e2e checks the mapping it relies on. */
function actorNameFor(conversationId) {
	const sanitized = conversationId
		.toLowerCase()
		.replace(/[^a-z0-9-]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 40);
	return `${actorPrefix}${sanitized || "conversation"}`;
}

const log = (message) => console.log(`[web-e2e] ${message}`);
const checks = [];
function check(name, condition, detail = "") {
	checks.push({ name, ok: Boolean(condition) });
	if (condition) log(`PASS ${name}`);
	else log(`FAIL ${name}${detail ? `: ${detail}` : ""}`);
}

/** Actor state, or undefined when the actor does not exist. */
async function actorState(name) {
	const args = [
		kubectlAte,
		...(kubeContext ? ["--context", kubeContext] : []),
		"get",
		"actors",
		name,
		"-a",
		atespace,
		"-o",
		"json",
	];
	try {
		const { stdout } = await promisify(execFile)(args[0], args.slice(1), { maxBuffer: 16 * 1024 * 1024 });
		const parsed = JSON.parse(stdout);
		const entry = Array.isArray(parsed.actors) ? parsed.actors[0] : parsed;
		return entry?.status?.state ?? "UNKNOWN";
	} catch {
		return undefined;
	}
}

/**
 * Removes an actor an earlier run left behind. It is bound to the template of
 * whichever run created it, and a rerun rebuilds that template, so the old
 * actor can no longer resume; keeping it turns the next run into a 503 from
 * the router rather than a clean start.
 */
async function removeActor(name) {
	if ((await actorState(name)) === undefined) return;
	const args = [
		kubectlAte,
		...(kubeContext ? ["--context", kubeContext] : []),
		"delete",
		"actor",
		name,
		"-a",
		atespace,
		"--any-state",
	];
	try {
		await promisify(execFile)(args[0], args.slice(1), { maxBuffer: 16 * 1024 * 1024 });
		log(`removed actor ${name}`);
	} catch (error) {
		log(`could not remove actor ${name}: ${error instanceof Error ? error.message : String(error)}`);
	}
}

async function waitFor(getter, predicate, timeoutMs, label) {
	const deadline = Date.now() + timeoutMs;
	let last;
	while (Date.now() < deadline) {
		last = await getter();
		if (predicate(last)) return last;
		await new Promise((resolve) => setTimeout(resolve, 500));
	}
	throw new Error(`timed out waiting for ${label}: ${JSON.stringify(last)}`);
}

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
	for (const conversationId of conversations) await removeActor(actorNameFor(conversationId));

	const dataDir = await mkdtemp(join(tmpdir(), "pi-web-e2e-"));
	const gateway = spawn(process.execPath, ["dist/src/bin/web.js"], {
		env: {
			...process.env,
			PI_GATEWAY_DATA_DIR: dataDir,
			PI_WEB_PORT: String(port),
			PI_ACTOR_URL: `ws://${new URL(router).host}`,
			PI_ATESPACE: atespace,
			PI_ACTOR_TEMPLATE: actorTemplate,
			PI_IDLE_SECONDS: String(idleSeconds),
		},
		stdio: ["ignore", "pipe", "pipe"],
	});
	gateway.stdout.on("data", (chunk) => process.stdout.write(chunk));
	gateway.stderr.on("data", (chunk) => process.stderr.write(chunk));

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
			"the web server",
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
			(await actorState(actorNameFor(alphaId))) !== undefined,
			actorNameFor(alphaId),
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
			() => actorState(actorNameFor(alphaId)),
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
		// first one has suspended. It still gets its own actor and its own log.
		const beta = await post(betaId, "say hello to beta");
		check(
			"the second conversation gets its own reply",
			beta.status === 200 && /Hello from the mock model/.test(beta.body.text ?? ""),
			JSON.stringify(beta.body),
		);

		const alphaActor = actorNameFor(alphaId);
		const betaActor = actorNameFor(betaId);
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
		check("turn latency is recorded", (metrics.timings?.turn_millis?.count ?? 0) >= 3, JSON.stringify(metrics.timings));
		check("first-token latency is recorded", (metrics.timings?.first_token_millis?.count ?? 0) >= 3);
		log(`resume latency p50=${metrics.timings?.resume_millis?.p50}ms p95=${metrics.timings?.resume_millis?.p95}ms`);
		log(`turn latency p50=${metrics.timings?.turn_millis?.p50}ms p95=${metrics.timings?.turn_millis?.p95}ms`);
	} finally {
		gateway.kill("SIGTERM");
		await new Promise((resolve) => gateway.once("exit", resolve));
		// The gateway was this e2e's only suspend driver. Without a second
		// worker slot, an actor left RUNNING here takes a slot from a real
		// conversation and makes its next turn fail with a 503, so remove what
		// this run created. Removing an actor also drops its egress policy.
		for (const conversationId of conversations) await removeActor(actorNameFor(conversationId));
	}

	const failed = checks.filter((entry) => !entry.ok);
	log(`${checks.length - failed.length}/${checks.length} checks passed`);
	if (failed.length > 0) process.exit(1);
}

main().catch((error) => {
	console.error(`[web-e2e] ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
	process.exit(1);
});
