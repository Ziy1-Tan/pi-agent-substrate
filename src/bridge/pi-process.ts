import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

import { LineFramer, encodeRecord } from "../protocol/lines.js";
import {
	assistantOutcome,
	isAgentSettled,
	isRpcResponse,
	isTextDelta,
	retryFailure,
	type RpcState,
} from "../protocol/rpc.js";

export interface PiProcessOptions {
	command: string;
	args: string[];
	cwd?: string;
	env?: NodeJS.ProcessEnv;
	onStderr?: (line: string) => void;
	onEvent: (event: unknown) => void;
	/** Called once per child exit, after the final stdout record is flushed. */
	onExit: (code: number | null, signal: NodeJS.Signals | null) => void;
	/** Called after every successful start, so callers can drop stale state. */
	onStart?: () => void;
}

/**
 * Owns one `pi --mode rpc` child. stdout is protocol only: every record is
 * framed on LF and forwarded untouched. stderr is diagnostics and never enters
 * the protocol stream.
 */
export class PiProcess {
	private readonly framer = new LineFramer();
	private readonly errFramer = new LineFramer();
	private child: ChildProcessWithoutNullStreams | undefined;

	constructor(private readonly options: PiProcessOptions) {}

	get pid(): number | undefined {
		return this.child?.pid;
	}

	get ready(): boolean {
		return this.child !== undefined && this.child.exitCode === null;
	}

	start(): void {
		if (this.child) throw new Error("pi process is already started");
		const child = spawn(this.options.command, this.options.args, {
			cwd: this.options.cwd,
			env: this.options.env ?? process.env,
			stdio: ["pipe", "pipe", "pipe"],
		});
		this.child = child;
		this.options.onStart?.();
		child.stdout.on("data", (chunk: Buffer) => {
			for (const line of this.framer.push(chunk)) {
				const event = safeParse(line);
				if (event !== undefined) this.options.onEvent(event);
			}
		});
		child.stderr.on("data", (chunk: Buffer) => {
			for (const line of this.errFramer.push(chunk)) this.options.onStderr?.(line);
		});
		child.on("error", (error) => {
			this.options.onStderr?.(`pi spawn error: ${error.message}`);
		});
		child.on("exit", (code, signal) => {
			if (this.child === child) this.child = undefined;
			const rest = this.framer.flush();
			if (rest !== undefined) {
				const event = safeParse(rest);
				if (event !== undefined) this.options.onEvent(event);
			}
			this.options.onExit(code, signal);
		});
	}

	send(command: Record<string, unknown>): void {
		const child = this.child;
		if (!child || child.exitCode !== null) throw new Error("pi process is not running");
		child.stdin.write(encodeRecord(command));
	}

	async stop(timeoutMs = 3_000): Promise<void> {
		const child = this.child;
		if (!child || child.exitCode !== null) return;
		this.child = undefined;
		child.stdin.end();
		child.kill("SIGTERM");
		await new Promise<void>((resolve) => {
			const timer = setTimeout(() => {
				child.kill("SIGKILL");
				resolve();
			}, timeoutMs);
			child.once("exit", () => {
				clearTimeout(timer);
				resolve();
			});
		});
	}
}

/**
 * The slice of Pi state a resumed client needs, derived only from the event
 * stream. It survives a snapshot restore because it is rebuilt from the same
 * stream, not from process memory.
 */
export class PiActivity {
	streaming = false;
	sessionId: string | undefined;
	sessionFile: string | undefined;
	messageCount: number | undefined;
	pendingMessageCount: number | undefined;
	text = "";
	private lastAssistantText: string | undefined;
	/** Set when the turn ended in a provider error rather than a reply. */
	private failure: string | undefined;

	beginTurn(): void {
		this.streaming = true;
		this.text = "";
		this.lastAssistantText = undefined;
		this.failure = undefined;
	}

	/** Drops stream state after a child restart, keeping session metadata. */
	resetStream(): void {
		this.beginTurn();
		this.streaming = false;
	}

	observe(event: unknown): void {
		if (isTextDelta(event)) this.text += event.assistantMessageEvent.delta;
		// Each finished assistant message supersedes the outcome before it: a
		// retry that eventually returns text clears the failure that started it.
		const outcome = assistantOutcome(event);
		if (outcome) {
			if (outcome.text !== undefined) this.lastAssistantText = outcome.text;
			this.failure = outcome.error;
		}
		const exhausted = retryFailure(event);
		if (exhausted !== undefined) this.failure = exhausted;
		if (isAgentSettled(event)) this.streaming = false;
		if (isRpcResponse(event) && event.command === "get_state" && event.success) {
			const data = event.data as RpcState | undefined;
			this.streaming = data?.isStreaming ?? this.streaming;
			this.sessionId = data?.sessionId ?? this.sessionId;
			this.sessionFile = data?.sessionFile ?? this.sessionFile;
			this.messageCount = data?.messageCount ?? this.messageCount;
			this.pendingMessageCount = data?.pendingMessageCount ?? this.pendingMessageCount;
		}
	}

	/** The turn's outcome once `agent_settled` arrives; undefined before that. */
	settled(event: unknown): { text: string; error?: string } | undefined {
		if (!isAgentSettled(event)) return undefined;
		return this.failure === undefined
			? { text: this.lastAssistantText ?? this.text }
			: { text: "", error: this.failure };
	}

	snapshot(): {
		streaming: boolean;
		sessionId?: string;
		sessionFile?: string;
		messageCount?: number;
		pendingMessageCount?: number;
		text: string;
	} {
		return {
			streaming: this.streaming,
			sessionId: this.sessionId,
			sessionFile: this.sessionFile,
			messageCount: this.messageCount,
			pendingMessageCount: this.pendingMessageCount,
			text: this.text,
		};
	}
}

function safeParse(line: string): unknown {
	try {
		return JSON.parse(line) as unknown;
	} catch {
		return undefined;
	}
}
