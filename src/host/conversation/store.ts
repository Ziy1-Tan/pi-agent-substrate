// Derived from earendil-works/pi-chat at 9adbd29 (Apache-2.0): the conversation
// log, its lock, and attachment copying come from `src/runtime.ts` and
// `src/log.ts` there. See THIRD_PARTY_NOTICES.md.
import { randomUUID } from "node:crypto";
import { appendFile, copyFile, lstat, mkdir, open, readFile, unlink } from "node:fs/promises";
import { basename, extname, join, relative, resolve } from "node:path";

import type {
	AttachmentInput,
	AttachmentKind,
	ConversationRecord,
	InboundMessage,
	InboundRecord,
	JobPrompt,
	JobQueuedRecord,
	JobState,
	OutboundRecord,
	PendingJob,
	StoredAttachment,
} from "./records.js";

/** Where one conversation lives on the gateway's disk. */
export interface Conversation {
	conversationId: string;
	conversationDir: string;
	/** Shown to the agent as `/workspace`. */
	workspaceDir: string;
	/** Attachments land here, inside the workspace. */
	filesDir: string;
	logPath: string;
	lockPath: string;
}

function safeSegment(value: string): string {
	return value.replace(/[^a-zA-Z0-9._-]+/g, "_");
}

/**
 * Lays out a conversation's directory. `account/channel` ids keep the
 * `accounts/<account>/channels/<channel>` tree earlier gateways wrote, so an
 * existing `channel.jsonl` is found where it was left.
 */
export async function createConversation(rootDir: string, conversationId = "test/chat"): Promise<Conversation> {
	const [accountId, channelKey] = conversationId.split("/");
	if (!accountId || !channelKey) throw new Error(`invalid conversation id: ${conversationId}`);
	const conversationDir = join(rootDir, "accounts", safeSegment(accountId), "channels", safeSegment(channelKey));
	const workspaceDir = join(conversationDir, "workspace");
	const conversation: Conversation = {
		conversationId,
		conversationDir,
		workspaceDir,
		filesDir: join(workspaceDir, "incoming"),
		logPath: join(conversationDir, "channel.jsonl"),
		lockPath: join(conversationDir, ".lock"),
	};
	await mkdir(conversation.filesDir, { recursive: true });
	return conversation;
}

/**
 * One conversation's append-only log. It is the only record of which jobs are
 * queued, dispatched, delivered, and finished, so a gateway that restarts reads
 * it back and resumes exactly the jobs that have no terminal record. A lock
 * file keeps two gateways from appending to the same log.
 */
export class ConversationStore {
	readonly conversation: Conversation;
	private records: ConversationRecord[];
	private nextRecordId: number;
	/** Mutations run one at a time, so the log on disk is in record order. */
	private tail: Promise<unknown> = Promise.resolve();

	private constructor(conversation: Conversation, log: ParsedLog) {
		this.conversation = conversation;
		this.records = log.records;
		this.nextRecordId = log.lastRecordId + 1;
	}

	/** Takes the conversation's lock and reads its log. */
	static async open(conversation: Conversation, ownerId: string): Promise<ConversationStore> {
		await mkdir(conversation.filesDir, { recursive: true });
		await acquireLock(conversation.lockPath, ownerId);
		return new ConversationStore(conversation, await readLog(conversation.logPath));
	}

	async close(): Promise<void> {
		await unlink(this.conversation.lockPath).catch(() => undefined);
	}

