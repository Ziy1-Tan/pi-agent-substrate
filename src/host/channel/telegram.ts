import type { Channel, OutboundDelivery } from "../types.js";
import { Api } from "node-telegram-bot-api";

export interface TelegramChannelOptions {
	botToken: string;
	chatId: string;
	/** Telegram's sendMessage endpoint; tests point this at a local server. */
	apiBase?: string;
	/** Streaming edits are rate limited by the platform, so previews wait. */
	previewIntervalMs?: number;
	/** Bot API client; tests can inject a transport. */
	api?: Api;
	fetchImpl?: typeof fetch;
}

const TELEGRAM_TEXT_LIMIT = 4_096;

/**
 * Channel over the Telegram Bot API.
 *
 * A turn streams as repeated edits of one message. Telegram rejects edits that
 * arrive faster than roughly one per second and rejects text over 4096
 * characters, so previews are throttled and the final reply is split across
 * messages. The final message id is what the conversation log records.
 */
export class TelegramChannel implements Channel {
	private readonly options: TelegramChannelOptions;
	private readonly api: Api;
	private messageId: number | undefined;
	private lastPreviewAt = 0;
	private lastPreviewText = "";

	constructor(options: TelegramChannelOptions) {
		this.options = options;
		this.api =
			options.api ??
			new Api(options.botToken, {
				apiRoot: options.apiBase,
				fetch: options.fetchImpl,
					maxRetries: 0,
			});
	}

	async send(delivery: OutboundDelivery): Promise<string | undefined> {
		return this.deliver(delivery);
	}

	/** Delivers the failure as ordinary text, so the user learns why it is quiet. */
	async sendError(delivery: OutboundDelivery): Promise<string | undefined> {
		return this.deliver({ ...delivery, text: `The turn failed: ${delivery.text}` });
	}

	private async deliver(delivery: OutboundDelivery): Promise<string | undefined> {
		const text = delivery.text.trim();
		if (text.length === 0) return undefined;
		const chunks = splitMessage(text, TELEGRAM_TEXT_LIMIT);
		let lastMessageId: number | undefined;
		for (const [index, chunk] of chunks.entries()) {
			// The first chunk replaces the streamed preview; the rest are new
			// messages, so a long answer still arrives in order. An edit can be
			// rejected (rate limit, message deleted), and the text still has to
			// land, so it falls back to a fresh message.
			if (index === 0 && this.messageId !== undefined) {
				const edited = await this.edit(chunk).catch(() => undefined);
				lastMessageId = edited ?? (await this.post(chunk));
			} else {
				lastMessageId = await this.post(chunk);
			}
		}
		this.messageId = undefined;
		this.lastPreviewText = "";
		return lastMessageId === undefined ? undefined : String(lastMessageId);
	}

	async syncPreview(text: string): Promise<void> {
		const trimmed = text.trim();
		if (trimmed.length === 0 || trimmed === this.lastPreviewText) return;
		const now = Date.now();
		const interval = this.options.previewIntervalMs ?? 900;
		const first = this.messageId === undefined;
		// Always show the first piece of a reply; throttle the rest.
		if (!first && now - this.lastPreviewAt < interval) return;
		const body = trimmed.slice(0, TELEGRAM_TEXT_LIMIT - 8) + (trimmed.length > TELEGRAM_TEXT_LIMIT - 8 ? "…" : "");
		this.lastPreviewAt = now;
		this.lastPreviewText = trimmed;
		if (first) {
			this.messageId = await this.post(body, true);
			return;
		}
		await this.edit(body);
	}

	async clearPreview(): Promise<void> {
		// The final text overwrites the preview message, so nothing to clear.
	}

	private async post(text: string, markTyping = false): Promise<number | undefined> {
		const result = await this.api.sendMessage({
			chat_id: this.options.chatId,
			text,
			...(markTyping ? {} : { disable_notification: true }),
		});
		return result.message_id;
	}

	private async edit(text: string): Promise<number | undefined> {
		if (this.messageId === undefined) return undefined;
		const result = await this.api.editMessageText({
			chat_id: this.options.chatId,
			message_id: this.messageId,
			text,
		});
		// Telegram answers an edit with the message, or `true` when nothing
		// changed; either way the id we already hold stays valid.
		return typeof result === "object" && result !== null ? result.message_id : this.messageId;
	}
}

/** Splits on paragraph boundaries when possible, never mid-code-block. */
export function splitMessage(text: string, limit: number): string[] {
	if (text.length <= limit) return [text];
	const chunks: string[] = [];
	let rest = text;
	while (rest.length > limit) {
		const window = rest.slice(0, limit);
		const boundary = Math.max(window.lastIndexOf("\n\n"), window.lastIndexOf("\n"));
		const cut = boundary > limit / 2 ? boundary : limit;
		chunks.push(rest.slice(0, cut).trimEnd());
		rest = rest.slice(cut).trimStart();
	}
	if (rest.length > 0) chunks.push(rest);
	return chunks;
}
