import { execFile } from "node:child_process";
import { promisify } from "node:util";

import type { ActorControl, ActorRef, ActorState } from "./control.js";

const run = promisify(execFile);

export interface KubectlAteControlOptions {
	/** Template `ensure` creates a missing actor from. */
	template: string;
	log?: (message: string) => void;
}

/** ActorControl over the `kubectl-ate` that the gateway image carries. */
export class KubectlAteControl implements ActorControl {
	private readonly template: string;
	private readonly log: (message: string) => void;

	constructor(options: KubectlAteControlOptions) {
		this.template = options.template;
		this.log = options.log ?? (() => undefined);
	}

	async ensure(actor: ActorRef): Promise<void> {
		const state = await this.state(actor);
		if (state !== "unknown") return;
		try {
			await this.call([
				"create",
				"actor",
				actor.name,
				"-a",
				actor.atespace,
				"--template",
				this.template,
			]);
			this.log(`created actor ${actor.atespace}/${actor.name}`);
		} catch (error) {
			if (!errorText(error).includes("AlreadyExists")) throw error;
		}
	}

	async suspend(actor: ActorRef): Promise<void> {
		try {
			await this.call(["suspend", "actor", actor.name, "-a", actor.atespace]);
		} catch (error) {
			// Suspending an already-suspended or deleted actor is the desired
			// end state either way.
			const text = errorText(error);
			if (text.includes("AlreadyExists") || text.includes("SUSPENDED") || text.includes("not found")) return;
			throw error;
		}
	}

	async state(actor: ActorRef): Promise<ActorState> {
		try {
			const stdout = await this.call(["get", "actors", actor.name, "-a", actor.atespace, "-o", "json"]);
			return parseActorState(stdout);
		} catch (error) {
			if (errorText(error).includes("NotFound")) return "unknown";
			throw error;
		}
	}

	/** Applies the actor's egress policy; one that already exists is kept. */
	async applyEgress(actor: ActorRef, manifest: string): Promise<void> {
		try {
			await this.call(["create", "egress-policy", actor.name, "-a", actor.atespace, "-f", manifest]);
			this.log(`applied egress policy to ${actor.atespace}/${actor.name}`);
		} catch (error) {
			if (!errorText(error).includes("AlreadyExists")) throw error;
		}
	}

	private async call(args: string[]): Promise<string> {
		const { stdout } = await run("kubectl-ate", args, { maxBuffer: 16 * 1024 * 1024 });
		return stdout;
	}
}

/** `ACTOR_STATE_RUNNING` -> `running`, in the vocabulary the lifecycle uses. */
function parseActorState(stdout: string): ActorState {
	const parsed = JSON.parse(stdout) as {
		actors?: Array<{ status?: { state?: string } }>;
		status?: { state?: string };
	};
	const raw = (Array.isArray(parsed.actors) ? parsed.actors[0]?.status?.state : parsed.status?.state) ?? "";
	switch (raw) {
		case "ACTOR_STATE_RUNNING":
			return "running";
		case "ACTOR_STATE_SUSPENDED":
			return "suspended";
		case "ACTOR_STATE_SUSPENDING":
			return "suspending";
		case "ACTOR_STATE_CRASHED":
			return "crashed";
		default:
			return "unknown";
	}
}

function errorText(error: unknown): string {
	if (error instanceof Error) {
		const stderr = (error as Error & { stderr?: string }).stderr ?? "";
		return `${error.message}\n${stderr}`;
	}
	return String(error);
}
