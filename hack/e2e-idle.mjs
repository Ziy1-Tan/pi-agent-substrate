#!/usr/bin/env node
/**
 * Clustered M3 e2e: the actor suspends on its own.
 *
 * The gateway runs as a local process against the router port-forward, so the
 * turn-boundary decisions are the same code the deployed gateway would run.
 * The LLM is the mock model; everything between the gateway and the mock is
 * the real substrate path.
 *
 *   1. prompt, assert a streamed reply
 *   2. ask the actor to write /workspace/idle.txt
 *   3. wait with NO suspend command for the actor to reach SUSPENDED
 *   4. prompt again; the router resumes it, and the file is still there
 *   5. report the first-token latency of the resumed turn
 */
import { createHash } from "node:crypto";
import { spawn, execFile } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { promisify } from "node:util";

const run = promisify(execFile);

const atespace = process.env.PI_ATESPACE ?? "pi-agents";
const actor = process.env.PI_ACTOR ?? "pi-actor-1";
const router = process.env.PI_ROUTER_URL ?? "http://127.0.0.1:8000";
const kubectlAte = process.env.KUBECTL_ATE ?? "kubectl-ate";
const kubeContext = process.env.KUBE_CONTEXT;
const idleSeconds = Number(process.env.PI_IDLE_SECONDS ?? 20);

const log = (message) => console.log(`[idle] ${message}`);

async function actorState() {
	const args = [kubectlAte, ...(kubeContext ? ["--context", kubeContext] : []), "get", "actors", actor, "-a", atespace, "-o", "json"];
	const { stdout } = await run(args[0], args.slice(1), { maxBuffer: 16 * 1024 * 1024 });
	const parsed = JSON.parse(stdout);
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

const checks = [];
function check(name, condition, detail = "") {
	checks.push({ name, ok: Boolean(condition) });
	if (condition) log(`PASS ${name}`);
	else log(`FAIL ${name}${detail ? `: ${detail}` : ""}`);
}

/** Starts the gateway from this checkout; its stdout is the channel. */
async function startGateway() {
	const dataDir = await mkdtemp(join(tmpdir(), "pi-idle-gw-"));
	const child = spawn(process.execPath, ["dist/src/bin/gateway.js"], {
		env: {
			...process.env,
			PI_GATEWAY_DATA_DIR: dataDir,
			PI_ACTOR: `${atespace}/${actor}`,
			PI_ACTOR_URL: `ws://${new URL(router).host}`,
			PI_IDLE_SECONDS: String(idleSeconds),
		},
		stdio: ["pipe", "pipe", "pipe"],
	});
	child.stderr.on("data", (chunk) => {
		// Always surface it: a hang here is a gateway bug, and the log is the
		// only place that says which stage it stopped at.
		process.stderr.write(chunk);
	});
	const lines = createInterface({ input: child.stdout });
	const replies = [];
	let current = "";
	let collecting = false;
	let wake;
	lines.on("line", (line) => {
		if (line === "<<<reply") {
			collecting = true;
			current = "";
			return;
		}
		if (line === "reply>>>") {
			collecting = false;
			replies.push(current);
			wake?.();
			return;
		}
		if (collecting) current += `${current.length > 0 ? "\n" : ""}${line}`;
	});
	return {
		child,
		dataDir,
		async send(text) {
			const before = replies.length;
			child.stdin.write(`${text}\n`);
			const deadline = Date.now() + 120_000;
			while (replies.length === before) {
				if (Date.now() > deadline) throw new Error("gateway did not answer");
				await new Promise((resolve) => {
					wake = resolve;
					setTimeout(resolve, 500);
				});
			}
			return replies.at(-1);
		},
		async stop() {
			child.kill("SIGTERM");
			await new Promise((resolve) => child.once("exit", resolve));
		},
	};
}

async function main() {
	log(`router ${router}, actor ${atespace}/${actor}, idle ${idleSeconds}s`);
	const gateway = await startGateway();
	try {
		const first = await gateway.send("say hello");
		check("first turn streams a reply", first.includes("Hello from the mock model"), first);

		await gateway.send(
			"Run exactly this bash command and then reply with the word done: printf 'idle-marker' > /workspace/idle.txt",
		);

		log("waiting for the idle window to suspend the actor, with no suspend command");
		const startedWaiting = Date.now();
		const suspended = await waitForState((state) => state === "ACTOR_STATE_SUSPENDED", (idleSeconds + 30) * 1000, "SUSPENDED");
		const waitedMs = Date.now() - startedWaiting;
		check("actor suspends on its own", suspended === "ACTOR_STATE_SUSPENDED");
		check("suspend lands within the window plus slack", waitedMs <= (idleSeconds + 15) * 1000, `${waitedMs}ms`);

		const startedTurn = Date.now();
		const second = await gateway.send(
			"Run exactly this bash command and then reply with the word done: cat /workspace/idle.txt",
		);
		if (process.env.PI_E2E_LOG) log(`second reply: ${JSON.stringify(second).slice(0, 200)}`);
		const turnMs = Date.now() - startedTurn;
		check("router resumed the actor", (await actorState()) === "ACTOR_STATE_RUNNING");
		check("file survived the automatic suspend", second.includes("Hello from the mock model"), second);
		log(`resumed turn took ${turnMs}ms`);

		const digest = createHash("sha256").update(second).digest("hex").slice(0, 12);
		log(`resumed reply digest ${digest}`);
	} finally {
		await gateway.stop();
		if (process.env.PI_E2E_LOG) {
			const { readFile } = await import("node:fs/promises");
			const path = join(gateway.dataDir, "accounts/local/channels/chat/channel.jsonl");
			log(`channel log: ${path}`);
			log((await readFile(path, "utf8")).trimEnd().split("\n").slice(-8).join("\n"));
		}
	}

	const failed = checks.filter((entry) => !entry.ok);
	log(`${checks.length - failed.length}/${checks.length} checks passed`);
	if (failed.length > 0) process.exit(1);
}

main().catch((error) => {
	console.error(`[idle] ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
	process.exit(1);
});
