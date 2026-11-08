export interface AgentRequest {
	requestId: string;
	prompt: string;
}

export interface AgentResponse {
	text: string;
	/** Set when the turn failed, so the caller gets an error instead of silence. */
	error?: string;
}

export interface AgentBackend {
	submit(request: AgentRequest): Promise<AgentResponse>;
	close?(): Promise<void>;
}

/** The transport the gateway needs to reach one conversation's actor. */
export interface ActorTransport {
	/** Opens a connection, or reuses the live one. */
	connect(): Promise<void>;
	/** Sends one JSON record. */
	send(record: Record<string, unknown>): void;
	onRecord(listener: (record: Record<string, unknown>) => void): void;
	/** Receives connection loss. Called at most once per connection. */
	onClose(listener: () => void): void;
	close(): Promise<void>;
}

export interface PiBackendOptions {
	transport: ActorTransport;
	/** Time a turn may take before the backend gives up waiting. */
	turnTimeoutMs?: number;
}

interface ActiveTurn {
	requestId: string;
	/** Text seen in streamed deltas, used only if `bridge_result` is missing. */
	text: string;
	resolve: (response: AgentResponse) => void;
	reject: (error: Error) => void;
	timer: NodeJS.Timeout | undefined;
}

function turnOutcome(record: Record<string, unknown>): AgentResponse {
	const text = typeof record.text === "string" ? record.text : "";
	const error = typeof record.error === "string" ? record.error : undefined;
	return error === undefined ? { text } : { text, error };
}

/**
 * AgentBackend over an actor that speaks Pi RPC plus the bridge's
 * `bridge_result` record.
 *
 * One turn is one connect-and-prompt. The gateway runs one turn per
 * conversation at a time, and a connection that drops mid-turn fails that
 * turn: the caller can simply ask again.
 */
export class PiBackend implements AgentBackend {
	private readonly transport: ActorTransport;
	private readonly turnTimeoutMs: number;
	private active: ActiveTurn | undefined;

	constructor(options: PiBackendOptions) {
		this.transport = options.transport;
		this.turnTimeoutMs = options.turnTimeoutMs ?? 10 * 60_000;
		this.transport.onRecord((record) => this.handleRecord(record));
		this.transport.onClose(() => this.failActive(new Error("actor connection closed during the turn")));
	}

	async submit(request: AgentRequest): Promise<AgentResponse> {
		if (this.active) throw new Error(`turn ${this.active.requestId} is still running`);

		const turn: ActiveTurn = {
			requestId: request.requestId,
			text: "",
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
			this.failActive(new Error(`turn ${request.requestId} did not settle in ${this.turnTimeoutMs}ms`));
		}, this.turnTimeoutMs);
		turn.timer.unref?.();

		try {
			await this.transport.connect();
			this.transport.send({ id: request.requestId, type: "prompt", message: request.prompt });
		} catch (error) {
			this.failActive(error instanceof Error ? error : new Error(String(error)));
		}
		return result;
	}

	async close(): Promise<void> {
		this.failActive(new Error("backend closed"));
		await this.transport.close();
	}

	private handleRecord(record: Record<string, unknown>): void {
		if (record.type === "message_update") {
			const event = record.assistantMessageEvent as { type?: string; delta?: string } | undefined;
			if (event?.type === "text_delta" && typeof event.delta === "string") {
				if (this.active) this.active.text += event.delta;
			}
			return;
		}
		if (record.type === "bridge_result") {
			const requestId = typeof record.requestId === "string" ? record.requestId : this.active?.requestId;
			if (requestId) this.settle(requestId, turnOutcome(record));
			return;
		}
		if (record.type === "agent_settled") {
			// The bridge sends `bridge_result` first. This fallback covers a
			// result record that did not survive, and an empty reply is then the
			// only thing left to report.
			const turn = this.active;
			if (!turn) return;
			this.settle(
				turn.requestId,
				turn.text.length === 0 ? { text: "", error: "the turn ended without a reply" } : { text: turn.text },
			);
			return;
		}
		if (record.type === "bridge_exit") {
			this.failActive(new Error("pi exited during the turn"));
		}
	}

	private settle(requestId: string, outcome: AgentResponse): void {
		const turn = this.active;
		if (!turn || turn.requestId !== requestId) return;
		if (turn.timer) clearTimeout(turn.timer);
		this.active = undefined;
		turn.resolve(outcome);
	}

	private failActive(error: Error): void {
		const turn = this.active;
		if (!turn) return;
		if (turn.timer) clearTimeout(turn.timer);
		this.active = undefined;
		turn.reject(error);
	}
}
