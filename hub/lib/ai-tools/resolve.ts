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

import { getServerSession } from 'next-auth'
import { planToolCalls } from './plan'
import { executeToolCalls, renderToolOutcomes } from './execute'
import { toolsFor } from './registry'
import { buildCapabilityManifest } from './capabilities'
import { getEffectivePrefsDetailed } from '../google/prefs-db'
import type { GooglePrefsValues } from '../google/prefs'
import { authOptions } from '../auth'
import { getChatSpacePreferences } from '../chat-space-preferences-db'
import { EMPTY_CHAT_SPACE_PREFERENCES, type ChatSpacePreferences } from '../chat-spaces'
import { withTimeout } from '../timeout'

/** Ceiling on each of the two per-turn DB reads (prefs, chat visibility). */
export const PREFS_TIMEOUT_MS = 5_000

export interface ResolveResult {
  /** Rendered block for the system prompt, or undefined when nothing ran. */
  context?: string
  /** Capability manifest for the system prompt — what live data THIS
   *  deployment can fetch and whether it is configured. Built on every
   *  eligible turn (not only when tools ran), because the turns where NOTHING
   *  ran are exactly the ones where the model would otherwise deny having the
   *  capability. Undefined without a Google session or runnable tools. */
  manifest?: string
  /** Names of tools that actually returned data — for logging. */
  ran: string[]
}

/**
 * Resolve every read-tool group in ONE planner call.
 *
 * The groups are offered together rather than planned separately so a question
 * costs at most one planning round trip regardless of how many groups exist,
 * and so a question spanning two sources ("what did we agree on pricing, and
 * how did that page perform?") can be answered by one coherent plan. Each
 * group's prefilter still gates whether it contributes tools at all, so a pure
 * analytics question never carries Workspace tool declarations and vice versa.
 */
export async function resolveReadTools(
  question: string,
  role: string | undefined,
  accessToken: string | undefined,
  now: Date = new Date(),
): Promise<ResolveResult> {
  // No Google session means no reads — cheaper to bail than to plan a call
  // that could never execute.
  if (!accessToken || !question.trim()) return { ran: [] }

  const tools = [...toolsFor('analytics', role), ...toolsFor('workspace', role)]
  if (!tools.length) return { ran: [] }

  try {
    // Planning and the prefs lookup are independent — run them concurrently.
    // Prefs are fetched on EVERY eligible turn (not only when a plan produced
    // calls) because the capability manifest needs the configured state
    // precisely on the turns where no tool ran.
    //
    // Both DB reads are BOUNDED (withTimeout resolves with the fallback): a
    // hanging connection or saturated pool must degrade the manifest to
    // prefsKnown:false, never hold the turn — the route awaits this promise
    // with no timeout of its own, so an unbounded read here would stall every
    // chat turn for the length of a DB incident. And prefsKnown comes from
    // getEffectivePrefsDetailed's storeReadFailed, not from a rejection (the
    // function never rejects): a failed store read must render as "config
    // state unknown", never as "NOT configured" to an admin who configured it.
    const [calls, prefsOutcome, chatSpacePreferences] = await Promise.all([
      planToolCalls(question, tools, now),
      withTimeout(
        getEffectivePrefsDetailed().then(o => ({ known: !o.storeReadFailed, prefs: o.prefs })),
        PREFS_TIMEOUT_MS,
        { known: false, prefs: {} as GooglePrefsValues },
        'ai-tools-prefs',
      ),
      withTimeout(
        resolveChatSpacePreferences(),
        PREFS_TIMEOUT_MS,
        EMPTY_CHAT_SPACE_PREFERENCES,
        'ai-tools-chat-prefs',
      ),
    ])

    const manifest = buildCapabilityManifest({
      role,
      ga4PropertyId: prefsOutcome.prefs.ga4PropertyId,
      gscSiteUrl: prefsOutcome.prefs.gscSiteUrl,
      prefsKnown: prefsOutcome.known,
    })

    if (!calls.length) return { manifest, ran: [] }

    const outcomes = await executeToolCalls(calls, {
      accessToken,
      role: role ?? '',
      ga4PropertyId: prefsOutcome.prefs.ga4PropertyId,
      gscSiteUrl: prefsOutcome.prefs.gscSiteUrl,
      chatSpacePreferences,
      today: now,
    })

    return {
      context: renderToolOutcomes(outcomes) || undefined,
      manifest,
      ran: outcomes.filter(o => o.ok).map(o => o.name),
    }
  } catch (err) {
    console.warn('[ai-tools] read-tool resolution failed; answering without it:', err)
    return { ran: [] }
  }
}

/** Read the caller's Chat visibility overrides, defaulting to none. */
async function resolveChatSpacePreferences(): Promise<ChatSpacePreferences> {
  try {
    const session = await getServerSession(authOptions)
    const email = session?.user?.email
    return email ? await getChatSpacePreferences(email) : EMPTY_CHAT_SPACE_PREFERENCES
  } catch {
    return EMPTY_CHAT_SPACE_PREFERENCES
  }
}

/**
 * @deprecated Use {@link resolveReadTools}, which also covers Workspace reads.
 * Retained so an existing caller keeps compiling.
 */
export const resolveLiveAnalytics = resolveReadTools
