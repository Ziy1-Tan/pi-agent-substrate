import type { AgentBackend, AgentEventListener, AgentRequest, AgentResponse } from "../gateway/types.js";

/**
 * The transport the gateway needs to reach one conversation's actor. The
 * gateway owns retry and idempotency; transports only carry records.
 */
export interface ActorTransport {
	/** Opens a connection, or reuses the live one. */
	connect(): Promise<void>;
	/** Sends one JSON record. Implementations must not buffer unbounded. */
	send(record: Record<string, unknown>): void;
	/** Receives every record from the actor. */
	onRecord(listener: (record: Record<string, unknown>) => void): void;
	/** Receives connection loss. Called at most once per connection. */
	onClose(listener: (error?: Error) => void): void;
	/** Receives every successful (re)connect, before any record arrives. */
	onConnect(listener: () => void): void;
	close(): Promise<void>;
	/** True while records can be sent. */
	readonly connected: boolean;
}

export type { AgentEventListener, AgentRequest, AgentResponse };

interface ActiveTurn {
	requestId: string;
	text: string;
	deltaSinks: Set<AgentEventListener>;
	resolve: (response: AgentResponse) => void;
	reject: (error: Error) => void;
	timer: NodeJS.Timeout | undefined;
}

export interface PiBackendOptions {
	transport: ActorTransport;
	/**
	 * Time a turn may take before the backend gives up waiting. Pi keeps the
	 * turn alive inside the actor; the result is still cached there.
	 */
	turnTimeoutMs?: number;
	/** How long a settled turn stays available for a retried request id. */
	resultTtlMs?: number;
	/** Called before a turn is written to a transport that is not connected. */
	onReconnect?: () => Promise<void>;
}

/**
 * AgentBackend over an actor that speaks Pi RPC plus the bridge extensions.
 *
 * Idempotency lives here, not in the actor: a request id that already settled
 * is answered from the cache, so a gateway restart after `agent_settled` never
 * runs the turn twice. The gateway runs one turn per conversation at a time, so
 * at most one request is in flight.
 *
 * A dropped connection does not fail the turn: the actor keeps working and the
 * bridge holds the result. The transport reconnects, and `onConnect` asks the
 * bridge for that result instead of resending the prompt.
 */
export class PiBackend implements AgentBackend {
	private readonly transport: ActorTransport;
	private readonly turnTimeoutMs: number;
	private readonly resultTtlMs: number;
	private readonly onReconnect: (() => Promise<void>) | undefined;
	/** Ids whose prompt reached the transport, so a reconnect never resends. */
	private readonly sent = new Set<string>();

	private readonly settled = new Map<string, { response: AgentResponse; at: number }>();
	private active: ActiveTurn | undefined;
	private wired = false;

	constructor(options: PiBackendOptions) {
		this.transport = options.transport;
		this.turnTimeoutMs = options.turnTimeoutMs ?? 10 * 60_000;
		this.resultTtlMs = options.resultTtlMs ?? 24 * 60 * 60_000;
		this.onReconnect = options.onReconnect;
	}

	async connect(): Promise<void> {
		if (!this.wired) {
			this.wired = true;
			this.transport.onRecord((record) => this.handleRecord(record));
			this.transport.onConnect(() => this.recoverInFlight());
		}
		await this.transport.connect();
	}

