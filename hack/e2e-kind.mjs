#!/usr/bin/env node
/**
 * Clustered M2 e2e. It drives the real path with no fake actor:
 *
 *   test process -> atenet-router -> actor (bridge -> pi -> mock LLM)
 *
 * Steps:
 *   1. wait for the actor's bridge to answer through the router
 *   2. prompt, and assert the mock reply streams back through the bridge
 *   3. ask Pi to run a shell tool that writes /workspace/e2e.txt
 *   4. suspend the actor through the control plane
 *   5. prompt again; the router resumes the actor on first connect
 *   6. read the file back and assert the session still has the first turn
 *
 * Everything is a real external call; nothing is stubbed. Requires the
 * templates and worker pool from hack/e2e-kind.sh.
 */
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import WebSocket from "ws";

const run = promisify(execFile);

const atespace = process.env.PI_ATESPACE ?? "pi-agents";
const actor = process.env.PI_ACTOR ?? "pi-actor-1";
const router = process.env.PI_ROUTER_URL ?? "http://127.0.0.1:8000";
const kubectlAte = process.env.KUBECTL_ATE ?? "kubectl-ate";
const kubeContext = process.env.KUBE_CONTEXT;

const log = (message) => console.log(`[e2e] ${message}`);

async function ate(...args) {
	const command = [kubectlAte, ...(kubeContext ? ["--context", kubeContext] : []), ...args];
	const { stdout } = await run(command[0], command.slice(1), { maxBuffer: 16 * 1024 * 1024 });
	return stdout;
}

async function actorState() {
	const stdout = await ate("get", "actors", actor, "-a", atespace, "-o", "json");
	const parsed = JSON.parse(stdout);
	// A single named actor comes back as one object; a list comes back wrapped.
	const entry = Array.isArray(parsed.actors) ? parsed.actors[0] : parsed;
	return entry?.status?.state ?? "UNKNOWN";
}

async function waitForState(predicate, timeoutMs, label) {
	const deadline = Date.now() + timeoutMs;
	let state = "UNKNOWN";
	while (Date.now() < deadline) {
		state = await actorState();
		if (predicate(state)) return state;
		await new Promise((resolve) => setTimeout(resolve, 1000));
	}
	throw new Error(`timed out waiting for ${label}; last state ${state}`);
}

class ActorClient {
	constructor() {
		this.events = [];
		this.waiters = [];
		this.closed = false;
	}

	async connect() {
		const wsUrl = `${router.replace(/^http/, "ws")}/`;
		this.socket = new WebSocket(wsUrl, { headers: { "ate-target-actor": `${atespace}/${actor}` } });
		this.socket.on("message", (data) => {
			const record = JSON.parse(String(data));
			this.events.push(record);
			for (const wake of this.waiters.splice(0)) wake();
		});
		this.socket.on("close", () => {
			this.closed = true;
			for (const wake of this.waiters.splice(0)) wake();
		});
		await new Promise((resolve, reject) => {
			this.socket.once("open", resolve);
			this.socket.once("error", reject);
		});
		return this;
	}

	send(command) {
		this.socket.send(JSON.stringify(command));
	}

	async waitFor(predicate, timeoutMs = 60_000) {
		const deadline = Date.now() + timeoutMs;
		for (;;) {
			const found = this.events.find(predicate);
			if (found) return found;
			if (Date.now() > deadline) {
				throw new Error(`timed out; events: ${JSON.stringify(this.events.slice(-4))}`);
			}
			if (this.closed) throw new Error("connection closed while waiting");
			await new Promise((wake) => this.waiters.push(wake));
		}
	}

	async prompt(requestId, message) {
		this.send({ id: requestId, requestId, type: "prompt", message });
		const response = await this.waitFor((event) => event.type === "response" && event.id === requestId);
		if (response.success !== true) throw new Error(`prompt rejected: ${JSON.stringify(response)}`);
		return this.waitFor((event) => event.type === "bridge_result" && event.requestId === requestId, 120_000);
	}

