import type { ChatService } from "./config-types.js";

export type AttachmentKind = "image" | "file" | "audio" | "video";

export interface AttachmentInput {
	path: string;
	name?: string;
	kind?: AttachmentKind;
	mimeType?: string;
	remoteUrl?: string;
}

export interface StoredAttachment {
	kind: AttachmentKind;
	name: string;
	mimeType?: string;
	size?: number;
	remoteUrl?: string;
	originalPath?: string;
	localPath: string;
}

export interface InboundMessageInput {
	messageId?: string;
	userId: string;
	userName?: string;
	roleIds?: string[];
	text: string;
	mentionedBot?: boolean;
	isBot?: boolean;
	attachments?: AttachmentInput[];
}

export interface ChatRecordBase {
	recordId: number;
	timestamp: string;
	service: ChatService;
	accountId: string;
	channelKey: string;
	channelId: string;
	scope: "channel";
}

export interface InboundMessageRecord extends ChatRecordBase {
	type: "inbound";
	messageId: string;
	userId: string;
	userName?: string;
	roleIds?: string[];
	text: string;
	mentionedBot: boolean;
	isBot: boolean;
	attachments: StoredAttachment[];
}
export interface OutboundMessageRecord extends ChatRecordBase {
	type: "outbound";
	messageId: string;
	text: string;
	replyToMessageId?: string;
	jobId: string;
	attachments?: string[];
}
export interface CheckpointRecord extends ChatRecordBase {
	type: "checkpoint";
	cursor?: string;
	messageId?: string;
}
export interface JobQueuedRecord extends ChatRecordBase {
	type: "job_queued";
	jobId: string;
	trigger: "mention" | "dm";
	triggerRecordId: number;
}
// Added for pi-agent-substrate: the request id is stable for the lifetime of a
// job, so a gateway restart can retry the same turn without executing it twice.
export interface JobDispatchedRecord extends ChatRecordBase {
	type: "job_dispatched";
	jobId: string;
	triggerRecordId: number;
	requestId: string;
}
export interface JobCompletedRecord extends ChatRecordBase {
	type: "job_completed";
	jobId: string;
	triggerRecordId: number;
	outboundRecordId?: number;
}
export interface JobFailedRecord extends ChatRecordBase {
	type: "job_failed";
	jobId: string;
	triggerRecordId: number;
	error: string;
}
export interface ErrorRecord extends ChatRecordBase {
	type: "error";
	message: string;
}

export type ChatLogRecord =
	| InboundMessageRecord
	| OutboundMessageRecord
	| CheckpointRecord
	| JobQueuedRecord
	| JobDispatchedRecord
	| JobCompletedRecord
	| JobFailedRecord
	| ErrorRecord;

export interface PendingJob {
	jobId: string;
	trigger: "mention" | "dm";
	triggerRecordId: number;
	queuedRecordId: number;
}

export interface DispatchableJob {
	job: PendingJob;
	prompt: string;
	triggerMessageId?: string;
}

export interface JobDeliveryState {
	queued?: JobQueuedRecord;
	dispatched: JobDispatchedRecord[];
	outbound?: OutboundMessageRecord;
	completed?: JobCompletedRecord;
	failed?: JobFailedRecord;
}

export interface ChatHistoryQuery {
	query?: string;
	after?: string;
	before?: string;
	limit?: number;
}

export interface ConversationStatus {
	conversationId: string;
	conversationName: string;
	logPath: string;
	queueLength: number;
	hasActiveJob: boolean;
	recordCount: number;
	lastRecordId: number;
}
