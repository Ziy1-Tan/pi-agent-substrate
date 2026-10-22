/** Record shapes for `channel.jsonl`, and the inputs that become records. */

export type AttachmentKind = "image" | "file" | "audio" | "video";

/** A file a channel has already saved, to be named in the prompt. */
export interface AttachmentInput {
	path: string;
	name?: string;
	mimeType?: string;
}

export interface StoredAttachment {
	kind: AttachmentKind;
	name: string;
	mimeType?: string;
	size?: number;
	/** Where the file came from when it had to be copied in. */
	originalPath?: string;
	localPath: string;
}

/** One message from a channel, before it is recorded. */
export interface InboundMessage {
	messageId?: string;
	userId: string;
	userName?: string;
	text: string;
	attachments?: AttachmentInput[];
}

interface RecordBase {
	recordId: number;
	timestamp: string;
}

export interface InboundRecord extends RecordBase {
	type: "inbound";
	messageId: string;
	userId: string;
	userName?: string;
	text: string;
	attachments: StoredAttachment[];
}

export interface JobQueuedRecord extends RecordBase {
	type: "job_queued";
	jobId: string;
	triggerRecordId: number;
}

/** The request id is stable for a job, so a restart retries the same turn. */
export interface JobDispatchedRecord extends RecordBase {
	type: "job_dispatched";
	jobId: string;
	triggerRecordId: number;
	requestId: string;
}

export interface OutboundRecord extends RecordBase {
	type: "outbound";
	messageId: string;
	text: string;
	replyToMessageId?: string;
	jobId: string;
}

export interface JobCompletedRecord extends RecordBase {
	type: "job_completed";
	jobId: string;
	triggerRecordId: number;
	outboundRecordId?: number;
}

export interface JobFailedRecord extends RecordBase {
	type: "job_failed";
	jobId: string;
	triggerRecordId: number;
	error: string;
}

export type ConversationRecord =
	| InboundRecord
	| JobQueuedRecord
	| JobDispatchedRecord
	| OutboundRecord
	| JobCompletedRecord
	| JobFailedRecord;

/** A job the log says was queued and has not finished. */
export interface PendingJob {
	jobId: string;
	triggerRecordId: number;
}

/** Everything the log knows about one job, for deciding how to resume it. */
export interface JobState {
	/** Set once the turn was handed to the backend. */
	requestId?: string;
	/** Set once the reply was delivered and recorded. */
	outbound?: OutboundRecord;
	completed: boolean;
	failed: boolean;
}

/** What a job sends to the agent, and which message the reply answers. */
export interface JobPrompt {
	prompt: string;
	triggerMessageId?: string;
}
