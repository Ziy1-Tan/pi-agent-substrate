import { readFile } from "node:fs/promises";

import type { ChatLogRecord } from "../../third_party/pi-chat/types.js";

export async function readRecords(logPath: string): Promise<ChatLogRecord[]> {
	try {
		const content = await readFile(logPath, "utf8");
		return content
			.split("\n")
			.filter((line) => line.trim().length > 0)
			.map((line) => JSON.parse(line) as ChatLogRecord);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw error;
	}
}

export function recordTypes(records: ChatLogRecord[]): string[] {
	return records.map((record) => record.type);
}
