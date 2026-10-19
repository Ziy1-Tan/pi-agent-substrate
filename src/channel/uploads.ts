import { mkdir, writeFile } from "node:fs/promises";
import { basename, extname, join } from "node:path";

import type { AttachmentInput } from "../../third_party/pi-chat/types.js";

/** One uploaded file as a client sends it. */
export interface UploadInput {
	name: string;
	/** Base64, without a data-URL prefix. */
	data: string;
	mimeType?: string;
}

/** Keep uploaded files small; the gateway is not a file service. */
export const MAX_UPLOAD_BYTES = 8 * 1024 * 1024;

/**
 * Decodes base64 uploads into the conversation's files directory. The runtime
 * then copies each one under `incoming/` and names it in the prompt, which is
 * the same path a chat-platform attachment takes.
 */
export async function saveUploads(
	filesDir: string,
	messageId: string,
	uploads: UploadInput[] | undefined,
): Promise<AttachmentInput[]> {
	if (!uploads?.length) return [];
	await mkdir(filesDir, { recursive: true });
	const saved: AttachmentInput[] = [];
	for (const [index, upload] of uploads.entries()) {
		const data = Buffer.from(upload.data, "base64");
		if (data.byteLength > MAX_UPLOAD_BYTES) {
			throw new Error(`attachment ${upload.name} exceeds ${MAX_UPLOAD_BYTES} bytes`);
		}
		// A client can send any name; keep only the leaf so an upload cannot
		// escape the conversation directory.
		const name = safeName(upload.name) || `upload-${index + 1}`;
		const path = join(filesDir, `${Date.now()}-${messageId}-${index + 1}-${name}`);
		await writeFile(path, data);
		saved.push({ path, name, mimeType: upload.mimeType });
	}
	return saved;
}

/** Saves one file whose bytes are already in hand, as Telegram webhooks send them. */
export async function saveBytes(
	filesDir: string,
	name: string,
	bytes: Uint8Array,
	mimeType?: string,
): Promise<AttachmentInput> {
	await mkdir(filesDir, { recursive: true });
	const clean = safeName(name) || "file";
	const path = join(filesDir, `${Date.now()}-${process.hrtime.bigint()}-${clean}`);
	await writeFile(path, bytes);
	return { path, name: clean, mimeType };
}

function safeName(value: string): string {
	const leaf = basename(value || "");
	const stem = leaf.slice(0, Math.max(0, leaf.length - extname(leaf).length));
	const clean = `${stem}${extname(leaf)}`.replace(/[^a-zA-Z0-9._-]+/g, "_");
	return clean.startsWith(".") ? `file${clean}` : clean;
}
