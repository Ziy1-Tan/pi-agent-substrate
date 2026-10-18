import { randomUUID } from "node:crypto";

import { ConversationRuntime } from "../../third_party/pi-chat/src/runtime.js";
import type { PendingJob } from "../../third_party/pi-chat/types.js";
import type { Checkpoint, GatewayOptions, InboundMessageInput } from "./types.js";

/** Thrown by an injected hook to stop the gateway like a process crash would. */
export class GatewayAbort extends Error {
	constructor(message = "gateway aborted by an injected fault") {
		super(message);
		this.name = "GatewayAbort";
	}
}

interface IdleWaiter {
	resolve: () => void;
	reject: (error: Error) => void;
}

/**
 * One gateway instance owns one conversation. All delivery state lives in the
 * conversation's channel.jsonl, so a new instance can resume after a restart.
 */
export class Gateway {
	private readonly options: GatewayOptions;
	private runtime: ConversationRuntime | undefined;
	private queue: PendingJob[] = [];
	private active: PendingJob | undefined;
	private wake: (() => void) | undefined;
	private idleWaiters: IdleWaiter[] = [];
	private stopped = false;
	private abortError: Error | undefined;
	private started = false;
	private loop: Promise<void> | undefined;

	constructor(options: GatewayOptions) {
		this.options = options;
	}

	async start(): Promise<void> {
		if (this.started) throw new Error("gateway is already started");
		const ownerId = this.options.ownerId ?? `pi-chat-${process.pid}-${randomUUID()}`;
		this.runtime = await ConversationRuntime.connect(this.options.conversation, ownerId);
		// Do not replay history that predates this process. Newly ingested
		// messages get fresh record ids and still trigger.
		this.runtime.armAfterCurrentTail();
		this.queue = this.runtime.listUnfinishedJobs();
		this.started = true;
		this.loop = this.processLoop();
		this.maybeSettle();
	}

	async receive(input: InboundMessageInput, checkpoint?: Checkpoint): Promise<void> {
		this.ensureRunning();
		const runtime = this.runtime;
		if (!runtime) throw new Error("gateway is not running");
		const { queuedJob } = await runtime.ingestInbound(input, checkpoint);
		if (queuedJob) this.queue.push(queuedJob);
		this.signalWork();
		this.maybeSettle();
	}

	/** Resolves once the queue is empty; rejects if an injected fault fired. */
	waitForIdle(): Promise<void> {
		if (this.abortError) return Promise.reject(this.abortError);
		if (this.started && this.active === undefined && this.queue.length === 0) return Promise.resolve();
		return new Promise((resolve, reject) => this.idleWaiters.push({ resolve, reject }));
	}

	async stop(): Promise<void> {
		this.stopped = true;
		this.signalWork();
		await this.loop;
		await this.runtime?.disconnect();
		this.runtime = undefined;
		this.started = false;
	}

	private ensureRunning(): void {
		if (!this.started || this.stopped) throw new Error("gateway is not running");
	}

	private async processLoop(): Promise<void> {
		while (!this.stopped) {
			const job = this.queue.shift();
			if (!job) {
				await this.waitForWork();
				continue;
			}
			this.active = job;
			try {
				await this.runJob(job);
			} catch (error) {
				if (error instanceof GatewayAbort) {
					this.abortError = error;
					this.stopped = true;
					break;
				}
				const message = error instanceof Error ? error.message : String(error);
				await this.runtime?.recordJobFailed(job, message);
			} finally {
				this.active = undefined;
				this.maybeSettle();
			}
		}
		this.maybeSettle();
	}

	private async runJob(job: PendingJob): Promise<void> {
		const runtime = this.runtime;
		if (!runtime) throw new Error("gateway is not running");
		const state = runtime.getJobState(job.jobId);
		if (state.completed || state.failed) return;
		if (state.outbound) {
			// The response was recorded before the restart, so acknowledge the
			// turn without calling the backend or the channel again.
			await runtime.acknowledgeJobCompleted(job, state.outbound.recordId);
			return;
		}

		// A retry after a crash keeps the original request id.
		const requestId = state.dispatched.at(-1)?.requestId ?? job.jobId;
		await this.options.hooks?.beforeSubmit?.();
		await runtime.appendJobDispatched(job, requestId);
		const dispatch = runtime.beginJob(job);

		let streamed = "";
		let previews: Promise<void> = Promise.resolve();
		const onDelta = (delta: string) => {
			if (this.stopped) return;
			streamed += delta;
			const snapshot = streamed;
			previews = previews.then(() => this.options.channel.syncPreview(snapshot));
		};

		const pending = this.options.backend.submit(
			{ requestId, conversationId: this.options.conversation.conversationId, prompt: dispatch.prompt },
			onDelta,
		);
		// The external turn may finish after an injected crash; keep it handled.
		pending.catch(() => undefined);
		await this.options.hooks?.afterSubmit?.();
		const response = await pending;
		await previews;
		await this.options.hooks?.afterResponse?.();

		await this.options.channel.clearPreview();
		const remoteMessageId = await this.options.channel.send({
			deliveryId: requestId,
			text: response.text,
			replyToMessageId: dispatch.triggerMessageId,
		});
		await this.options.hooks?.afterChannelSend?.();

		const outbound = await runtime.recordOutbound(response.text, remoteMessageId);
		await this.options.hooks?.afterOutbound?.();
		await runtime.recordJobCompleted(outbound?.recordId);
	}

	private waitForWork(): Promise<void> {
		return new Promise((resolve) => {
			this.wake = resolve;
		});
	}

	private signalWork(): void {
		const wake = this.wake;
		this.wake = undefined;
		wake?.();
	}

	private maybeSettle(): void {
		if (this.abortError) {
			const error = this.abortError;
			for (const waiter of this.idleWaiters.splice(0)) waiter.reject(error);
			return;
		}
		if (!this.started || this.active !== undefined || this.queue.length > 0) return;
		for (const waiter of this.idleWaiters.splice(0)) waiter.resolve();
	}
}
