import WebSocket from "ws";

import type { ActorTransport } from "../backend/pi.js";

export interface WebSocketTransportOptions {
	url: string;
	/** Sent on the upgrade request; selects the actor when behind atenet. */
	targetActor?: string;
	headers?: Record<string, string>;
	/** Reconnect automatically when the socket closes. Defaults to true. */
	autoReconnect?: boolean;
	reconnectDelayMs?: number;
	/** How long a connect may stay pending before it fails. */
	connectTimeoutMs?: number;
	/**
	 * A connection with no traffic for this long is replaced before its next
	 * write. A suspend tears the actor down without a FIN reaching us, so the
	 * local socket can look open while every write is silently lost.
	 */
	staleAfterMs?: number;
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
	private readonly closeListeners: Array<(error?: Error) => void> = [];
	private readonly connectListeners: Array<(isReconnect: boolean) => void> = [];
	private socket: WebSocket | undefined;
	private connecting: Promise<void> | undefined;
	private closed = false;
	private everConnected = false;
	private lastActivity = 0;
	private retryTimer: NodeJS.Timeout | undefined;

	constructor(options: WebSocketTransportOptions) {
		this.options = options;
	}

	get connected(): boolean {
		return this.socket?.readyState === WebSocket.OPEN;
	}

	onRecord(listener: (record: Record<string, unknown>) => void): void {
		this.recordListeners.push(listener);
	}

	onClose(listener: (error?: Error) => void): void {
		this.closeListeners.push(listener);
	}

	/** `isReconnect` is true for every connect after the first. */
	onConnect(listener: (isReconnect: boolean) => void): void {
		this.connectListeners.push(listener);
	}

	connect(): Promise<void> {
		const staleAfterMs = this.options.staleAfterMs ?? 5_000;
		const looksAlive = this.connected && Date.now() - this.lastActivity < staleAfterMs;
		if (looksAlive) return Promise.resolve();
		if (this.connecting) return this.connecting;
		this.closed = false;
		// A socket can stay OPEN after the peer or the port-forward behind it
		// went away; the write then succeeds locally and is never delivered.
		// Replacing it on every connect attempt is what makes a resume work.
		const stale = this.socket;
		this.socket = undefined;
		stale?.terminate();
		const pending = withTimeout(
			openSocket(this.options),
			this.options.connectTimeoutMs ?? 10_000,
		).then(
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
					for (const listener of this.closeListeners) listener();
					this.scheduleReconnect();
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
		this.closed = true;
		if (this.retryTimer) clearTimeout(this.retryTimer);
		this.retryTimer = undefined;
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

	private scheduleReconnect(): void {
		if (this.closed || this.options.autoReconnect === false) return;
		if (this.retryTimer) return;
		this.retryTimer = setTimeout(() => {
			this.retryTimer = undefined;
			void this.connect().catch((error: unknown) => {
				this.options.log?.(`reconnect failed: ${error instanceof Error ? error.message : String(error)}`);
				this.scheduleReconnect();
			});
		}, this.options.reconnectDelayMs ?? 250);
		this.retryTimer.unref?.();
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
			headers: {
				...(options.targetActor ? { "ate-target-actor": options.targetActor } : {}),
				...options.headers,
			},
		});
		socket.once("open", () => resolve(socket));
		socket.once("error", (error) => reject(error instanceof Error ? error : new Error(String(error))));
	});
}
