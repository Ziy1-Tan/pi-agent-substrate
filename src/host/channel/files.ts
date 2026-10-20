import { mkdir, writeFile } from "node:fs/promises";
import { basename, extname, join } from "node:path";

import type { AttachmentInput } from "../conversation/records.js";

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
	const saved: AttachmentInput[] = [];
	for (const [index, upload] of uploads.entries()) {
		const data = Buffer.from(upload.data, "base64");
		if (data.byteLength > MAX_UPLOAD_BYTES) {
			throw new Error(`attachment ${upload.name} exceeds ${MAX_UPLOAD_BYTES} bytes`);
		}
		const fallback = `upload-${index + 1}`;
		saved.push(await writeOne(filesDir, `${messageId}-${index + 1}`, upload.name, fallback, data, upload.mimeType));
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
	return writeOne(filesDir, String(process.hrtime.bigint()), name, "file", bytes, mimeType);
}

/**
 * Writes one attachment under a name no two turns can collide on. A client can
 * send any name, so only the leaf survives; the leaf itself may still be empty
 * or unusable, which is what `fallback` covers.
 */
async function writeOne(
	filesDir: string,
	tag: string,
	rawName: string,
	fallback: string,
	bytes: Uint8Array,
	mimeType: string | undefined,
): Promise<AttachmentInput> {
	await mkdir(filesDir, { recursive: true });
	const name = safeName(rawName) || fallback;
	const path = join(filesDir, `${Date.now()}-${tag}-${name}`);
	await writeFile(path, bytes);
	return { path, name, mimeType };
}

function safeName(value: string): string {
	const leaf = basename(value || "");
	const stem = leaf.slice(0, Math.max(0, leaf.length - extname(leaf).length));
	const clean = `${stem}${extname(leaf)}`.replace(/[^a-zA-Z0-9._-]+/g, "_");
	return clean.startsWith(".") ? `file${clean}` : clean;
}
