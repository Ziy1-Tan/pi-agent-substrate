import { randomUUID } from "node:crypto";

import type { AgentBackend, AgentResponse } from "./types.js";

/** The slice of the idle lifecycle a turn needs. */
export interface TurnLifecycle {
	/** Creates the actor if absent and lets a resume finish before the prompt. */
	ready(): Promise<void>;
	turnStarted(): void;
	turnSettled(): void;
	readonly state: string;
}

export interface TurnReport {
	turnMillis: number;
	/** The actor was suspended when this turn arrived. */
	resumed: boolean;
}

export interface GatewayOptions {
	backend: AgentBackend;
	lifecycle?: TurnLifecycle;
	onTurn?: (report: TurnReport) => void;
}

/**
 * Runs one conversation's turns, one at a time. The reply goes back to the
 * HTTP caller that asked for it, so the gateway keeps no queue on disk: a
 * failed or interrupted turn is reported to that caller, and the next request
 * starts a fresh one.
 */
export class Gateway {
	private tail: Promise<unknown> = Promise.resolve();

	constructor(private readonly options: GatewayOptions) {}

	receive(prompt: string): Promise<AgentResponse> {
		const run = this.tail.then(() => this.runTurn(prompt));
		this.tail = run.catch(() => undefined);
		return run;
	}

	async stop(): Promise<void> {
		await this.tail.catch(() => undefined);
	}

	private async runTurn(prompt: string): Promise<AgentResponse> {
		const lifecycle = this.options.lifecycle;
		// Read before `ready()`: it may move SUSPENDED to IDLE while it checks
		// the control plane, which would erase the evidence of a resume.
		const resumed = lifecycle?.state === "SUSPENDED" || lifecycle?.state === "SUSPENDING";
		await lifecycle?.ready().catch(() => undefined);
		lifecycle?.turnStarted();
		const startedAt = Date.now();
		try {
			return await this.options.backend.submit({ requestId: randomUUID(), prompt });
		} finally {
			// A failed turn must settle too, or the lifecycle stays ACTIVE and
			// the actor is never suspended again.
			lifecycle?.turnSettled();
			this.options.onTurn?.({ turnMillis: Date.now() - startedAt, resumed });
		}
	}
}
