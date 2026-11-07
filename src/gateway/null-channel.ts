import type { Channel } from "./types.js";

/**
 * Where a conversation with no chat adapter delivers. Nothing is sent
 * anywhere: the gateway still returns the turn's reply from `receive`, which
 * is all `POST /messages` needs, so this exists only to keep the delivery path
 * in `Gateway` unconditional.
 */
export class NullChannel implements Channel {
	async send(): Promise<string | undefined> {
		return undefined;
	}

	async syncPreview(): Promise<void> {}

	async clearPreview(): Promise<void> {}
}
