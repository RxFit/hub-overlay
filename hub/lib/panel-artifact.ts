/**
 * Tool-panel artifact parse-trigger helper.
 *
 * The 11 tool panels (DecisionMemo, IssueTree, …) parse the assistant's output
 * into artifact sections inside a `useEffect`. That effect used to key on
 * `messages.length`, but streaming fills the just-added assistant bubble's
 * CONTENT without changing the array length — so the artifact from the turn that
 * just streamed was not parsed until the NEXT message arrived (one turn late).
 *
 * Keying the effect on the last assistant message's CONTENT instead fixes the
 * staleness: it changes on every streamed chunk (re-parse follows the stream)
 * and stabilizes once streaming ends (no infinite re-parse — the value stops
 * changing, so the effect stops firing).
 */
export function lastAssistantContent(
  messages: ReadonlyArray<{ role: 'user' | 'assistant'; content: string }>,
): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'assistant') return messages[i].content
  }
  return ''
}
