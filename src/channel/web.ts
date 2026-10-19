import type { AttachmentInput } from "../../third_party/pi-chat/types.js";
import type { Channel, OutboundDelivery } from "../gateway/types.js";
import { EventRing, type Sequenced } from "./events.js";
import { saveUploads, type UploadInput } from "./uploads.js";

export type { UploadInput };

export interface WebChannelEvent {
	conversationId: string;
	type: "preview" | "final" | "error" | "state" | "history";
	/** For `preview`: the whole reply so far, not an increment. */
	text?: string;
	requestId?: string;
	state?: string;
	records?: unknown[];
}

export interface WebChannelOptions {
	conversationId: string;
	/** Where uploads land before the runtime files them under `incoming/`. */
	filesDir: string;
}

/**
 * Channel over a browser WebSocket.
 *
 * The gateway calls `syncPreview` for each streamed update and `send` once per
 * turn. Both become sequenced events, so a client that reconnects with
 * `since=<seq>` gets exactly the frames it missed and nothing it already saw.
 * Uploads are written before the runtime sees them; the runtime then copies
 * them under the conversation's `incoming/` directory and the prompt names
 * them, which is the same path a Slack or Discord attachment takes.
 */
export class WebChannel implements Channel {
	readonly conversationId: string;
	readonly events = new EventRing<WebChannelEvent>(2_000);

	private readonly filesDir: string;
	private readonly listeners = new Set<(event: Sequenced<WebChannelEvent>) => void>();

	constructor(options: WebChannelOptions) {
		this.conversationId = options.conversationId;
		this.filesDir = options.filesDir;
	}

	/** Every connected browser receives the same sequenced event. */
	onEvent(listener: (event: Sequenced<WebChannelEvent>) => void): void {
		this.listeners.add(listener);
	}

	offEvent(listener: (event: Sequenced<WebChannelEvent>) => void): void {
		this.listeners.delete(listener);
	}

	async send(delivery: OutboundDelivery): Promise<string | undefined> {
		this.record({ type: "final", requestId: delivery.deliveryId, text: delivery.text });
		return undefined;
	}

	async sendError(delivery: OutboundDelivery): Promise<string | undefined> {
		this.recordError(delivery.text, delivery.deliveryId);
		return undefined;
	}

	async syncPreview(text: string): Promise<void> {
		// The gateway hands over the accumulated reply, which is also what a
		// reconnecting client needs: replaying snapshots in order reconstructs
		// the text without any delta bookkeeping.
		this.record({ type: "preview", text });
	}

	async clearPreview(): Promise<void> {
		// The final event supersedes the preview; a separate clear would only
		// add noise to the replay window.
	}

	/** Events after `since`, for a reconnecting client. */
	replay(since: number): Sequenced<WebChannelEvent>[] {
		return this.events.since(since);
	}

	/** True when `since` predates the retained window. */
	hasGap(since: number): boolean {
		return this.events.hasGap(since);
	}

	/** Newest sequence handed out; a client stores this as its resume point. */
	get lastSeq(): number {
		return this.events.lastSeq;
	}

	recordState(state: string): void {
		this.record({ type: "state", state });
	}

	recordError(error: string, requestId?: string): void {
		this.record({ type: "error", text: error, requestId });
	}

	recordHistory(records: unknown[]): void {
		this.record({ type: "history", records });
	}

	/** Writes base64 uploads under the conversation's files directory. */
	async saveUploads(messageId: string, uploads: UploadInput[] | undefined): Promise<AttachmentInput[]> {
		return saveUploads(this.filesDir, messageId, uploads);
	}

	private record(event: Omit<WebChannelEvent, "conversationId">): void {
		const sequenced = this.events.record({ conversationId: this.conversationId, ...event });
		for (const listener of this.listeners) listener(sequenced);
	}
}
