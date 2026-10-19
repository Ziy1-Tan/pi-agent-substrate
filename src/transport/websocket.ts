import WebSocket from "ws";

import type { ActorTransport } from "../backend/pi.js";

/** Longest a connect may stay pending; also the stale-connection window. */
const CONNECT_TIMEOUT_MS = 10_000;
/** No traffic for this long means the connection may outlive its actor. */
const STALE_AFTER_MS = 5_000;

export interface WebSocketTransportOptions {
	url: string;
	/** Sent on the upgrade request; selects the actor when behind atenet. */
	targetActor?: string;
	log?: (message: string) => void;
}

/**
 * ActorTransport over the bridge's WebSocket. Every reconnect is a fresh
 * connection: the bridge keeps no per-client state, so the backend asks for
 * what it needs after connecting.
 */
export class WebSocketTransport implements ActorTransport {
	private readonly options: WebSocketTransportOptions;
	private readonly recordListeners: Array<(record: Record<string, unknown>) => void> = [];
	private readonly closeListeners: Array<() => void> = [];
	private readonly connectListeners: Array<(isReconnect: boolean) => void> = [];
	private socket: WebSocket | undefined;
	private connecting: Promise<void> | undefined;
	private everConnected = false;
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

	/** `isReconnect` is true for every connect after the first. */
	onConnect(listener: (isReconnect: boolean) => void): void {
		this.connectListeners.push(listener);
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
				const isReconnect = this.everConnected;
				this.everConnected = true;
				for (const listener of this.connectListeners) listener(isReconnect);
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
		});
		socket.once("open", () => resolve(socket));
		socket.once("error", (error) => reject(error instanceof Error ? error : new Error(String(error))));
	});
}
