import assert from "node:assert/strict";
import test from "node:test";

import { LineFramer, encodeRecord } from "../src/bridge/lines.js";

test("framer splits on LF and keeps U+2028/U+2029 inside records", () => {
	const framer = new LineFramer();
	const tricky = { type: "message", text: "line separator paragraph" };
	const lines = framer.push(`${JSON.stringify(tricky)}\nsecond\n`);
	assert.equal(lines.length, 2);
	assert.deepEqual(JSON.parse(lines[0] ?? ""), tricky);
	assert.equal(lines[1], "second");
});

test("framer reassembles records split across chunks and multibyte characters", () => {
	const framer = new LineFramer();
	const text = "你好，世界";
	const bytes = Buffer.from(`${JSON.stringify({ text })}\n`, "utf8");
	const pieces: string[] = [];
	for (let index = 0; index < bytes.length; index += 3) {
		pieces.push(...framer.push(bytes.subarray(index, index + 3)));
	}
	assert.equal(pieces.length, 1);
	assert.equal(JSON.parse(pieces[0] ?? "").text, text);
});

test("framer accepts CRLF and flushes a trailing unterminated record", () => {
	const framer = new LineFramer();
	assert.deepEqual(framer.push('{"a":1}\r\n'), ['{"a":1}']);
	assert.deepEqual(framer.push('{"b":2}'), []);
	assert.equal(framer.flush(), '{"b":2}');
	assert.equal(framer.flush(), undefined);
});

test("encodeRecord always terminates with exactly one LF", () => {
	assert.equal(encodeRecord({ type: "prompt", message: "hi" }), '{"type":"prompt","message":"hi"}\n');
});
