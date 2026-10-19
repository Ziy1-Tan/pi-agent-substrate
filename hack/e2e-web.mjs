#!/usr/bin/env node
/**
 * Clustered M4 e2e: the browser channel against a real actor.
 *
 * The web gateway runs locally against the router port-forward, so the
 * conversation-to-actor mapping, the replay ring, and the metrics are all the
 * deployed code paths.
 *
 * A kind WorkerPool is small, so the two conversations are exercised in
 * sequence: the first one finishes and suspends before the second opens. The
 * point is that each conversation owns a distinct actor and its own log, not
 * that two actors run at once.
 *
 *   1. the page and /metrics are served
 *   2. a conversation streams a reply and is recorded under its own actor
 *   3. dropping the socket mid-stream and reconnecting with `since` replays
 *      exactly the missed frames, with no duplicate and no gap
 *   4. the idle window suspends the actor with no command, and the next
 *      message resumes it; the resume latency lands in /metrics
 *   5. a second conversation gets a different actor and its own log
 */
import { spawn, execFile } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import WebSocket from "ws";

const atespace = process.env.PI_ATESPACE ?? "pi-agents";
const router = process.env.PI_ROUTER_URL ?? "http://127.0.0.1:8000";
const idleSeconds = Number(process.env.PI_IDLE_SECONDS ?? 12);
const port = Number(process.env.PI_WEB_PORT ?? 8899);
const actorPrefix = process.env.PI_ACTOR_PREFIX ?? "pi-";
const kubectlAte = process.env.KUBECTL_ATE ?? "kubectl-ate";
const kubeContext = process.env.KUBE_CONTEXT;
const conversations = (process.env.PI_CONVERSATIONS ?? "web/alpha,web/beta").split(",");

/** Mirrors `actorNameFor` in the gateway; the e2e checks the mapping it relies on. */
function actorNameFor(conversationId) {
	const sanitized = conversationId
		.toLowerCase()
		.replace(/[^a-z0-9-]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 40);
	return `${actorPrefix}${sanitized || "conversation"}`;
}

/** The conversation a frame belongs to; state frames carry `conversationId`. */
function frameOwner(frame) {
	return frame.conversationId ?? frame.conversation;
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

function connect(conversation, since) {
	const query = `conversation=${encodeURIComponent(conversation)}${since === undefined ? "" : `&since=${since}`}`;
	const socket = new WebSocket(`ws://127.0.0.1:${port}/events?${query}`);
	const frames = [];
	const waiters = [];
	socket.on("message", (data) => {
		frames.push(JSON.parse(String(data)));
		for (const wake of waiters.splice(0)) wake();
	});
	return {
		socket,
		frames,
		async open() {
			await new Promise((resolve, reject) => {
				socket.once("open", resolve);
				socket.once("error", reject);
			});
		},
		/** Waits for a frame matching `predicate`, ignoring everything already there. */
		async next(predicate, timeoutMs, label) {
			const start = frames.length;
			const deadline = Date.now() + timeoutMs;
			for (;;) {
				const found = frames.slice(start).find(predicate);
				if (found) return found;
				if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}: ${JSON.stringify(frames.slice(start).slice(-6))}`);
				await new Promise((resolve) => {
					waiters.push(resolve);
					setTimeout(resolve, 100);
				});
			}
		},
		async waitFor(predicate, timeoutMs, label) {
			const deadline = Date.now() + timeoutMs;
			for (;;) {
				const found = frames.find(predicate);
				if (found) return found;
				if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}: ${JSON.stringify(frames.slice(-6))}`);
				await new Promise((resolve) => {
					waiters.push(resolve);
					setTimeout(resolve, 100);
				});
			}
		},
		send(payload) {
			socket.send(JSON.stringify(payload));
		},
	};
}

