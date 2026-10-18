import type { AgentBackend, AgentEventListener, AgentRequest, AgentResponse } from "../gateway/types.js";

export interface EchoBackendOptions {
	prefix?: string;
	chunkSize?: number;
	delayMs?: number;
}

/**
 * Deterministic stand-in for pi. It parses the caller's text out of the
 * transcript prompt, streams the reply in chunks, and remembers completed
 * request ids so a retried turn is never executed twice.
 */
export class EchoBackend implements AgentBackend {
	private readonly prefix: string;
	private readonly chunkSize: number;
	private readonly delayMs: number;
	private readonly results = new Map<string, Promise<AgentResponse>>();

	readonly executedRequestIds: string[] = [];

	constructor(options: EchoBackendOptions = {}) {
		this.prefix = options.prefix ?? "Echo: ";
		this.chunkSize = Math.max(1, options.chunkSize ?? 4);
		this.delayMs = options.delayMs ?? 1;
	}

	submit(request: AgentRequest, onDelta: AgentEventListener): Promise<AgentResponse> {
		const cached = this.results.get(request.requestId);
		if (cached) {
			// Replay the settled text to the new subscriber without re-executing.
			return cached.then((response) => {
				onDelta(response.text);
				return response;
			});
		}
		const result = this.execute(request, onDelta);
		this.results.set(request.requestId, result);
		return result;
	}

	/** Waits for every in-flight turn, including ones abandoned by a crash. */
	async settle(): Promise<void> {
		await Promise.allSettled([...this.results.values()]);
	}

	private async execute(request: AgentRequest, onDelta: AgentEventListener): Promise<AgentResponse> {
		this.executedRequestIds.push(request.requestId);
		const text = `${this.prefix}${lastMessageText(request.prompt)}`;
		let offset = 0;
		while (offset < text.length) {
			const chunk = text.slice(offset, offset + this.chunkSize);
			onDelta(chunk);
			offset += this.chunkSize;
			if (this.delayMs > 0) await delay(this.delayMs);
		}
		return { text };
	}
}

export function lastMessageText(prompt: string): string {
	const lines = prompt
		.split("\n")
		.map((line) => line.trimEnd())
		.filter((line) => line.length > 0);
	const last = lines.at(-1) ?? "";
	const match = last.match(/^-\s+\[[^\]]*\]\s+\[uid:[^\]]*\]\s+[^:]*:\s?([\s\S]*)$/);
	return match?.[1] ?? last;
}

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
