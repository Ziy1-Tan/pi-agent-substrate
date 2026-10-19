import type { Channel, OutboundDelivery } from "../gateway/types.js";

export interface TelegramChannelOptions {
	botToken: string;
	chatId: string;
	/** Telegram's sendMessage endpoint; tests point this at a local server. */
	apiBase?: string;
	/** Streaming edits are rate limited by the platform, so previews wait. */
	previewIntervalMs?: number;
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
	private readonly fetchImpl: typeof fetch;
	private messageId: number | undefined;
	private lastPreviewAt = 0;
	private lastPreviewText = "";

	constructor(options: TelegramChannelOptions) {
		this.options = options;
		this.fetchImpl = options.fetchImpl ?? fetch;
	}

	async send(delivery: OutboundDelivery): Promise<string | undefined> {
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
				lastMessageId = edited ?? await this.post(chunk);
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
		const result = await this.call("sendMessage", {
			chat_id: this.options.chatId,
			text,
			...(markTyping ? {} : { disable_notification: true }),
		});
		const messageId = (result as { message_id?: number } | undefined)?.message_id;
		return messageId;
	}

	private async edit(text: string): Promise<number | undefined> {
		if (this.messageId === undefined) return undefined;
		const result = await this.call("editMessageText", {
			chat_id: this.options.chatId,
			message_id: this.messageId,
			text,
		});
		// Telegram answers an edit with the message, or `true` when nothing
		// changed; either way the id we already hold stays valid.
		if (typeof result === "object" && result !== null && "message_id" in result) {
			return (result as { message_id: number }).message_id;
		}
		return this.messageId;
	}

	private async call(method: string, body: Record<string, unknown>): Promise<unknown> {
		const base = this.options.apiBase ?? "https://api.telegram.org";
		const response = await this.fetchImpl(`${base}/bot${this.options.botToken}/${method}`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body),
		});
		const payload = (await response.json().catch(() => ({}))) as { ok?: boolean; result?: unknown; description?: string };
		if (!response.ok || payload.ok === false) {
			throw new Error(`telegram ${method} failed: ${payload.description ?? response.status}`);
		}
		return payload.result;
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
