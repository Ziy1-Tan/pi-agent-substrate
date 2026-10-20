import type { AgentBackend, AgentEventListener, AgentRequest, AgentResponse } from "./types.js";

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
	onClose(listener: () => void): void;
	/** Receives every successful connect; the flag says whether it is a reconnect. */
	onConnect(listener: (isReconnect: boolean) => void): void;
	close(): Promise<void>;
	/** True while records can be sent. */
	readonly connected: boolean;
}

interface ActiveTurn {
	requestId: string;
	/** Connection generation the prompt was written on. */
	generation: number;
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
}

/** A bridge result or a recovered one, read into the shape a turn resolves with. */
function turnOutcome(record: Record<string, unknown>): AgentResponse {
	const text = typeof record.text === "string" ? record.text : "";
	const error = typeof record.error === "string" ? record.error : undefined;
	return error === undefined ? { text } : { text, error };
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

	/** Ids whose prompt reached the transport, so a reconnect never resends. */
	private readonly sent = new Set<string>();
	/** Bumped on every connect, so recovery can tell a stale write from a fresh one. */
	private generation = 0;

	private readonly settled = new Map<string, { response: AgentResponse; at: number }>();
	private active: ActiveTurn | undefined;
	private wired = false;

	constructor(options: PiBackendOptions) {
		this.transport = options.transport;
		this.turnTimeoutMs = options.turnTimeoutMs ?? 10 * 60_000;
		this.resultTtlMs = options.resultTtlMs ?? 24 * 60 * 60_000;
	}

	async connect(): Promise<void> {
		this.wire();
		await this.transport.connect();
	}

	/**
	 * Subscribes once. The gateway may open a conversation before its actor
	 * exists, so wiring cannot assume a successful connect has happened.
	 */
	private wire(): void {
		if (this.wired) return;
		this.wired = true;
		this.transport.onRecord((record) => this.handleRecord(record));
		this.transport.onConnect((isReconnect) => {
			this.generation += 1;
			if (isReconnect) this.recoverInFlight();
		});
		// A suspended actor answers a recovery request with its bridge's live
		// cache, which is empty after restore; a cached turn from before the
		// suspend would be invisible to the actor and wrong to serve. Forgetting
		// settled results on disconnect makes the next retry run the turn.
		this.transport.onClose(() => this.settled.clear());
	}

	submit(request: AgentRequest, onDelta: AgentEventListener): Promise<AgentResponse> {
		this.wire();
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
			generation: this.generation,
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
		}).then(() => {
			// Record which connection carried the prompt; a later reconnect that
			// changes generation is what makes recovery necessary.
			if (this.active === turn) turn.generation = this.generation;
		});
		return result;
	}

	async close(): Promise<void> {
		if (this.active) this.failTurn(this.active.requestId, new Error("backend closed"));
		await this.transport.close();
	}

	private async dispatch(command: Record<string, unknown>): Promise<void> {
		try {
			await this.transport.connect();
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
		if (record.type === "bridge_result") {
			const requestId = typeof record.requestId === "string" ? record.requestId : this.active?.requestId;
			if (requestId) this.settle(requestId, turnOutcome(record));
			return;
		}
		if (record.type === "bridge_result_reply") {
			// A recovery lookup, not a turn: only a found result settles it.
			const result = record.result as Record<string, unknown> | undefined;
			if (record.found === true && typeof result?.requestId === "string") {
				this.settle(result.requestId, turnOutcome(result));
			}
			return;
		}
		if (record.type === "agent_settled") {
			// The bridge pairs agent_settled with bridge_result, sent first. This
			// fallback covers a bridge whose result record did not survive, and
			// an empty reply is the only thing left to report.
			const turn = this.active;
			if (!turn) return;
			this.settle(
				turn.requestId,
				turn.text.length === 0 ? { text: "", error: "the turn ended without a reply" } : { text: turn.text },
			);
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
	 * A turn whose prompt has not been written yet is left alone: the send is
	 * still in flight and will use this connection.
	 */
	private recoverInFlight(): void {
		const turn = this.active;
		if (!turn || turn.generation >= this.generation) return;
		try {
			this.transport.send({ id: `recover-${turn.requestId}`, type: "bridge_result", requestId: turn.requestId });
		} catch {
			// The transport reports its own failures; the turn timer still bounds this.
		}
	}

	private settle(requestId: string, outcome: AgentResponse): void {
		const turn = this.active;
		if (!turn || turn.requestId !== requestId) return;
		if (turn.timer) clearTimeout(turn.timer);
		this.active = undefined;
		this.sent.delete(requestId);
		this.settled.set(requestId, { response: outcome, at: Date.now() });
		turn.resolve(outcome);
	}

	private failTurn(requestId: string, error: Error): void {
		const turn = this.active;
		if (!turn || turn.requestId !== requestId) return;
		if (turn.timer) clearTimeout(turn.timer);
		this.active = undefined;
		turn.reject(error);
	}
}
