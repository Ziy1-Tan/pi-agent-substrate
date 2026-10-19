import type { Channel, OutboundDelivery } from "../../src/gateway/types.js";

export interface SentMessage {
	deliveryId: string;
	messageId: string;
	text: string;
	replyToMessageId?: string;
}

export interface TestChannelOptions {
	onSend?: (message: SentMessage) => void;
}

/**
 * In-memory channel standing in for Discord/Telegram. It is test-build only,
 * mirroring a real channel in the two ways restart recovery depends on:
 * deliveries are idempotent per deliveryId, and preview edits are visible.
 */
export class TestChannel implements Channel {
	readonly sent: SentMessage[] = [];
	/** Failures delivered through `sendError`, in order. */
	readonly errors: string[] = [];
	readonly previews: string[] = [];
	sendAttempts = 0;
	duplicateDeliveries = 0;
	previewClears = 0;

	private readonly messageIds = new Map<string, string>();
	private readonly onSend: ((message: SentMessage) => void) | undefined;
	private sequence = 0;

	constructor(options: TestChannelOptions = {}) {
		this.onSend = options.onSend;
		if (process.env.NODE_ENV !== "test") {
			throw new Error("TestChannel is only available in test builds (NODE_ENV=test)");
		}
	}

	async send(delivery: OutboundDelivery): Promise<string | undefined> {
		this.sendAttempts += 1;
		const existing = this.messageIds.get(delivery.deliveryId);
		if (existing) {
			this.duplicateDeliveries += 1;
			return existing;
		}
		const messageId = `test-out-${++this.sequence}`;
		this.messageIds.set(delivery.deliveryId, messageId);
		const message: SentMessage = {
			deliveryId: delivery.deliveryId,
			messageId,
			text: delivery.text,
			replyToMessageId: delivery.replyToMessageId,
		};
		this.sent.push(message);
		this.onSend?.(message);
		return messageId;
	}

	async syncPreview(text: string): Promise<void> {
		this.previews.push(text);
	}

	async sendError(delivery: OutboundDelivery): Promise<string | undefined> {
		this.errors.push(delivery.text);
		return undefined;
	}

	async clearPreview(): Promise<void> {
		this.previewClears += 1;
	}
}
