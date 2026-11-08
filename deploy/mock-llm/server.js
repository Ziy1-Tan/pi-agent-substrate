import { createServer } from "node:http";

/**
 * An OpenAI-compatible mock for the clustered e2e. It answers /models and
 * streams /chat/completions in small chunks, so the reply exercises the same
 * streaming path a real provider does without spending tokens.
 *
 * The reply is scripted from the last user message:
 *
 *   containing "printf <path>"  -> emit one bash tool call that runs it
 *   containing "cat <path>"     -> emit one bash tool call that reads it
 *   otherwise                   -> plain text
 *
 * After a tool result comes back the next request answers with text, which is
 * what a real model does. The turn counter in the reply makes session
 * continuity observable from the e2e.
 */
const text = process.env.MOCK_TEXT ?? "Hello from the mock model.";
const port = Number(process.env.MOCK_PORT ?? 8080);

const server = createServer((request, response) => {
	let body = "";
	request.on("data", (chunk) => (body += chunk));
	request.on("end", () => {
		if (request.url?.endsWith("/models")) {
			response.writeHead(200, { "content-type": "application/json" });
			response.end(JSON.stringify({ object: "list", data: [{ id: "mock-model", object: "model" }] }));
			return;
		}
		if (!request.url?.endsWith("/chat/completions")) {
			response.writeHead(404).end();
			return;
		}

		const payload = JSON.parse(body || "{}");
		const messages = payload.messages ?? [];
		const users = messages.filter((message) => message.role === "user");
		const lastUser = users.at(-1);
		const lastText = flatten(lastUser?.content);
		// Only the current turn matters: a tool result earlier in the session
		// must not suppress the tool call this turn is supposed to make.
		const lastUserIndex = messages.map((message) => message.role).lastIndexOf("user");
		const toolResultSeen = messages.slice(lastUserIndex + 1).some((message) => message.role === "tool");

		console.log(
			`request: ${users.length} user message(s), last=${JSON.stringify(lastText).slice(0, 160)}, tool=${toolResultSeen}`,
		);

		let reply;
		const toolCall = toolResultSeen ? undefined : pickToolCall(lastText);
		if (toolCall) {
			reply = { toolCall, text: "" };
		} else {
			reply = { text: `${text} [turn ${users.length}]` };
		}

		response.writeHead(200, {
			"content-type": "text/event-stream",
			"cache-control": "no-cache",
			connection: "keep-alive",
		});
		writeChunks(response, reply);
	});
});

function flatten(content) {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((block) => block?.type === "text" && typeof block.text === "string")
		.map((block) => block.text)
		.join(" ");
}

function pickToolCall(prompt) {
	const write = prompt.match(/printf\s+'([^']+)'\s*>\s*(\S+)/);
	if (write) return { command: `printf '${write[1]}' > ${write[2]}` };
	const read = prompt.match(/cat\s+(\S+)/);
	if (read) return { command: `cat ${read[1]}` };
	return undefined;
}

function writeChunks(response, reply) {
	// Tool arguments stream as a toolcall delta; text streams as content deltas.
	if (reply.toolCall) {
		const call = {
			id: "call_mock_1",
			type: "function",
			function: { name: "bash", arguments: JSON.stringify({ command: reply.toolCall.command }) },
		};
		send(response, { tool_calls: [{ index: 0, ...call }] });
		send(response, {}, "tool_calls");
		return;
	}
	const chunks = reply.text.match(/.{1,4}/gu) ?? [reply.text];
	let index = 0;
	const timer = setInterval(() => {
		if (index >= chunks.length) {
			clearInterval(timer);
			send(response, {}, "stop");
			return;
		}
		send(response, { content: chunks[index++] });
	}, 20);
}

function send(response, delta, finishReason = null) {
	response.write(
		`data: ${JSON.stringify({
			id: "mock-1",
			object: "chat.completion.chunk",
			created: 1,
			model: "mock-model",
			choices: [{ index: 0, delta, finish_reason: finishReason }],
		})}\n\n`,
	);
	if (finishReason !== null) response.end("data: [DONE]\n\n");
}

server.listen(port, "0.0.0.0", () => {
	console.log(`mock LLM listening on :${port}`);
});