	close() {
		this.socket?.close();
	}
}

/** True when Pi reported a successful tool execution whose output includes `needle`. */
function toolOutputContains(client, needle) {
	return client.events.some((event) => {
		if (event.type !== "tool_execution_end" || event.isError) return false;
		return JSON.stringify(event.result ?? "").includes(needle);
	});
}

function toolSucceeded(client, needle) {
	// tool_execution_start carries the arguments; tool_execution_end carries
	// the outcome. Correlate them by toolCallId.
	const started = new Set(
		client.events
			.filter((event) => event.type === "tool_execution_start" && JSON.stringify(event.args ?? "").includes(needle))
			.map((event) => event.toolCallId),
	);
	return client.events.some(
		(event) => event.type === "tool_execution_end" && !event.isError && started.has(event.toolCallId),
	);
}

const checks = [];
function check(name, condition, detail = "") {
	checks.push({ name, ok: Boolean(condition), detail });
	if (condition) log(`PASS ${name}`);
	else log(`FAIL ${name}${detail ? `: ${detail}` : ""}`);
}

async function main() {
	log(`router ${router}, actor ${atespace}/${actor}`);
	// The router resumes the actor on the first connect, so the initial state
	// is allowed to be SUSPENDED; readiness is proven by the bridge hello.
	// The mock LLM is the only egress the actor is allowed. A real deployment
	// points this at the model provider and keeps the key in the egress layer.
	await ate("create", "egress-policy", actor, "-a", atespace, "-f", "deploy/test/egress-policy.yaml").catch((error) => {
		if (!String(error).includes("AlreadyExists")) throw error;
		log("egress policy already present");
	});

	const client = await new ActorClient().connect();
	log("bridge reachable through the router");

	const first = await client.prompt("req-1", "say hello");
	check("first turn streams a reply", first.text.includes("Hello from the mock model"), first.text);
	const firstTurn = Number(first.text.match(/\[turn (\d+)\]/)?.[1] ?? 0);
	log(`first reply is turn ${firstTurn}`);

	const write = await client.prompt(
		"req-2",
		"Run exactly this bash command and then reply with the word done: printf 'pi-e2e-marker' > /workspace/e2e.txt",
	);
	check("actor ran the write tool", toolSucceeded(client, "printf"));

	client.close();
	log("suspending actor through the control plane");
	await ate("suspend", "actor", actor, "-a", atespace);
	const suspended = await waitForState((state) => state === "ACTOR_STATE_SUSPENDED", 120_000, "SUSPENDED");
	check("actor reaches SUSPENDED", suspended === "ACTOR_STATE_SUSPENDED", suspended);

	log("prompting again; the router should resume the actor");
	const resumed = await new ActorClient().connect();
	const second = await resumed.prompt(
		"req-3",
		"Run exactly this bash command and then reply with the word done: cat /workspace/e2e.txt",
	);
	check("file survived suspend inside the sandbox", toolOutputContains(resumed, "pi-e2e-marker"));
	check("router resumed the actor for the next prompt", (await actorState()) === "ACTOR_STATE_RUNNING");
	const secondTurn = Number(second.text.match(/\[turn (\d+)\]/)?.[1] ?? 0);
	check("second turn continues the session", secondTurn > firstTurn, `${firstTurn} -> ${secondTurn}`);
	check("second turn replies after resume", second.text.includes("Hello from the mock model"), second.text);
	resumed.close();

	const sessionHash = createHash("sha256").update(second.text).digest("hex").slice(0, 12);
	log(`second reply digest ${sessionHash}`);

	const failed = checks.filter((entry) => !entry.ok);
	log(`${checks.length - failed.length}/${checks.length} checks passed`);
	if (failed.length > 0) process.exit(1);
}

main().catch((error) => {
	console.error(`[e2e] ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
	process.exit(1);
});