	submit(request: AgentRequest, onDelta: AgentEventListener): Promise<AgentResponse> {
		const cached = this.cached(request.requestId);
		if (cached) {
			onDelta(cached.text);
			return Promise.resolve(cached);
		}

		if (this.active?.requestId === request.requestId) {
			if (this.active.text.length > 0) onDelta(this.active.text);
			this.active.deltaSinks.add(onDelta);
			return new Promise<AgentResponse>((resolve, reject) => {
				const previous = this.active;
				if (!previous) return reject(new Error("turn settled while joining"));
				const originalResolve = previous.resolve;
				const originalReject = previous.reject;
				previous.resolve = (response) => {
					originalResolve(response);
					resolve(response);
				};
				previous.reject = (error) => {
					originalReject(error);
					reject(error);
				};
			});
		}

		if (this.active) {
			return Promise.reject(new Error(`turn ${this.active.requestId} is still running`));
		}

		const turn: ActiveTurn = {
			requestId: request.requestId,
			text: "",
			deltaSinks: new Set([onDelta]),
			resolve: () => undefined,
			reject: () => undefined,
			timer: undefined,
		};
		const result = new Promise<AgentResponse>((resolve, reject) => {
			turn.resolve = resolve;
			turn.reject = reject;
		});
		this.active = turn;
		turn.timer = setTimeout(() => {
			this.failTurn(turn.requestId, new Error(`turn ${request.requestId} did not settle in ${this.turnTimeoutMs}ms`));
		}, this.turnTimeoutMs);
		turn.timer.unref?.();
		if (this.sent.has(request.requestId)) {
			// The turn was already accepted before the connection dropped. Pi is
			// still running it; wait for bridge_result rather than sending twice.
			return result;
		}
		this.sent.add(request.requestId);

		void this.dispatch({
			id: request.requestId,
			requestId: request.requestId,
			type: "prompt",
			message: request.prompt,
		});
		return result;
	}

	async close(): Promise<void> {
		if (this.active) this.failTurn(this.active.requestId, new Error("backend closed"));
		await this.transport.close();
	}

	private async dispatch(command: Record<string, unknown>): Promise<void> {
		try {
			if (!this.transport.connected && this.onReconnect) await this.onReconnect();
			if (!this.transport.connected) await this.transport.connect();
			this.transport.send(command);
		} catch (error) {
			const turn = this.active;
			if (turn && turn.requestId === String(command.requestId)) {
				this.failTurn(turn.requestId, error instanceof Error ? error : new Error(String(error)));
			}
		}
	}

	private cached(requestId: string): AgentResponse | undefined {
		const entry = this.settled.get(requestId);
		if (!entry) return undefined;
		if (Date.now() - entry.at > this.resultTtlMs) {
			this.settled.delete(requestId);
			return undefined;
		}
		return entry.response;
	}

	private handleRecord(record: Record<string, unknown>): void {
		if (record.type === "message_update") {
			const event = record.assistantMessageEvent as { type?: string; delta?: string } | undefined;
			if (event?.type !== "text_delta" || typeof event.delta !== "string") return;
			const turn = this.active;
			if (!turn) return;
			turn.text += event.delta;
			for (const sink of turn.deltaSinks) sink(event.delta);
			return;
		}
		if (record.type === "bridge_result" || record.type === "bridge_result_reply") {
			const requestId = typeof record.requestId === "string" ? record.requestId : this.active?.requestId;
			if (requestId) this.settle(requestId, typeof record.text === "string" ? record.text : "");
			return;
		}
		if (record.type === "agent_settled") {
			// The bridge pairs agent_settled with bridge_result; the fallback
			// covers a bridge whose result record did not survive.
			const turn = this.active;
			if (turn) this.settle(turn.requestId, turn.text);
			return;
		}
		if (record.type === "bridge_exit") {
			const turn = this.active;
			if (turn) this.failTurn(turn.requestId, new Error("pi exited during turn"));
		}
	}

	/**
	 * After a reconnect the bridge may have settled the active turn while the
	 * socket was down. Ask it for that result instead of resending the prompt.
	 */
	private recoverInFlight(): void {
		const turn = this.active;
		if (!turn || !this.sent.has(turn.requestId)) return;
		try {
			this.transport.send({ id: `recover-${turn.requestId}`, type: "bridge_result", requestId: turn.requestId });
		} catch {
			// The transport reports its own failures; the turn timer still bounds this.
		}
	}

	private settle(requestId: string, text: string): void {
		const turn = this.active;
		if (!turn || turn.requestId !== requestId) return;
		if (turn.timer) clearTimeout(turn.timer);
		this.active = undefined;
		this.sent.delete(requestId);
		const response: AgentResponse = { text };
		this.settled.set(requestId, { response, at: Date.now() });
		turn.resolve(response);
	}

	private failTurn(requestId: string, error: Error): void {
		const turn = this.active;
		if (!turn || turn.requestId !== requestId) return;
		if (turn.timer) clearTimeout(turn.timer);
		this.active = undefined;
		turn.reject(error);
	}

}
