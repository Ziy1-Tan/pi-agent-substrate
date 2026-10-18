import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";

import { EchoBackend } from "../../src/backend/echo.js";
import { Gateway } from "../../src/gateway/gateway.js";
import { TestChannel } from "../support/test-channel.js";
import { createTestConversation } from "../support/test-conversation.js";

const dataDir = process.env.PI_GATEWAY_DATA_DIR ?? (await mkdtemp(join(tmpdir(), "pi-gateway-demo-")));
const conversation = await createTestConversation(dataDir);
const channel = new TestChannel({ onSend: (message) => console.log(`bot> ${message.text}`) });
const gateway = new Gateway({ conversation, channel, backend: new EchoBackend({ chunkSize: 3 }) });

await gateway.start();
console.log(`M1 echo gateway. Log: ${conversation.logPath}`);
console.log("Type a message. Ctrl+D exits.");

const readline = createInterface({ input: process.stdin, output: process.stdout });
readline.setPrompt("you> ");
readline.prompt();
for await (const line of readline) {
	if (line.trim().length > 0) {
		await gateway.receive({ userId: "local", userName: "you", text: line.trim() });
		await gateway.waitForIdle();
	}
	readline.prompt();
}
readline.close();
await gateway.stop();