async function main() {
	const dataDir = await mkdtemp(join(tmpdir(), "pi-web-e2e-"));
	const gateway = spawn(process.execPath, ["dist/src/bin/web.js"], {
		env: {
			...process.env,
			PI_GATEWAY_DATA_DIR: dataDir,
			PI_WEB_PORT: String(port),
			PI_ACTOR_URL: `ws://${new URL(router).host}`,
			PI_ATESPACE: atespace,
			PI_IDLE_SECONDS: String(idleSeconds),
			PI_CONVERSATIONS: conversations.join(","),
		},
		stdio: ["ignore", "pipe", "pipe"],
	});
	gateway.stdout.on("data", (chunk) => process.stdout.write(chunk));
	gateway.stderr.on("data", (chunk) => process.stderr.write(chunk));

	const clients = [];
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

		const page = await fetch(`http://127.0.0.1:${port}/`);
		check("the page is served", page.status === 200 && /pi-agent-substrate/.test(await page.text()));

		const [alphaId, betaId] = conversations;
		if (!alphaId || !betaId) throw new Error("PI_CONVERSATIONS needs two ids");

		const alpha = connect(alphaId);
		clients.push(alpha);
		await alpha.open();
		await alpha.waitFor((frame) => frame.type === "hello", 120_000, "alpha hello");

		alpha.send({ type: "message", text: "say hello to alpha" });
		const alphaFinal = await alpha.waitFor((frame) => frame.type === "final", 120_000, "alpha final");
		check("the first conversation streams a reply", alphaFinal.text?.includes("Hello from the mock model"), alphaFinal.text);
		check(
			"the conversation is bound to a deterministic actor",
			(await actorState(`${actorPrefix}${alphaId.replace(/[^a-z0-9-]+/gi, "-")}`)) !== undefined,
		);

		// Drop the socket mid-stream, then resume from the last frame received.
		alpha.send({ type: "message", text: "drop this stream halfway" });
		const early = await alpha.waitFor((frame) => frame.type === "preview", 120_000, "a preview");
		const seenUpTo = early.seq ?? 0;
		alpha.socket.close();
		const resumed = connect(alphaId, seenUpTo);
		clients.push(resumed);
		await resumed.open();
		const hello = await resumed.waitFor((frame) => frame.type === "hello", 30_000, "hello after reconnect");
		check("reconnect reports the live cursor", (hello.lastSeq ?? 0) > seenUpTo);

		const replayed = resumed.frames.filter((frame) => frame.type === "preview").map((frame) => frame.seq ?? 0);
		check("the missed previews are replayed", replayed.length > 0, JSON.stringify(replayed));
		check("replay starts right after the last seen frame", Math.min(...replayed) === seenUpTo + 1, String(seenUpTo));
		check("no frame is delivered twice", new Set(replayed).size === replayed.length);

		const final = await resumed.waitFor((frame) => frame.type === "final", 120_000, "final after reconnect");
		check("the reconnected client gets the final text", final.text?.includes("Hello from the mock model"), final.text);

		// The idle lifecycle owns the actor now: no suspend command here.
		log(`waiting ${idleSeconds}s for the idle window to suspend ${alphaId}`);
		const suspended = await waitFor(
			async () => (await (await fetch(`http://127.0.0.1:${port}/metrics`)).json()),
			(snapshot) => (snapshot.counters?.suspends ?? 0) >= 1,
			(idleSeconds + 40) * 1000,
			"an automatic suspend",
		);
		check("an idle conversation suspends on its own", (suspended.counters?.suspends ?? 0) >= 1);

		resumed.send({ type: "message", text: "are you awake" });
		const resumedFinal = await resumed.next(
			(frame) => frame.type === "final",
			120_000,
			"final after resume",
		);
		check("the suspended conversation resumes on the next message", resumedFinal.text?.includes("Hello from the mock model"), resumedFinal.text);

		// A kind WorkerPool is small, so the second conversation runs after the
		// first one has suspended. It still gets its own actor and its own log.
		const beta = connect(betaId);
		clients.push(beta);
		await beta.open();
		await beta.waitFor((frame) => frame.type === "hello", 120_000, "beta hello");
		beta.send({ type: "message", text: "say hello to beta" });
		const betaFinal = await beta.waitFor((frame) => frame.type === "final", 120_000, "beta final");
		check("the second conversation streams its own reply", betaFinal.text?.includes("Hello from the mock model"), betaFinal.text);
		const alphaActor = actorNameFor(alphaId);
		const betaActor = actorNameFor(betaId);
		check("the conversation names map to distinct actors", alphaActor !== betaActor, `${alphaActor} / ${betaActor}`);
		check(
			"both actors exist in the atespace",
			(await actorState(alphaActor)) !== undefined && (await actorState(betaActor)) !== undefined,
			`${alphaActor}=${await actorState(alphaActor)} ${betaActor}=${await actorState(betaActor)}`,
		);
		// The mock reply text repeats across turns, so stream isolation is
		// checked on the conversation id every frame carries.
		check(
			"neither conversation sees the other's stream",
			alpha.frames.every((frame) => frameOwner(frame) === alphaId) &&
				beta.frames.every((frame) => frameOwner(frame) === betaId),
		);

		const metrics = await (await fetch(`http://127.0.0.1:${port}/metrics`)).json();
		check("turns are counted", (metrics.counters?.turns ?? 0) >= 4, JSON.stringify(metrics.counters));
		check("resumed turns are counted", (metrics.counters?.resumed_turns ?? 0) >= 1, JSON.stringify(metrics.counters));
		check("turn latency is recorded", (metrics.timings?.turn_millis?.count ?? 0) >= 4, JSON.stringify(metrics.timings));
		check("first-token latency is recorded", (metrics.timings?.first_token_millis?.count ?? 0) >= 4);
		log(`resume latency p50=${metrics.timings?.resume_millis?.p50}ms p95=${metrics.timings?.resume_millis?.p95}ms`);
		log(`turn latency p50=${metrics.timings?.turn_millis?.p50}ms p95=${metrics.timings?.turn_millis?.p95}ms`);
	} finally {
		for (const client of clients) client.socket.close();
		gateway.kill("SIGTERM");
		await new Promise((resolve) => gateway.once("exit", resolve));
	}

	const failed = checks.filter((entry) => !entry.ok);
	log(`${checks.length - failed.length}/${checks.length} checks passed`);
	if (failed.length > 0) process.exit(1);
}

main().catch((error) => {
	console.error(`[web-e2e] ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
	process.exit(1);
});
