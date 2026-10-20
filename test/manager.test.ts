import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { GatewayManager } from "../src/host/manager.js";
import { ActorProvisioner, actorNameFor } from "../src/host/substrate/provisioner.js";

async function tempRoot(t: test.TestContext): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "pi-manager-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	return root;
}

test("actor names are deterministic and legal", () => {
	assert.equal(actorNameFor("local/chat"), "pi-local-chat");
	assert.equal(actorNameFor("Team Alpha/General"), "pi-team-alpha-general");
	assert.equal(actorNameFor("///"), "pi-conversation");
	assert.ok(actorNameFor("x".repeat(100)).length <= 43);
	assert.equal(actorNameFor("local/chat"), actorNameFor("local/chat"));
});

test("a provisioned actor exists before its egress policy is applied", async () => {
	const calls: string[] = [];
	const actors = new ActorProvisioner({
		atespace: "pi-agents",
		control: {
			async ensure(actor) {
				calls.push(`ensure ${actor.atespace}/${actor.name}`);
			},
			async suspend() {},
			async state() {
				return "running" as const;
			},
		},
		applyEgress: async (actor) => {
			calls.push(`egress ${actor.atespace}/${actor.name}`);
		},
	});

	const actor = await actors.provision("local/chat");
	assert.deepEqual(actor, { atespace: "pi-agents", name: "pi-local-chat" });
	assert.deepEqual(calls, ["ensure pi-agents/pi-local-chat", "egress pi-agents/pi-local-chat"]);
});

test("the manager keeps one actor per conversation and isolates failures", async (t) => {
	const root = await tempRoot(t);
	const ensured: string[] = [];
	const manager = new GatewayManager({
		dataDir: root,
		actorUrl: "ws://127.0.0.1:1",
		actors: new ActorProvisioner({
			atespace: "pi-agents",
			control: {
				async ensure(actor) {
					ensured.push(actor.name);
				},
				async suspend() {},
				async state() {
					return "running" as const;
				},
			},
		}),
	});

	const spec = (conversationId: string) => ({
		conversationId,
		idleMs: 60_000,
	});

	const a = await manager.ensure(spec("local/a"));
	const again = await manager.ensure(spec("local/a"));
	assert.equal(a, again, "the same conversation is opened once");
	const b = await manager.ensure(spec("local/b"));
	assert.notEqual(a.actor.name, b.actor.name, "conversations never share an actor");
	assert.deepEqual(ensured.sort(), ["pi-local-a", "pi-local-b"]);

	// A conversation that never opened reports a clear error and leaves the
	// others untouched.
	await assert.rejects(
		manager.receive("local/missing", { userId: "u", text: "hi" }),
		/unknown conversation/,
	);

	await manager.close();
});

