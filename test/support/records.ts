import { readFile } from "node:fs/promises";

import type { ConversationRecord } from "../../src/host/conversation/records.js";

export async function readRecords(logPath: string): Promise<ConversationRecord[]> {
	try {
		const content = await readFile(logPath, "utf8");
		return content
			.split("\n")
			.filter((line) => line.trim().length > 0)
			.map((line) => JSON.parse(line) as ConversationRecord);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw error;
	}
}

export function recordTypes(records: ConversationRecord[]): string[] {
	return records.map((record) => record.type);
}
