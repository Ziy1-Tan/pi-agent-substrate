import { readFileSync } from "node:fs";
import WebSocket from "ws";

import type { ActorTransport } from "./backend.js";

/** Longest a connect may stay pending; also the stale-connection window. */
const CONNECT_TIMEOUT_MS = 10_000;
/** No traffic for this long means the connection may outlive its actor. */
const STALE_AFTER_MS = 5_000;

export interface WebSocketTlsOptions {
	/** Path to the CA bundle that verifies the router's serving certificate. */
	ca?: string;
	/** Path to the client certificate chain for the router's ingress allowlist. */
	cert?: string;
	/** Path to the private key. It may name the same combined bundle as `cert`. */
	key?: string;
}

interface ResolvedTls {
	ca?: string;
	cert?: string;
	key?: string;
}

export interface WebSocketTransportOptions {
	url: string;
	/** Sent on the upgrade request; selects the actor when behind atenet. */
	targetActor?: string;
	/** Set for wss; the router requires a podidentity client certificate. */
	tls?: WebSocketTlsOptions;
	log?: (message: string) => void;
}

/**
 * ActorTransport over the bridge's WebSocket. A turn connects, sends its
 * prompt, and reads the reply; the bridge keeps no per-client state.
 */
export class WebSocketTransport implements ActorTransport {
	private readonly options: WebSocketTransportOptions;
	private readonly recordListeners: Array<(record: Record<string, unknown>) => void> = [];
	private readonly closeListeners: Array<() => void> = [];
	private socket: WebSocket | undefined;
	private connecting: Promise<void> | undefined;
	private lastActivity = 0;

	constructor(options: WebSocketTransportOptions) {
		this.options = options;
	}

	get connected(): boolean {
		return this.socket?.readyState === WebSocket.OPEN;
	}

	onRecord(listener: (record: Record<string, unknown>) => void): void {
		this.recordListeners.push(listener);
	}

	/** Reports a dropped connection; the owner decides whether to reconnect. */
	onClose(listener: () => void): void {
		this.closeListeners.push(listener);
	}

	connect(): Promise<void> {
		// A socket can stay OPEN after the actor behind it went away, and a write
		// then succeeds locally without ever being delivered. Reconnect unless
		// the current connection has carried traffic recently.
		const looksAlive = this.connected && Date.now() - this.lastActivity < STALE_AFTER_MS;
		if (looksAlive) return Promise.resolve();
		if (this.connecting) return this.connecting;
		const stale = this.socket;
		this.socket = undefined;
		stale?.terminate();
		const pending = withTimeout(openSocket(this.options), CONNECT_TIMEOUT_MS).then(
			(socket) => {
				this.socket = socket;
				this.lastActivity = Date.now();
				this.connecting = undefined;
				socket.on("message", (data: Buffer) => {
					this.lastActivity = Date.now();
					this.deliver(String(data));
				});
				socket.on("close", () => {
					// A socket replaced for being stale closes after its successor is
					// installed; it must not clear or reconnect the newer one.
					if (this.socket !== socket) return;
					this.socket = undefined;
					// No reconnect here. Connecting wakes a suspended actor, so
					// the next turn is what reopens the socket; an idle gateway
					// must be able to leave the actor asleep.
					for (const listener of this.closeListeners) listener();
				});
				socket.on("error", (error: Error) => {
					this.options.log?.(`transport error: ${error.message}`);
				});
			},
			(error: unknown) => {
				this.connecting = undefined;
				throw error;
			},
		);
		this.connecting = pending;
		return pending;
	}

	send(record: Record<string, unknown>): void {
		if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
			throw new Error("actor transport is not connected");
		}
		this.socket.send(JSON.stringify(record));
	}

	async close(): Promise<void> {
		const socket = this.socket;
		this.socket = undefined;
		if (!socket) return;
		await new Promise<void>((resolve) => {
			socket.once("close", () => resolve());
			socket.close();
		});
	}

	private deliver(line: string): void {
		const trimmed = line.trim();
		if (trimmed.length === 0) return;
		let record: unknown;
		try {
			record = JSON.parse(trimmed);
		} catch {
			this.options.log?.(`dropping non-JSON record: ${trimmed.slice(0, 120)}`);
			return;
		}
		if (typeof record !== "object" || record === null) return;
		for (const listener of this.recordListeners) listener(record as Record<string, unknown>);
	}

}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error(`connect timed out after ${timeoutMs}ms`)), timeoutMs);
		timer.unref?.();
		promise.then(
			(value) => {
				clearTimeout(timer);
				resolve(value);
			},
			(error: unknown) => {
				clearTimeout(timer);
				reject(error instanceof Error ? error : new Error(String(error)));
			},
		);
	});
}

function openSocket(options: WebSocketTransportOptions): Promise<WebSocket> {
	return new Promise((resolve, reject) => {
		const socket = new WebSocket(options.url, {
			headers: options.targetActor ? { "ate-target-actor": options.targetActor } : {},
			...(options.url.startsWith("wss:") ? loadTls(options.tls) : undefined),
		});
		socket.once("open", () => resolve(socket));
		socket.once("error", (error) => reject(error instanceof Error ? error : new Error(String(error))));
	});
}

const CERTIFICATE_BLOCK = /-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g;
const PRIVATE_KEY_BLOCK = /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g;

/**
 * The router's credential bundle stores the private key before the
 * certificate chain. Node rejects that file as `cert` ("no start line"), so
 * the chain is extracted. The files are read per connect because podCertificate
 * credentials rotate.
 */
function loadTls(tls: WebSocketTlsOptions | undefined): ResolvedTls | undefined {
	if (!tls) return undefined;
	const bundle = tls.cert ? readFileSync(tls.cert, "utf8") : undefined;
	const key = tls.key && tls.key !== tls.cert ? readFileSync(tls.key, "utf8") : bundle;
	return {
		ca: tls.ca ? readFileSync(tls.ca, "utf8") : undefined,
		cert: bundle?.match(CERTIFICATE_BLOCK)?.join("\n"),
		key: key?.match(PRIVATE_KEY_BLOCK)?.[0] ?? key,
	};
}
