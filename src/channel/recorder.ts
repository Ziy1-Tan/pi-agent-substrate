import type { Channel, OutboundDelivery } from "../gateway/types.js";

export interface TurnOutcome {
	text?: string;
	error?: string;
}

/**
 * The outbound a conversation with no chat adapter delivers into. `POST
 * /messages` reads `outcome` once the turn has settled and returns it as the
 * response body, so this is the whole of the HTTP entry point's channel.
 *
 * Previews are dropped: no surface left holds a partially streamed reply open.
 * Telegram is unaffected, because its own adapter replaces this one.
 */
export class TurnRecorder implements Channel {
	readonly outcome: TurnOutcome = {};

	/** Clears the previous turn before a new one is dispatched. */
	begin(): void {
		this.outcome.text = undefined;
		this.outcome.error = undefined;
	}

	async send(delivery: OutboundDelivery): Promise<string | undefined> {
		this.outcome.text = delivery.text;
		return undefined;
	}

	async sendError(delivery: OutboundDelivery): Promise<string | undefined> {
		this.outcome.error = delivery.text;
		return undefined;
	}

	async syncPreview(): Promise<void> {}

	async clearPreview(): Promise<void> {}
}
