/**
 * One entry point the chat route calls to turn a question into live data
 * (SERVER-ONLY — reads tenant prefs from the database).
 *
 * plan → execute → render, with every step already guarded by its own module.
 *
 * ── Why this runs BEFORE the stream opens ──
 * The design sketch (§7) put the tool loop inside the streaming generator,
 * emitting `tool_status` SSE events mid-stream. That generator carries the idle
 * watchdog, model-rotation cooldowns, abort plumbing and provider failover —
 * the most failure-sensitive code in the app. Resolving tools first and handing
 * the results in as context achieves the same answer quality while leaving all
 * of that untouched. The visible cost is that the user waits slightly longer
 * for the first token instead of seeing "Querying GA4…"; the benefit is that a
 * tool problem can never wedge a stream mid-flight.
 *
 * Never throws. Live data is an enhancement to the turn, not a precondition for
 * it: if planning, a Google call, or the prefs lookup fails, the user still
 * gets an answer — just without figures.
 */

import { planToolCalls } from './plan'
import { executeToolCalls, renderToolOutcomes } from './execute'
import { toolsFor } from './registry'
import { getEffectivePrefs } from '../google/prefs-db'

export interface ResolveResult {
  /** Rendered block for the system prompt, or undefined when nothing ran. */
  context?: string
  /** Names of tools that actually returned data — for logging. */
  ran: string[]
}

export async function resolveLiveAnalytics(
  question: string,
  role: string | undefined,
  accessToken: string | undefined,
  now: Date = new Date(),
): Promise<ResolveResult> {
  // No Google session means no analytics — cheaper to bail than to plan a call
  // that could never execute.
  if (!accessToken || !question.trim()) return { ran: [] }

  const tools = toolsFor('analytics', role)
  if (!tools.length) return { ran: [] }

  try {
    const calls = await planToolCalls(question, tools, now)
    if (!calls.length) return { ran: [] }

    const prefs = await getEffectivePrefs()
    const outcomes = await executeToolCalls(calls, {
      accessToken,
      role: role ?? '',
      ga4PropertyId: prefs.ga4PropertyId,
      gscSiteUrl: prefs.gscSiteUrl,
      today: now,
    })

    return {
      context: renderToolOutcomes(outcomes) || undefined,
      ran: outcomes.filter(o => o.ok).map(o => o.name),
    }
  } catch (err) {
    console.warn('[ai-tools] live analytics resolution failed; answering without it:', err)
    return { ran: [] }
  }
}
