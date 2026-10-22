import type { AttachmentInput, InboundMessage } from "../conversation/records.js";
import type { GatewayManager, ConversationSpec } from "../manager.js";
import { saveBytes } from "./files.js";
import { Api, longPoll, type Message, type Update } from "node-telegram-bot-api";

export type TelegramUpdate = Update;

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
	/** Bot API client; tests can inject a transport. */
	api?: Api;
	/** Delay before retrying a fatal poll error such as `409 Conflict`. */
	pollRetryDelayMs?: number;
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
	private readonly api: Api;
	private readonly log: (message: string) => void;
	private offset = 0;

	constructor(manager: GatewayManager, options: TelegramPollOptions) {
		this.manager = manager;
		this.options = options;
		this.api =
			options.api ??
			new Api(options.botToken, {
				apiRoot: options.apiBase,
				fetch: options.fetchImpl,
				maxRetries: 0,
			});
		this.log = options.log ?? (() => undefined);
	}

	/** Acknowledges queued updates before polling starts, so a restart does not replay old messages. */
	async skipBacklog(): Promise<void> {
		const updates = await this.api.getUpdates({
			offset: 0,
			limit: 100,
			timeout: 0,
			allowed_updates: ["message"],
		});
		const last = updates.at(-1);
		if (last) this.offset = last.update_id + 1;
		this.log(`skipping ${updates.length} queued update(s)`);
	}

	async run(signal?: AbortSignal): Promise<void> {
		const { pollRetryDelayMs = 5_000, pollTimeoutSeconds = 30 } = this.options;
		while (!signal?.aborted) {
			try {
				for await (const update of longPoll(
					this.api,
					{
						offset: this.offset,
						timeout: pollTimeoutSeconds,
						allowedUpdates: ["message"],
						onError: (error) => this.log(`poll failed: ${describe(error)}`),
					},
					signal,
				)) {
					this.offset = update.update_id + 1;
					await this.handle(update);
				}
				return;
			} catch (error) {
				if (signal?.aborted) return;
				this.log(`poll stopped: ${describe(error)}`);
				await sleep(pollRetryDelayMs);
			}
		}
	}

	private async handle(update: TelegramUpdate): Promise<void> {
		if (!("message" in update)) return;
		const message = update.message;
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

		const input: InboundMessage = {
			userId: String(message.from?.id ?? chatId),
			userName: message.from?.username ?? message.from?.first_name ?? message.chat.title ?? chatId,
			text,
			messageId: `telegram-${message.message_id}`,
			attachments,
		};
		await this.manager.receive(conversationId, input);
	}

	/** Downloads photos and documents into the conversation's incoming dir. */
	private async attachments(
		message: Message,
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
		const info = await this.api.getFile({ file_id: fileId });
		if (!info?.file_path) throw new Error("telegram returned no file path");
		const response = await (this.options.fetchImpl ?? fetch)(`${base}/file/bot${this.options.botToken}/${info.file_path}`);
		if (!response.ok) throw new Error(`download failed: ${response.status}`);
		return new Uint8Array(await response.arrayBuffer());
	}
}

function describe(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
