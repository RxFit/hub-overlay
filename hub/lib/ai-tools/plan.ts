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
import { claudeChat, isClaudeConfigured } from '../claude'
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

/**
 * Terms that suggest a question answerable from Drive documents or Chat history.
 *
 * Broader than the analytics filter by necessity: "who is our account manager
 * at Nuvita?" contains no workspace vocabulary at all. So this also fires on
 * shape — a who/what/when question, or a reference to something said or written
 * — accepting false positives. The asymmetry is the same as for analytics: a
 * false positive costs one small planner call that returns no tools, while a
 * false negative is the original bug (the assistant declaring it cannot see
 * Drive or Chat when in fact it could have looked).
 */
const WORKSPACE_HINTS =
  /\b(document|doc|docs|file|files|drive|folder|spreadsheet|sheet|contract|agreement|proposal|invoice|report|notes?|minutes|memo|deck|chat|space|spaces|message|messages|thread|conversation|said|says|told|discussed|mentioned|agreed|decided|contact|account manager|point of contact|who is|who are|what did|when did|where did|status of|update on)\b/i

/** True when a message might be answerable from Drive or Chat content. */
export function looksWorkspaceRelated(message: string): boolean {
  return WORKSPACE_HINTS.test(message)
}

/**
 * Should we spend a planner call on this message, given the tools on offer?
 *
 * Each group carries its own prefilter, and a match on ANY represented group is
 * enough. Deriving this from the tool set rather than hardcoding one filter is
 * what lets a new group be added without the planner silently refusing to plan
 * for it.
 */
export function shouldPlan(message: string, tools: readonly ReadTool[]): boolean {
  const groups = new Set(tools.map(t => t.group))
  if (groups.has('analytics') && looksAnalytical(message)) return true
  if (groups.has('workspace') && looksWorkspaceRelated(message)) return true
  return false
}

const PLANNER_SYSTEM = `You convert a business question into calls to read-only data tools.

Rules:
- Reply with JSON ONLY — no prose, no markdown fences.
- Shape: {"calls":[{"name":"<tool>","args":{...}}]}
- Return {"calls":[]} if the question does not need looked-up data, or if you cannot
  express it with the tools given. This is a common and correct answer — greetings,
  follow-ups answerable from the conversation, and requests to WRITE or SEND something
  all take no tools.
- Never invent tool names or argument names beyond those declared.
- Prefer ONE well-chosen call. Use at most two, and only when the question genuinely
  spans two sources (for example site analytics and search performance, or a document
  and a chat conversation).
- Pass KEYWORDS as search queries, not the user's whole sentence. For "who is our
  account manager at Nuvita?" search for "account manager contact", scoped to Nuvita.
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
  if (!tools.length || !shouldPlan(message, tools)) return []

  const declarations = toFunctionDeclarations(tools)
  const system = [
    PLANNER_SYSTEM,
    `Current date: ${now.toISOString().slice(0, 10)}`,
    `Available tools:\n${JSON.stringify(declarations, null, 2)}`,
  ].join('\n\n')

  try {
    return parsePlan(await planWithFallback(system, message))
  } catch (err) {
    console.warn('[ai-tools] tool planning failed; answering without live data:', err)
    return []
  }
}

/**
 * Run the planner against Gemini, falling back to Claude.
 *
 * WHY THIS EXISTS — this was a real, user-visible failure. Planning ran on
 * Gemini ONLY. The chat stream has cross-provider failover (it rotates to
 * Claude and says so with a "Primary model unavailable" banner), but planning
 * did not: when the Gemini chain was down or in cooldown, `geminiGenerateText`
 * threw, planning returned no calls, and every read tool silently vanished.
 *
 * The user saw the assistant answer a "who is our account manager at Nuvita?"
 * question from a web search and then OFFER to check Drive and Chat — with the
 * fallback banner sitting at the top of the very same reply. Tools disappeared
 * at precisely the moment the banner announced why, which is the worst possible
 * time: a degraded primary model is when grounded data matters most.
 *
 * Claude is the same provider the stream itself falls back to, so this adds no
 * new dependency — it just gives planning the failover the answer already had.
 */
async function planWithFallback(system: string, message: string): Promise<string> {
  try {
    const { text } = await geminiGenerateText(system, message)
    return text
  } catch (geminiErr) {
    if (!isClaudeConfigured()) throw geminiErr
    console.warn('[ai-tools] Gemini planning unavailable — falling back to Claude:', geminiErr)
    // Haiku is the default and is the right tier here: emitting a small JSON
    // object from an explicit tool list is not a reasoning-heavy task, and the
    // executor validates everything it proposes anyway.
    return claudeChat(
      // id/timestamp are part of the Hub's ChatMessage shape but carry no
      // meaning for a one-shot planning call; they are filled to satisfy it.
      [{ id: 'planner', role: 'user', content: message, timestamp: '' }],
      system,
      { maxTokens: 1024 },
    )
  }
}
