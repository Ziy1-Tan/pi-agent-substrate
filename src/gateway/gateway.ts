import { ConversationStore, lockOwner } from "./conversation/store.js";
import type { InboundMessage, JobState, PendingJob } from "./conversation/records.js";
import type { AgentResponse, GatewayOptions } from "./types.js";

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

/** The caller of `receive`, waiting for its own turn rather than the queue. */
interface TurnWaiter {
	resolve: (response: AgentResponse) => void;
	reject: (error: Error) => void;
}

/**
 * One gateway instance owns one conversation. All delivery state lives in the
 * conversation's channel.jsonl, so a new instance can resume after a restart.
 */
export class Gateway {
	private readonly options: GatewayOptions;
	private store: ConversationStore | undefined;
	private queue: PendingJob[] = [];
	private active: PendingJob | undefined;
	private wake: (() => void) | undefined;
	private idleWaiters: IdleWaiter[] = [];
	/**
	 * Resolvers keyed by job id. A caller that enqueued a message waits for its
	 * own job; waiting for the queue to drain would hand back whichever turn
	 * happened to finish last.
	 */
	private readonly jobWaiters = new Map<string, TurnWaiter>();
	private stopped = false;
	private abortError: Error | undefined;
	private started = false;
	private loop: Promise<void> | undefined;

	constructor(options: GatewayOptions) {
		this.options = options;
	}

	async start(): Promise<void> {
		if (this.started) throw new Error("gateway is already started");
		this.store = await ConversationStore.open(this.options.conversation, lockOwner());
		// The log decides what is unfinished; this process only schedules it.
		this.queue = this.store.unfinishedJobs();
		this.started = true;
		this.loop = this.processLoop();
		this.maybeSettle();
	}

	/**
	 * Queues one message and resolves with that message's own turn result. Two
	 * callers on one conversation therefore get their own replies, not the last
	 * one to settle.
	 */
	async receive(input: InboundMessage): Promise<AgentResponse> {
		this.ensureRunning();
		const store = this.store;
		if (!store) throw new Error("gateway is not running");
		const job = await store.appendInbound(input);
		const reply = new Promise<AgentResponse>((resolve, reject) => {
			this.jobWaiters.set(job.jobId, { resolve, reject });
		});
		this.queue.push(job);
		this.signalWork();
		return reply;
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
		await this.store?.close();
		this.store = undefined;
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
					this.failWaiters(error);
					break;
				}
				const message = error instanceof Error ? error.message : String(error);
				await this.store?.recordFailed(job, message);
				// A crash between recording the outbound and marking the job done
				// still delivered the reply; the recovery path finishes that job,
				// so the user must not see a second, contradictory message.
				const delivered = this.store?.jobState(job.jobId).outbound !== undefined;
				if (!delivered) {
					await this.options.channel
						.sendError?.({ deliveryId: `error-${job.jobId}`, text: message })
						.catch(() => undefined);
				}
				this.settleJob(job.jobId, { text: "", error: message });
			} finally {
				this.active = undefined;
				this.maybeSettle();
			}
		}
		this.maybeSettle();
	}

	private async runJob(job: PendingJob): Promise<void> {
		const store = this.store;
		if (!store) throw new Error("gateway is not running");
		const state = store.jobState(job.jobId);
		if (state.completed || state.failed) {
			this.settleJob(job.jobId, { text: "" });
			return;
		}
		if (state.outbound) {
			// The response was recorded before the restart, so acknowledge the
			// turn without calling the backend or the channel again.
			await store.recordCompleted(job, state.outbound.recordId);
			this.settleJob(job.jobId, { text: state.outbound.text });
			return;
		}

		// Read before `ready()`: it may move SUSPENDED to IDLE while it checks
		// the control plane, which would erase the evidence of a resume. A
		// suspend still in flight counts too: the actor is going down either
		// way, and this turn is what brings it back.
		const stateBefore = this.options.lifecycle?.state;
		const resumed = stateBefore === "SUSPENDED" || stateBefore === "SUSPENDING";
		if (this.options.lifecycle) {
			// A retry against a suspended actor has to wake it before the prompt
			// is written to the bridge. The router creates or resumes it on the
			// next connect; a failure surfaces as the turn's failure.
			await this.options.lifecycle.ready().catch(() => undefined);
		}
		this.options.lifecycle?.turnStarted();
		// Every exit from here on settles the lifecycle, including a throw. A
		// turn that failed after `turnStarted` would otherwise leave the actor
		// ACTIVE for good, because the idle timer only arms from GRACE.
		try {
			await this.runStartedTurn(store, job, state, resumed);
		} finally {
			this.options.lifecycle?.turnSettled();
		}
	}

	private async runStartedTurn(
		store: ConversationStore,
		job: PendingJob,
		state: JobState,
		resumed: boolean,
	): Promise<void> {
		await this.options.hooks?.beforeSubmit?.();
		// A retry after a crash keeps the original request id.
		const requestId = await store.recordDispatched(job, state.requestId ?? job.jobId);
		const dispatch = store.promptFor(job);

		let streamed = "";
		let previews: Promise<void> = Promise.resolve();
		const startedAt = Date.now();
		let firstTokenMillis: number | undefined;
		const onDelta = (delta: string) => {
			if (this.stopped) return;
			firstTokenMillis ??= Date.now() - startedAt;
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
		if (response.error !== undefined) {
			// The actor reached Pi, Pi reached the provider, and the provider
			// said no. Recording an empty outbound would make the next turn look
			// like a successful silent answer.
			await store.recordFailed(job, response.error);
			await this.options.channel.sendError?.({ deliveryId: requestId, text: response.error });
		} else {
			const remoteMessageId = await this.options.channel.send({
				deliveryId: requestId,
				text: response.text,
				replyToMessageId: dispatch.triggerMessageId,
			});
			await this.options.hooks?.afterChannelSend?.();

			const outbound = await store.recordOutbound(job, response.text, remoteMessageId);
			await this.options.hooks?.afterOutbound?.();
			await store.recordCompleted(job, outbound?.recordId);
		}
		this.options.onTurn?.({
			turnMillis: Date.now() - startedAt,
			firstTokenMillis,
			resumed,
		});
		this.settleJob(job.jobId, response);
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

	/** Hands one turn's result to the caller that queued it. */
	private settleJob(jobId: string, response: AgentResponse): void {
		const waiter = this.jobWaiters.get(jobId);
		if (!waiter) return;
		this.jobWaiters.delete(jobId);
		waiter.resolve(response);
	}

	private failWaiters(error: Error): void {
		for (const waiter of this.jobWaiters.values()) waiter.reject(error);
		this.jobWaiters.clear();
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
