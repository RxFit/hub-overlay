/**
 * History bounding for the chat route (W1-#7).
 *
 * Every turn the client POSTs the ENTIRE message array, and the route feeds it
 * to the model. Token cost + latency grow linearly with session length, and a
 * long session eventually blows the model's context window. To bound that, we
 * keep a simple RECENCY WINDOW — the most recent N messages.
 *
 * The system prompt is assembled separately server-side (buildSystemPrompt) and
 * is NOT part of `messages`, so there is nothing to preserve at the head here.
 * Summarization of the dropped tail is intentionally OUT OF SCOPE for this pass:
 * a naive per-turn LLM summary would add latency + cost on every request and
 * needs its own design. Follow-up: summarize the dropped prefix instead of
 * discarding it.
 */

/** Number of most-recent messages forwarded to the model. Exported so it's tunable/testable. */
export const MAX_HISTORY_MESSAGES = 20

/**
 * Bound a chat history to the most recent `max` messages.
 *
 * - `messages.length <= max` → returned as-is (same array reference).
 * - Otherwise → the last `max` messages, in order (so the array still ends with
 *   the latest user message).
 * - Empty input → empty output.
 * - `max <= 0` → the last message only (never zero: the route's Zod requires >=1).
 */
export function boundHistory<T extends { role: string }>(
  messages: T[],
  max = MAX_HISTORY_MESSAGES,
): T[] {
  if (messages.length === 0) return messages
  // Never forward zero messages — the route's Zod schema requires >= 1.
  if (max <= 0) return messages.slice(-1)
  if (messages.length <= max) return messages
  return messages.slice(-max)
}
