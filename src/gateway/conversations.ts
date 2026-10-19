import { mkdir } from "node:fs/promises";
import { join } from "node:path";

import type {
	ConfiguredChannel,
	ResolvedConversation,
	TestAccountConfig,
} from "../../third_party/pi-chat/types.js";

function sanitize(value: string): string {
	return value.replace(/[^a-zA-Z0-9._-]+/g, "_");
}

/**
 * Builds the storage layout pi-chat's runtime expects for a conversation.
 * Both the gateway entry point and the tests create conversations through
 * this, so the log, workspace and lock paths cannot drift apart.
 */
export async function createConversation(
	rootDir: string,
	conversationId = "test/chat",
): Promise<ResolvedConversation> {
	const [accountId, channelKey] = conversationId.split("/");
	if (!accountId || !channelKey) throw new Error(`invalid conversation id: ${conversationId}`);
	const accountDir = join(rootDir, "accounts", sanitize(accountId));
	const conversationDir = join(accountDir, "channels", sanitize(channelKey));
	const workspaceDir = join(conversationDir, "workspace");
	await mkdir(accountDir, { recursive: true });
	await mkdir(workspaceDir, { recursive: true });

	const channel: ConfiguredChannel = {
		id: `test-${channelKey}`,
		name: channelKey,
		dm: true,
	};
	const account: TestAccountConfig = {
		service: "test",
		name: "test",
		channels: { [channelKey]: channel },
	};

	return {
		service: "test",
		botName: "pi",
		accountId,
		account,
		channelKey,
		channel,
		conversationId,
		conversationName: `test / ${channelKey}`,
		access: {},
		gondolinSecrets: {},
		accountDir,
		sharedDir: join(accountDir, "shared"),
		conversationDir,
		workspaceDir,
		gondolinDir: join(conversationDir, "gondolin"),
		accountMemoryPath: join(accountDir, "shared", "memory.md"),
		channelMemoryPath: join(workspaceDir, "memory.md"),
		logPath: join(conversationDir, "channel.jsonl"),
		filesDir: join(workspaceDir, "incoming"),
		lockPath: join(conversationDir, ".lock"),
	};
}