	/** Records a message and queues a job to answer it. */
	appendInbound(input: InboundMessage): Promise<PendingJob> {
		return this.exclusive(async () => {
			const messageId = input.messageId || `msg-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
			const inbound = await this.append<InboundRecord>({
				type: "inbound",
				messageId,
				userId: input.userId,
				userName: input.userName,
				text: input.text.trim(),
				attachments: await this.storeAttachments(messageId, input.attachments),
			});
			const queued = await this.append<JobQueuedRecord>({
				type: "job_queued",
				jobId: randomUUID(),
				triggerRecordId: inbound.recordId,
			});
			return { jobId: queued.jobId, triggerRecordId: queued.triggerRecordId };
		});
	}

	/** Jobs with a queue record and no terminal record, in queue order. */
	unfinishedJobs(): PendingJob[] {
		const finished = new Set<string>();
		for (const record of this.records) {
			if (record.type === "job_completed" || record.type === "job_failed") finished.add(record.jobId);
		}
		return this.records.flatMap((record) =>
			record.type === "job_queued" && !finished.has(record.jobId)
				? [{ jobId: record.jobId, triggerRecordId: record.triggerRecordId }]
				: [],
		);
	}

	jobState(jobId: string): JobState {
		const state: JobState = { completed: false, failed: false };
		for (const record of this.records) {
			if (!("jobId" in record) || record.jobId !== jobId) continue;
			if (record.type === "job_dispatched") state.requestId ??= record.requestId;
			else if (record.type === "outbound") state.outbound = record;
			else if (record.type === "job_completed") state.completed = true;
			else if (record.type === "job_failed") state.failed = true;
		}
		return state;
	}

	/** The messages since the last answered one, as the agent reads them. */
	promptFor(job: PendingJob): JobPrompt {
		let answeredThrough = 0;
		for (const record of this.records) {
			if (record.type === "job_completed") answeredThrough = Math.max(answeredThrough, record.triggerRecordId);
		}
		const lines: string[] = [];
		for (const record of this.records) {
			if (record.type !== "inbound") continue;
			if (record.recordId <= answeredThrough || record.recordId > job.triggerRecordId) continue;
			lines.push(...this.transcriptLines(record));
		}
		return { prompt: lines.join("\n").trim(), triggerMessageId: this.triggerMessageId(job) };
	}

	/** Records the request id once; a retried job keeps the first one. */
	recordDispatched(job: PendingJob, requestId: string): Promise<string> {
		return this.exclusive(async () => {
			const existing = this.jobState(job.jobId).requestId;
			if (existing !== undefined) return existing;
			await this.append({ type: "job_dispatched", jobId: job.jobId, triggerRecordId: job.triggerRecordId, requestId });
			return requestId;
		});
	}

	/** Records a delivered reply. An empty reply leaves no outbound record. */
	recordOutbound(job: PendingJob, text: string, remoteMessageId?: string): Promise<OutboundRecord | undefined> {
		return this.exclusive(async () => {
			const trimmed = text.trim();
			if (trimmed.length === 0) return undefined;
			return this.append<OutboundRecord>({
				type: "outbound",
				messageId: remoteMessageId || `reply-${job.jobId}`,
				text: trimmed,
				replyToMessageId: this.triggerMessageId(job),
				jobId: job.jobId,
			});
		});
	}

	recordCompleted(job: PendingJob, outboundRecordId?: number): Promise<void> {
		return this.exclusive(async () => {
			const state = this.jobState(job.jobId);
			if (state.completed || state.failed) return;
			await this.append({
				type: "job_completed",
				jobId: job.jobId,
				triggerRecordId: job.triggerRecordId,
				outboundRecordId,
			});
		});
	}

	recordFailed(job: PendingJob, error: string): Promise<void> {
		return this.exclusive(async () => {
			const state = this.jobState(job.jobId);
			if (state.completed || state.failed) return;
			await this.append({ type: "job_failed", jobId: job.jobId, triggerRecordId: job.triggerRecordId, error });
		});
	}

	private exclusive<T>(work: () => Promise<T>): Promise<T> {
		const run = this.tail.then(work, work);
		this.tail = run.catch(() => undefined);
		return run;
	}

	private triggerMessageId(job: PendingJob): string | undefined {
		const trigger = this.records.find((record) => record.recordId === job.triggerRecordId);
		return trigger?.type === "inbound" ? trigger.messageId : undefined;
	}

	private async append<T extends ConversationRecord>(fields: DistributiveOmit<T, "recordId" | "timestamp">): Promise<T> {
		const record = { ...fields, recordId: this.nextRecordId++, timestamp: new Date().toISOString() } as unknown as T;
		this.records.push(record);
		await appendFile(this.conversation.logPath, `${JSON.stringify(record)}\n`, "utf8");
		return record;
	}

	private transcriptLines(record: InboundRecord): string[] {
		const lines = [
			`- [${record.timestamp}] [uid:${record.userId}] ${record.userName ?? "unknown"}: ${record.text || "(no text)"}`,
		];
		if (record.attachments.length > 0) {
			lines.push("  attachments:");
			for (const attachment of record.attachments) {
				const type = attachment.mimeType ? ` (${attachment.mimeType})` : "";
				lines.push(`  - ${this.guestPath(attachment.localPath)}${type}`);
			}
		}
		return lines;
	}

	/** The path as the agent sees it, with the workspace mounted at `/workspace`. */
	private guestPath(localPath: string): string {
		if (!isInside(this.conversation.workspaceDir, localPath)) return localPath;
		const suffix = relative(this.conversation.workspaceDir, localPath);
		return suffix ? `/workspace/${suffix}` : "/workspace";
	}

	/** Copies attachments into `filesDir` unless a channel already saved them there. */
	private async storeAttachments(
		messageId: string,
		attachments: AttachmentInput[] | undefined,
	): Promise<StoredAttachment[]> {
		if (!attachments?.length) return [];
		const stored: StoredAttachment[] = [];
		for (const [index, attachment] of attachments.entries()) {
			const info = await lstat(attachment.path);
			if (!info.isFile()) throw new Error(`attachment is not a regular file: ${attachment.path}`);
			const name = safeSegment(attachment.name || basename(attachment.path));
			const inPlace = isInside(this.conversation.filesDir, attachment.path);
			const localPath = inPlace
				? attachment.path
				: join(this.conversation.filesDir, `${Date.now()}-${messageId}-${index + 1}-${name}`);
			if (!inPlace) await copyFile(attachment.path, localPath);
			stored.push({
				kind: attachmentKind(attachment.path),
				name,
				mimeType: attachment.mimeType || mimeTypeOf(attachment.path),
				size: info.size,
				originalPath: inPlace ? undefined : attachment.path,
				localPath,
			});
		}
		return stored;
	}
}

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

const KNOWN_TYPES = new Set(["inbound", "job_queued", "job_dispatched", "outbound", "job_completed", "job_failed"]);

/**
 * Reads the log back. A crash mid-append can leave the last line cut short;
 * that line never finished being written, so it is dropped. Damage anywhere
 * else is an error rather than a silently shortened history.
 */
interface ParsedLog {
	records: ConversationRecord[];
	/** Highest id in the file, counting records of types no longer read. */
	lastRecordId: number;
}

async function readLog(logPath: string): Promise<ParsedLog> {
	let content: string;
	try {
		content = await readFile(logPath, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return { records: [], lastRecordId: 0 };
		throw error;
	}
	const lines = content.split("\n").filter((line) => line.trim().length > 0);
	const records: ConversationRecord[] = [];
	let lastRecordId = 0;
	for (const [index, line] of lines.entries()) {
		let record: ConversationRecord;
		try {
			record = JSON.parse(line) as ConversationRecord;
		} catch (error) {
			if (index === lines.length - 1 && !content.endsWith("\n")) break;
			throw new Error(`${logPath}:${index + 1} is not a JSON record`, { cause: error });
		}
		lastRecordId = Math.max(lastRecordId, record.recordId);
		if (KNOWN_TYPES.has(record.type)) records.push(record);
	}
	return { records: records.sort((a, b) => a.recordId - b.recordId), lastRecordId };
}

/** A lock owner id naming this process, so a later gateway can tell it died. */
export function lockOwner(): string {
	return `gateway-${process.pid}-${randomUUID()}`;
}

/**
 * Takes the lock file, or takes it over when the process named in it is gone.
 * `pi-chat-<pid>-` is the owner format earlier gateways wrote, so a lock left
 * by one of them is recognised as stale too.
 */
async function acquireLock(lockPath: string, owner: string): Promise<void> {
	if (await createLock(lockPath, owner)) return;
	const existing = (await readFile(lockPath, "utf8")).trim();
	const pid = Number(existing.match(/^(?:gateway|pi-chat)-(\d+)-/)?.[1]);
	if (Number.isFinite(pid) && !isAlive(pid)) {
		await unlink(lockPath).catch(() => undefined);
		if (await createLock(lockPath, owner)) return;
	}
	throw new Error(`conversation is already locked by ${existing || "another gateway"}`);
}

async function createLock(lockPath: string, owner: string): Promise<boolean> {
	try {
		const handle = await open(lockPath, "wx");
		try {
			await handle.writeFile(`${owner}\n`, "utf8");
		} finally {
			await handle.close();
		}
		return true;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
		throw error;
	}
}

function isAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

function isInside(root: string, path: string): boolean {
	const rel = relative(resolve(root), resolve(path));
	return rel === "" || (!rel.startsWith("..") && !rel.startsWith("/"));
}

function attachmentKind(path: string): AttachmentKind {
	const ext = extname(path).toLowerCase();
	if ([".png", ".jpg", ".jpeg", ".gif", ".webp"].includes(ext)) return "image";
	if ([".mp3", ".wav", ".ogg", ".m4a"].includes(ext)) return "audio";
	if ([".mp4", ".mov", ".webm"].includes(ext)) return "video";
	return "file";
}

const MIME_TYPES: Record<string, string> = {
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".gif": "image/gif",
	".webp": "image/webp",
	".mp3": "audio/mpeg",
	".wav": "audio/wav",
	".ogg": "audio/ogg",
	".mp4": "video/mp4",
	".json": "application/json",
	".md": "text/markdown",
	".txt": "text/plain",
	".log": "text/plain",
};

function mimeTypeOf(path: string): string | undefined {
	return MIME_TYPES[extname(path).toLowerCase()];
}
