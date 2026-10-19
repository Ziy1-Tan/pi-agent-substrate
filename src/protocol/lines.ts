/**
 * Strict LF framing shared by the bridge and the gateway relay.
 *
 * Pi's RPC mode splits records on `\n` only. Node's `readline` also splits on
 * U+2028/U+2029, which are legal inside JSON strings, so it is unusable here.
 * This splitter keeps bytes until a 0x0a arrives and decodes each record once,
 * which also keeps multi-byte characters intact across chunk boundaries.
 */
export class LineFramer {
	private pending: Buffer = Buffer.alloc(0);

	push(chunk: Buffer | string): string[] {
		const bytes = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk;
		this.pending = this.pending.length === 0 ? bytes : Buffer.concat([this.pending, bytes]);
		const lines: string[] = [];
		let start = 0;
		for (;;) {
			const end = this.pending.indexOf(0x0a, start);
			if (end === -1) break;
			lines.push(decodeRecord(this.pending.subarray(start, end)));
			start = end + 1;
		}
		this.pending = start === 0 ? this.pending : this.pending.subarray(start);
		return lines;
	}

	/** Returns whatever remains; only valid when the peer closed the stream. */
	flush(): string | undefined {
		if (this.pending.length === 0) return undefined;
		const rest = decodeRecord(this.pending);
		this.pending = Buffer.alloc(0);
		return rest;
	}
}

function decodeRecord(bytes: Buffer): string {
	const text = bytes.toString("utf8");
	return text.endsWith("\r") ? text.slice(0, -1) : text;
}

export function encodeRecord(value: unknown): string {
	return `${JSON.stringify(value)}\n`;
}

export function parseRecord(line: string): unknown {
	try {
		return JSON.parse(line) as unknown;
	} catch {
		return undefined;
	}
}
