import type { AttachmentInput, InboundMessageInput } from "../../../third_party/pi-chat/types.js";
import type { GatewayManager, ConversationSpec } from "../manager.js";
import { saveBytes } from "./files.js";

export interface TelegramUpdate {
	update_id: number;
	message?: {
		message_id: number;
		date?: number;
		text?: string;
		caption?: string;
		chat: { id: number; type?: string; title?: string; username?: string; first_name?: string };
		from?: { id: number; username?: string; first_name?: string; is_bot?: boolean };
		photo?: Array<{ file_id: string; file_size?: number }>;
		document?: { file_id: string; file_name?: string; mime_type?: string };
		voice?: { file_id: string; mime_type?: string };
	};
}

export interface TelegramPollOptions {
	botToken: string;
	/** Resolves a conversation id to its actor and lifecycle settings. */
	specFor: (conversationId: string) => ConversationSpec;
	/** Conversation id for a chat; defaults to `telegram/<chat id>`. */
	conversationFor?: (update: TelegramUpdate) => string;
	apiBase?: string;
	/** Long-poll window Telegram holds the request open for. */
	pollTimeoutSeconds?: number;
	/** Only these chat ids are answered; empty means any chat. */
	allowedChatIds?: string[];
	fetchImpl?: typeof fetch;
	log?: (message: string) => void;
}

/**
 * Feeds Telegram messages into the gateway.
 *
 * Every Telegram chat is its own conversation, so it gets its own actor and
 * its own `channel.jsonl`. The bot answers as the chat reports it, which keeps
 * the gateway from depending on a second framework: one long poll, one
 * manager call, one reply.
 */
export class TelegramPoll {
	private readonly options: TelegramPollOptions;
	private readonly manager: GatewayManager;
	private readonly fetchImpl: typeof fetch;
	private readonly log: (message: string) => void;
	private offset = 0;

	constructor(manager: GatewayManager, options: TelegramPollOptions) {
		this.manager = manager;
		this.options = options;
		this.fetchImpl = options.fetchImpl ?? fetch;
		this.log = options.log ?? (() => undefined);
	}

	/**
	 * Seeds the offset without replaying the backlog. A bot restarted after a
	 * long outage should not answer every message it missed, so old updates are
	 * acknowledged and skipped.
	 */
	async skipBacklog(): Promise<void> {
		const updates = await this.getUpdates(0, 0);
		const last = updates.at(-1);
		if (last) this.offset = last.update_id + 1;
		this.log(`skipping ${updates.length} queued update(s)`);
	}

	async run(signal?: AbortSignal): Promise<void> {
		while (!signal?.aborted) {
			try {
				const updates = await this.getUpdates(this.offset, this.options.pollTimeoutSeconds ?? 30);
				for (const update of updates) {
					this.offset = update.update_id + 1;
					await this.handle(update);
				}
			} catch (error) {
				if (signal?.aborted) break;
				this.log(`poll failed: ${error instanceof Error ? error.message : String(error)}`);
				await sleep(1_000);
			}
		}
	}

	private async handle(update: TelegramUpdate): Promise<void> {
		const message = update.message;
		if (!message) return;
		if (message.from?.is_bot) return;
		const chatId = String(message.chat.id);
		if (this.options.allowedChatIds?.length && !this.options.allowedChatIds.includes(chatId)) return;

		const conversationId = this.options.conversationFor?.(update) ?? `telegram/${chatId}`;
		const text = message.text ?? message.caption ?? "";
		const attachments = await this.attachments(message, conversationId);
		if (text.trim().length === 0 && attachments.length === 0) return;

		// `ensure` is what creates or opens the conversation; the reply itself
		// goes to the chat through the adapter, not back here.
		try {
			await this.manager.ensure(this.options.specFor(conversationId));
		} catch (error) {
			this.log(`cannot open ${conversationId}: ${describe(error)}`);
			return;
		}

		const input: InboundMessageInput = {
			userId: String(message.from?.id ?? chatId),
			userName: message.from?.username ?? message.from?.first_name ?? message.chat.title ?? chatId,
			text,
			messageId: `telegram-${message.message_id}`,
			attachments,
			// A Telegram chat is a DM only when it is a private chat; in a group
			// the bot is addressed explicitly.
			mentionedBot: message.chat.type !== "private",
		};
		await this.manager.receive(conversationId, input);
	}

	/** Downloads photos and documents into the conversation's incoming dir. */
	private async attachments(
		message: NonNullable<TelegramUpdate["message"]>,
		conversationId: string,
	): Promise<AttachmentInput[]> {
		const targets: Array<{ fileId: string; name: string; mimeType?: string }> = [];
		if (message.photo?.length) {
			const largest = [...message.photo].sort((a, b) => (b.file_size ?? 0) - (a.file_size ?? 0))[0];
			if (largest) targets.push({ fileId: largest.file_id, name: "photo.jpg", mimeType: "image/jpeg" });
		}
		if (message.document) {
			targets.push({
				fileId: message.document.file_id,
				name: message.document.file_name ?? "document",
				mimeType: message.document.mime_type,
			});
		}
		if (message.voice) {
			targets.push({ fileId: message.voice.file_id, name: "voice.ogg", mimeType: message.voice.mime_type });
		}
		if (targets.length === 0) return [];

		const saved: AttachmentInput[] = [];
		// The files dir belongs to the conversation; open it lazily so a text
		// message never touches the tree.
		const filesDir = (await this.manager.ensure(this.options.specFor(conversationId))).conversation.filesDir;
		for (const target of targets) {
			try {
				const bytes = await this.download(target.fileId);
				saved.push(await saveBytes(filesDir, target.name, bytes, target.mimeType));
			} catch (error) {
				this.log(`attachment ${target.name} failed: ${describe(error)}`);
			}
		}
		return saved;
	}

	private async download(fileId: string): Promise<Uint8Array> {
		const base = this.options.apiBase ?? "https://api.telegram.org";
		const info = (await this.call(base, "getFile", { file_id: fileId })) as { file_path?: string };
		if (!info?.file_path) throw new Error("telegram returned no file path");
		const response = await this.fetchImpl(`${base}/file/bot${this.options.botToken}/${info.file_path}`);
		if (!response.ok) throw new Error(`download failed: ${response.status}`);
		return new Uint8Array(await response.arrayBuffer());
	}

	private async getUpdates(offset: number, timeoutSeconds: number): Promise<TelegramUpdate[]> {
		const base = this.options.apiBase ?? "https://api.telegram.org";
		const result = await this.call(base, "getUpdates", {
			offset,
			timeout: timeoutSeconds,
			allowed_updates: ["message"],
		});
		return Array.isArray(result) ? (result as TelegramUpdate[]) : [];
	}

	private async call(base: string, method: string, body: Record<string, unknown>): Promise<unknown> {
		const response = await this.fetchImpl(`${base}/bot${this.options.botToken}/${method}`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body),
		});
		const payload = (await response.json().catch(() => ({}))) as {
			ok?: boolean;
			result?: unknown;
			description?: string;
		};
		if (!response.ok || payload.ok === false) {
			throw new Error(`telegram ${method} failed: ${payload.description ?? response.status}`);
		}
		return payload.result;
	}
}

function describe(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
