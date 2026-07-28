/**
 * Tool planning — deciding whether a message needs live analytics, and with
 * what arguments.
 *
 * ── Why a keyword prefilter before the model call ──
 * Planning costs a model round trip. Running one on EVERY chat message would
 * add latency to "what's on my calendar?" and "summarize this thread" — the
 * overwhelming majority of turns, none of which want GA4. The prefilter is
 * deliberately cheap and deliberately generous: a false positive costs one
 * small model call that returns no tool calls, while a false negative means the
 * user gets an answer with no data behind it. So it errs toward asking.
 *
 * ── Why the model picks the arguments ──
 * The date range, metrics and dimensions ARE the question ("organic clicks by
 * page since the redesign"). A keyword matcher cannot derive them. But the
 * model only ever proposes; `executeToolCall` validates names against the
 * property's own metadata and enforces roles and timeouts before anything runs.
 */

import { geminiGenerateText } from '../gemini'
import { toFunctionDeclarations, type ReadTool } from './registry'
import type { ToolCall } from './execute'

/**
 * Terms that suggest a question about site/traffic/search performance.
 *
 * Kept broad on purpose (see the header). "Traffic", "sessions" and "ranking"
 * are unambiguous; "how many people" and "last month" are weak on their own,
 * which is why a match only triggers the planner rather than a Google call.
 */
const ANALYTICS_HINTS =
  /\b(analytics|ga4|google analytics|search console|gsc|seo|traffic|sessions?|visitors?|pageviews?|page views?|bounce|conversions?|impressions?|clicks?|click-through|ctr|keywords?|queries|ranking|rank|organic|referrals?|acquisition|landing pages?)\b/i

/** True when a message is worth planning tools for. */
export function looksAnalytical(message: string): boolean {
  return ANALYTICS_HINTS.test(message)
}

const PLANNER_SYSTEM = `You convert a business question into calls to read-only analytics tools.

Rules:
- Reply with JSON ONLY — no prose, no markdown fences.
- Shape: {"calls":[{"name":"<tool>","args":{...}}]}
- Return {"calls":[]} if the question does not need analytics data, or if you cannot
  express it with the tools given.
- Never invent tool names or argument names beyond those declared.
- Prefer ONE well-chosen call. Use at most two, and only when the question genuinely
  spans both site analytics and search performance.
- Resolve relative dates ("last month", "this week") against the current date given below.`

/** Strip markdown fencing a model may add despite being told not to. */
export function extractJson(text: string): string {
  const trimmed = text.trim()
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/)
  if (fenced) return fenced[1].trim()
  // Fall back to the outermost braces, so leading prose doesn't break parsing.
  const first = trimmed.indexOf('{')
  const last = trimmed.lastIndexOf('}')
  return first >= 0 && last > first ? trimmed.slice(first, last + 1) : trimmed
}

/**
 * Parse the planner's reply into tool calls. Never throws: an unparseable or
 * malformed plan yields no calls, so the turn proceeds without live data rather
 * than failing.
 */
export function parsePlan(text: string): ToolCall[] {
  try {
    const parsed = JSON.parse(extractJson(text)) as { calls?: unknown }
    if (!Array.isArray(parsed.calls)) return []
    return parsed.calls
      .filter((c): c is { name: string; args: unknown } =>
        !!c && typeof c === 'object' && typeof (c as { name?: unknown }).name === 'string',
      )
      .map(c => ({ name: c.name, args: (c as { args?: unknown }).args ?? {} }))
  } catch {
    return []
  }
}

/**
 * Ask the model which tools to run for this question.
 *
 * Returns an empty list — never throws — when planning is unnecessary, the
 * model is unavailable, or the reply is unusable. A chat turn must not fail
 * because the optional data-gathering step did.
 */
export async function planToolCalls(
  message: string,
  tools: readonly ReadTool[],
  now: Date = new Date(),
): Promise<ToolCall[]> {
  if (!tools.length || !looksAnalytical(message)) return []

  const declarations = toFunctionDeclarations(tools)
  const system = [
    PLANNER_SYSTEM,
    `Current date: ${now.toISOString().slice(0, 10)}`,
    `Available tools:\n${JSON.stringify(declarations, null, 2)}`,
  ].join('\n\n')

  try {
    const { text } = await geminiGenerateText(system, message)
    return parsePlan(text)
  } catch (err) {
    console.warn('[ai-tools] tool planning failed; answering without live data:', err)
    return []
  }
}
