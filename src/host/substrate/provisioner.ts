import type { ActorControl, ActorRef } from "./control.js";

/** `local/chat` -> `pi-local-chat`. Stable, and legal as a Kubernetes name. */
export function actorNameFor(conversationId: string): string {
	const sanitized = conversationId
		.toLowerCase()
		.replace(/[^a-z0-9-]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 40);
	return `pi-${sanitized || "conversation"}`;
}

export interface ActorProvisionerOptions {
	atespace: string;
	control: ActorControl;
	/**
	 * Gives a freshly created actor its egress rules. Egress policies are
	 * per-actor, so an actor created without one cannot reach the model and
	 * every turn fails with an empty reply.
	 */
	applyEgress?: (actor: ActorRef) => Promise<void>;
}

/**
 * Places a conversation on its own actor and makes sure that actor exists
 * and can reach the model before the first turn. The router only resumes
 * actors that exist, so this runs when a conversation opens.
 */
export class ActorProvisioner {
	readonly control: ActorControl;
	private readonly atespace: string;
	private readonly applyEgress: ((actor: ActorRef) => Promise<void>) | undefined;

	constructor(options: ActorProvisionerOptions) {
		this.atespace = options.atespace;
		this.control = options.control;
		this.applyEgress = options.applyEgress;
	}

	async provision(conversationId: string): Promise<ActorRef> {
		const actor: ActorRef = { atespace: this.atespace, name: actorNameFor(conversationId) };
		await this.control.ensure(actor);
		await this.applyEgress?.(actor);
		return actor;
	}
}
