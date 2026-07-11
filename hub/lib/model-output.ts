/**
 * Model-output sanitization — the single source of truth for the two pieces of
 * assistant-authored metadata/noise that must NEVER reach the user or be fed
 * back to a model as conversation history:
 *
 * 1. The `<!--suggestedTools:["id",…]-->` metadata comment the system prompt
 *    asks the model to append (lib/gemini.ts). Previously four call sites each
 *    carried their own `/<!--suggestedTools:\[.*?\]-->/g` literal, which broke
 *    on trivial formatting drift (a space after `<!--`, a newline inside the
 *    array) — and a comment the strip regex misses renders as visible text in
 *    the chat bubble. The shared regex here tolerates whitespace and newlines.
 *
 * 2. The `⚠️ *Primary model unavailable — using <model>*` degraded-mode banner
 *    the rotation layer injects into the visible stream (lib/gemini.ts). The
 *    banner becomes part of the stored message content, so without stripping
 *    it from history the model sees every prior assistant turn start with the
 *    banner and mimics it — producing the doubled "Primary model unavailable"
 *    lines users saw during provider outages.
 */

/** Tolerant matcher for the suggestedTools metadata comment (global). */
export const SUGGESTED_TOOLS_RE = /<!--\s*suggestedTools\s*:\s*(\[[\s\S]*?\])\s*-->/g

/**
 * Degraded-mode banner line(s), exactly as injected by lib/gemini.ts
 * (`⚠️ *Primary model unavailable — using <name>*\n\n`), plus any blank lines
 * that trail it so stripping doesn't leave a hole at the top of the message.
 */
export const DEGRADED_BANNER_RE = /⚠️\s*\*Primary model unavailable — using [^*\n]+\*\n*/g

/** Remove every suggestedTools metadata comment from `text`. */
export function stripSuggestedTools(text: string): string {
  return text.replace(SUGGESTED_TOOLS_RE, '')
}

/**
 * Extract the raw JSON-array source (`["a","b"]`) of the FIRST suggestedTools
 * comment, or null when none is present. The caller owns JSON.parse + skill-id
 * validation (see app/api/chat/route.ts P1-1).
 */
export function extractSuggestedToolsJson(text: string): string | null {
  // Fresh regex — the exported one is /g and would carry lastIndex state.
  const m = text.match(/<!--\s*suggestedTools\s*:\s*(\[[\s\S]*?\])\s*-->/)
  return m ? m[1] : null
}

/** Remove the degraded-mode banner line(s) from `text`. */
export function stripDegradedBanner(text: string): string {
  return text.replace(DEGRADED_BANNER_RE, '')
}

/**
 * Hide a trailing, still-streaming metadata comment ("<!--suggestedTools:[…"
 * with no closing "-->" yet) so the raw comment never flashes in the chat
 * bubble while the final chunks arrive. Also hides the bare "<!--" / partial
 * "<!--suggestedTo" prefixes that exist for a frame or two mid-stream.
 * Complete comments are left alone (stripSuggestedTools handles those).
 */
export function stripTrailingPartialSuggestedTools(text: string): string {
  const idx = text.lastIndexOf('<!--')
  if (idx === -1) return text
  const tail = text.slice(idx + 4)
  if (tail.includes('-->')) return text
  const probe = tail.trimStart()
  const marker = 'suggestedTools:'
  const head = probe.slice(0, marker.length)
  if (marker.toLowerCase().startsWith(head.toLowerCase())) {
    return text.slice(0, idx)
  }
  return text
}

/**
 * Sanitize an ASSISTANT message's content before it is sent back to any model
 * as conversation history: drop the degraded-mode banner and the metadata
 * comment. Both are harness artifacts, not answer content — leaving them in
 * teaches the model to reproduce them in its next reply.
 */
export function sanitizeAssistantHistoryContent(content: string): string {
  return stripDegradedBanner(stripSuggestedTools(content)).trim()
}
