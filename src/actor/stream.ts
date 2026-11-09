import {
  AssistantEntry,
  type Conversation,
  type EntryId,
  type SettledSubmissionRecord,
} from "@earendil-works/pi-durable";
import { type Context } from "@earendil-works/chord/context";

/** A record the gateway receives; the shape is fixed by the WebSocket contract. */
export type Emit = (record: Record<string, unknown>) => void;

export interface TurnResult {
  requestId: string;
  text: string;
  /** Set when the turn ended in a provider error; `text` is then empty. */
  error?: string;
}

/**
 * Streams the assistant's text as `message_update` records. It diffs the live
 * partial on every change, so the gateway sees deltas as the model writes them.
 * Returns a stop function; call it once the turn has settled.
 */
export function streamText(
  conversation: Conversation,
  requestId: string,
  emit: Emit,
  context: Context,
): () => void {
  let sent = "";
  let stopped = false;
  const watching = conversation.watch(context).then((watch) => {
    watch.start(async (call) => {
      if (stopped || call.kind !== "value") return;
      const partial = call.value.docs["pi.live"] as
        | { generation?: { message?: unknown } }
        | undefined;
      const text = textOf(partial?.generation?.message);
      if (text.length > sent.length && text.startsWith(sent)) {
        const delta = text.slice(sent.length);
        sent = text;
        emit({
          type: "message_update",
          requestId,
          assistantMessageEvent: { type: "text_delta", delta },
        });
      }
    });
    return watch;
  });
  return () => {
    stopped = true;
    void watching.then((watch) => watch.stop()).catch(() => undefined);
  };
}

/** The turn's outcome from a settled submission and the assistant entry it produced. */
export async function outcomeOf(
  conversation: Conversation,
  settled: SettledSubmissionRecord,
  requestId: string,
  context: Context,
): Promise<TurnResult> {
  if (settled.status === "unanswered") {
    return { requestId, text: "", error: failureText(settled) };
  }
  const answer = (settled as { answer?: EntryId }).answer;
  const text = answer === undefined ? "" : await assistantTextById(conversation, answer, context);
  return { requestId, text };
}

async function assistantTextById(
  conversation: Conversation,
  id: EntryId,
  context: Context,
): Promise<string> {
  const page = await conversation.entries(
    { minEntryId: id, maxEntryId: id },
    1,
    undefined,
    context,
  );
  const record = page.items.find((item) => item.id === id);
  if (!record || record.kind !== AssistantEntry.kind) return "";
  return textOf((record as { model?: unknown[] }).model?.[0]);
}

/** Joins the text blocks of an assistant message. */
export function textOf(message: unknown): string {
  if (typeof message !== "object" || message === null) return "";
  const content = (message as { content?: unknown }).content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block: unknown) =>
      typeof block === "object" && block !== null && (block as { type?: unknown }).type === "text"
        ? (block as { text?: unknown }).text
        : undefined,
    )
    .filter((text): text is string => typeof text === "string")
    .join("");
}

/** The error text for an unanswered submission. `detail` is JSON, so a non-string is serialized rather than dropped. */
function failureText(settled: { reason: string; detail?: unknown }): string {
  if (typeof settled.detail === "string" && settled.detail.length > 0) return settled.detail;
  if (settled.detail !== undefined) return JSON.stringify(settled.detail);
  return settled.reason || "the model request failed";
}
