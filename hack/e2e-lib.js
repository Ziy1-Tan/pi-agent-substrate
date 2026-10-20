#!/usr/bin/env node
/**
 * Shared helpers for the clustered e2e scripts. Both drive `kubectl-ate` and
 * the same small WorkerPool, so cleanup and actor inspection are identical.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

/** A `kubectl-ate` invocation bound to one atespace and kubectl context. */
export function ateClient() {
	const atespace = process.env.PI_ATESPACE ?? "pi-agents";
	const kubectlAte = process.env.KUBECTL_ATE ?? "kubectl-ate";
	const kubeContext = process.env.KUBE_CONTEXT;
	const ate = async (...args) => {
		const command = [kubectlAte, ...(kubeContext ? ["--context", kubeContext] : []), ...args];
		const { stdout } = await run(command[0], command.slice(1), { maxBuffer: 16 * 1024 * 1024 });
		return stdout;
	};
	return { atespace, ate };
}

/** `local/chat` -> `pi-local-chat`; mirrors `actorNameFor` in the gateway. */
export function actorNameFor(conversationId, prefix = "pi-") {
	const sanitized = conversationId
		.toLowerCase()
		.replace(/[^a-z0-9-]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 40);
	return `${prefix}${sanitized || "conversation"}`;
}

/** Actor state, or undefined when the actor does not exist. */
export async function actorState(client, name) {
	try {
		const parsed = JSON.parse(await client.ate("get", "actors", name, "-a", client.atespace, "-o", "json"));
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
export async function removeActor(client, name, log) {
	if ((await actorState(client, name)) === undefined) return;
	try {
		await client.ate("delete", "actor", name, "-a", client.atespace, "--any-state");
		log(`removed actor ${name}`);
	} catch (error) {
		log(`could not remove actor ${name}: ${error instanceof Error ? error.message : String(error)}`);
	}
}

export async function waitFor(getter, predicate, timeoutMs, label, intervalMs = 500) {
	const deadline = Date.now() + timeoutMs;
	let last;
	while (Date.now() < deadline) {
		last = await getter();
		if (predicate(last)) return last;
		await new Promise((resolve) => setTimeout(resolve, intervalMs));
	}
	throw new Error(`timed out waiting for ${label}: ${JSON.stringify(last)}`);
}

/** Collects named checks so a run reports every failure, not just the first. */
export function createChecks(log) {
	const checks = [];
	const check = (name, condition, detail = "") => {
		checks.push({ name, ok: Boolean(condition) });
		if (condition) log(`PASS ${name}`);
		else log(`FAIL ${name}${detail ? `: ${detail}` : ""}`);
	};
	return { check, checks };
}
