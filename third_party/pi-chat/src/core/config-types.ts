// Modified from earendil-works/pi-chat at 9adbd29 for pi-agent-substrate, 2026-10-18.
// Adds the "test" service so the standalone gateway can persist test-channel
// conversations through the unmodified runtime. No test adapter ships in src/.
export type ChatService = "telegram" | "discord" | "test";

export type TriggerMode = "mention" | "message";

export interface AccessPolicy {
	trigger?: TriggerMode;
	ignoreBots?: boolean;
	allowedUserIds?: string[];
	allowedRoleIds?: string[];
}

export interface GondolinSecretConfig {
	value: string;
	hosts: string[];
}

export interface GondolinConfig {
	secrets?: Record<string, GondolinSecretConfig>;
}

export interface ConfiguredChannel {
	id: string;
	name?: string;
	dm?: boolean;
	access?: AccessPolicy;
	gondolin?: GondolinConfig;
}

export interface BaseAccountConfig {
	service: ChatService;
	name?: string;
	access?: AccessPolicy;
	gondolin?: GondolinConfig;
	channels: Record<string, ConfiguredChannel>;
}

export interface TelegramAccountConfig extends BaseAccountConfig {
	service: "telegram";
	botToken: string;
	botUsername?: string;
	botUserId?: string;
}

export interface DiscordAccountConfig extends BaseAccountConfig {
	service: "discord";
	botToken: string;
	applicationId: string;
	serverId: string;
	serverName: string;
	botUserId?: string;
	botUsername?: string;
}

export interface TestAccountConfig extends BaseAccountConfig {
	service: "test";
}

export type ChatAccountConfig = TelegramAccountConfig | DiscordAccountConfig | TestAccountConfig;

export interface ChatConfig {
	botName?: string;
	gondolin?: GondolinConfig;
	accounts: Record<string, ChatAccountConfig>;
}

export interface ResolvedConversation {
	service: ChatService;
	botName: string;
	accountId: string;
	account: ChatAccountConfig;
	channelKey: string;
	channel: ConfiguredChannel;
	conversationId: string;
	conversationName: string;
	access: AccessPolicy;
	gondolinSecrets: Record<string, GondolinSecretConfig>;
	accountDir: string;
	sharedDir: string;
	conversationDir: string;
	workspaceDir: string;
	gondolinDir: string;
	accountMemoryPath: string;
	channelMemoryPath: string;
	logPath: string;
	filesDir: string;
	lockPath: string;
}
