import { spawn, type ChildProcess } from "node:child_process";

import type { ActorRef } from "./control.js";

type ProxyProcess = ChildProcess & { stderr: NodeJS.ReadableStream };

/** How long to wait for `kubectl-ate proxy actor` to print its local address. */
const LISTEN_TIMEOUT_MS = 15_000;
/** How long a SIGTERM gets before the child is killed. */
const STOP_TIMEOUT_MS = 5_000;

export interface ActorTunnelOptions {
	/** Binary name or path, usually `kubectl-ate`. */
	binary: string;
	/** `--context` passed to every call. */
	context?: string;
	/** Port inside the actor; the bridge listens on 80 in the actor image. */
	remotePort?: number;
	log?: (message: string) => void;
}

export interface ActorTunnel {
	readonly url: string;
	close(): Promise<void>;
}

/**
 * The proxy owns the CONNECT tunnel to atenet-router, which resumes a
 * suspended actor when the tunnel is opened.
 */
async function startActorTunnel(actor: ActorRef, options: ActorTunnelOptions): Promise<ActorTunnel> {
	const args = [
		...(options.context ? ["--context", options.context] : []),
		"proxy",
		"actor",
		actor.name,
		"-a",
		actor.atespace,
		`0:${options.remotePort ?? 80}`,
	];
	const child = spawn(options.binary, args, { stdio: ["ignore", "ignore", "pipe"] }) as ProxyProcess;
	const url = await waitForAddress(child, `${options.binary} proxy actor ${actor.atespace}/${actor.name}`);
	options.log?.(`tunnel ${actor.atespace}/${actor.name} -> ${url}`);
	return {
		url,
		close: () => stopChild(child),
	};
}

/**
 * Addresses are logged by the proxy as
 * `Proxying 127.0.0.1:12345 -> <atespace>/<actor>:80`.
 */
function parseProxyAddress(line: string): string | undefined {
	const match = /Proxying\s+(\S+)\s+->/.exec(line);
	return match?.[1];
}

/**
 * Owns one tunnel per actor, shared by every turn on that conversation.
 * A failed start is forgotten so the next connect retries.
 */
export class ActorTunnels {
	private readonly tunnels = new Map<string, Promise<ActorTunnel>>();

	constructor(private readonly options: ActorTunnelOptions) {}

	async urlFor(actor: ActorRef): Promise<string> {
		const key = `${actor.atespace}/${actor.name}`;
		let tunnel = this.tunnels.get(key);
		if (!tunnel) {
			tunnel = startActorTunnel(actor, this.options);
			this.tunnels.set(key, tunnel);
			void tunnel.catch(() => {
				if (this.tunnels.get(key) === tunnel) this.tunnels.delete(key);
			});
		}
		return (await tunnel).url;
	}

	async close(): Promise<void> {
		const pending = [...this.tunnels.values()];
		this.tunnels.clear();
		await Promise.all(
			pending.map(async (tunnel) => {
				const started = await tunnel.catch(() => undefined);
				await started?.close();
			}),
		);
	}
}

function waitForAddress(child: ProxyProcess, description: string): Promise<string> {
	return new Promise((resolve, reject) => {
		let settled = false;
		let stderr = "";
		const finish = (error: Error | undefined, address?: string) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			if (error) reject(error);
			else resolve(`ws://${address}`);
		};
		const timer = setTimeout(() => {
			finish(new Error(`${description} did not listen within ${LISTEN_TIMEOUT_MS}ms: ${stderr.trim()}`));
		}, LISTEN_TIMEOUT_MS);
		timer.unref?.();

		child.stderr.on("data", (chunk: Buffer) => {
			if (settled) return;
			stderr = `${stderr}${chunk.toString()}`.slice(-4096);
			const address = parseProxyAddress(stderr);
			if (address) finish(undefined, address);
		});
		child.once("error", (error: Error) => finish(error));
		child.once("exit", (code, signal) => {
			finish(new Error(`${description} exited (${signal ?? code}): ${stderr.trim()}`));
		});
	});
}

async function stopChild(child: ProxyProcess): Promise<void> {
	if (child.exitCode !== null || child.signalCode !== null) return;
	const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
	child.kill("SIGTERM");
	const timeout = new Promise<void>((resolve) => {
		const timer = setTimeout(resolve, STOP_TIMEOUT_MS);
		timer.unref?.();
	});
	await Promise.race([exited, timeout]);
	if (child.exitCode === null && child.signalCode === null) {
		child.kill("SIGKILL");
		await exited;
	}
}
