import type { AgentBackend, AgentRequest, AgentResponse } from "../../src/gateway/backend.js";

export interface StubBackendOptions {
	prefix?: string;
	delayMs?: number;
}

/** Deterministic stand-in for the actor backend: answers with the prompt. */
export class StubBackend implements AgentBackend {
	private readonly prefix: string;
	private readonly delayMs: number;

	readonly executedRequestIds: string[] = [];

	constructor(options: StubBackendOptions = {}) {
		this.prefix = options.prefix ?? "Reply: ";
		this.delayMs = options.delayMs ?? 0;
	}

	async submit(request: AgentRequest): Promise<AgentResponse> {
		this.executedRequestIds.push(request.requestId);
		if (this.delayMs > 0) await new Promise((resolve) => setTimeout(resolve, this.delayMs));
		return { text: `${this.prefix}${request.prompt}` };
	}
}
