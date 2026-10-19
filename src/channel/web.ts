import { mkdir, writeFile } from "node:fs/promises";
import { basename, extname, join } from "node:path";

import type { AttachmentInput } from "../../third_party/pi-chat/types.js";
import type { Channel, OutboundDelivery } from "../gateway/types.js";
import { EventRing, type Sequenced } from "./events.js";

/** One uploaded file as the browser sends it. */
export interface UploadInput {
	name: string;
	/** Base64, without a data-URL prefix. */
	data: string;
	mimeType?: string;
}

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
	/** Receives every event with its sequence number. */
	onEvent?: (event: Sequenced<WebChannelEvent>) => void;
}

/**
 * Channel over a browser WebSocket.
 *
 * The gateway calls `syncPreview` for each streamed delta and `send` once per
 * turn. Both become sequenced events, so a client that reconnects with
 * `since=<seq>` gets exactly the deltas it missed and nothing it already saw.
 * Uploads are written before the runtime sees them; the runtime then copies
 * them under the conversation's `incoming/` directory and the prompt names
 * them, which is the same path a Slack or Discord attachment takes.
 */
export class WebChannel implements Channel {
	readonly conversationId: string;
	readonly events = new EventRing<WebChannelEvent>(2_000);

	/** Keep uploads small; the gateway is not a file service. */
	static readonly maxUploadBytes = 8 * 1024 * 1024;

	private readonly filesDir: string;
	private readonly listeners = new Set<(event: Sequenced<WebChannelEvent>) => void>();

	constructor(options: WebChannelOptions) {
		this.conversationId = options.conversationId;
		this.filesDir = options.filesDir;
		if (options.onEvent) this.listeners.add(options.onEvent);
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
		if (!uploads?.length) return [];
		await mkdir(this.filesDir, { recursive: true });
		const saved: AttachmentInput[] = [];
		for (const [index, upload] of uploads.entries()) {
			const data = Buffer.from(upload.data, "base64");
			if (data.byteLength > WebChannel.maxUploadBytes) {
				throw new Error(`attachment ${upload.name} exceeds ${WebChannel.maxUploadBytes} bytes`);
			}
			// A browser can send any name; keep only the leaf so an upload cannot
			// escape the conversation directory.
			const name = safeName(upload.name) || `upload-${index + 1}`;
			const path = join(this.filesDir, `${Date.now()}-${messageId}-${index + 1}-${name}`);
			await writeFile(path, data);
			saved.push({ path, name, mimeType: upload.mimeType });
		}
		return saved;
	}

	private record(event: Omit<WebChannelEvent, "conversationId">): void {
		const sequenced = this.events.record({ conversationId: this.conversationId, ...event });
		for (const listener of this.listeners) listener(sequenced);
	}
}

function safeName(value: string): string {
	const leaf = basename(value || "");
	const stem = leaf.slice(0, Math.max(0, leaf.length - extname(leaf).length));
	const clean = `${stem}${extname(leaf)}`.replace(/[^a-zA-Z0-9._-]+/g, "_");
	return clean.startsWith(".") ? `file${clean}` : clean;
}
