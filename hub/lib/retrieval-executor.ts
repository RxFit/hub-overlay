/**
 * Retrieval execution: plan → parallel Google reads → prompt block (SERVER-ONLY).
 *
 * One hop, bounded and fail-soft. Every failure mode — no token, trivial
 * message, planner error, model unavailable, a Google 403 — resolves to an
 * empty string, which returns the assistant to exactly its previous behavior
 * (the pre-fetched digest). Retrieval can make an answer better; it must never
 * be the reason a turn fails.
 */

import { geminiGenerateText } from './gemini'
import { isTrivialMessage } from './search-routing'
import { listChatSpaces } from './google'
import { resolveVisibleSpaces, EMPTY_CHAT_SPACE_PREFERENCES, type ChatSpacePreferences } from './chat-spaces'
import {
  buildPlannerPrompt,
  parseRetrievalPlan,
  renderRetrievalContext,
  type RetrievalStep,
} from './retrieval-planner'
import { runDriveSearch, runChatSearch } from './retrieval-tools'
import { createLogger } from './logger'

const log = createLogger('retrieval')

/**
 * Total wall-clock budget for planning + all reads.
 *
 * Sits under the chat route's own context budget so retrieval can never be the
 * thing that delays the first streamed token. If it overruns, the turn proceeds
 * without it.
 */
export const RETRIEVAL_TIMEOUT_MS = 12_000

/** Budget for the planner call alone — it is one short JSON emission. */
export const PLANNER_TIMEOUT_MS = 6_000

function withDeadline<T>(promise: Promise<T>, ms: number, fallback: T, label: string): Promise<T> {
  return new Promise<T>(resolve => {
    const timer = setTimeout(() => {
      log.warn({ label, ms }, 'retrieval step timed out — continuing without it')
      resolve(fallback)
    }, ms)
    promise
      .then(v => { clearTimeout(timer); resolve(v) })
      .catch(err => {
        clearTimeout(timer)
        log.warn({ err, label }, 'retrieval step failed — continuing without it')
        resolve(fallback)
      })
  })
}

/** Ask the planner which lookups (if any) this message needs. */
export async function planRetrieval(
  query: string,
  spaceNames: string[],
): Promise<RetrievalStep[]> {
  const raw = await withDeadline(
    geminiGenerateText(buildPlannerPrompt(spaceNames), query).then(r => r.text),
    PLANNER_TIMEOUT_MS,
    '',
    'planner',
  )
  return parseRetrievalPlan(raw)
}

/** Execute one planned step, never throwing. */
async function executeStep(
  accessToken: string,
  step: RetrievalStep,
  preferences: ChatSpacePreferences,
): Promise<string> {
  try {
    if (step.tool === 'search_drive') {
      return (await runDriveSearch(accessToken, step.query)).rendered
    }
    return (await runChatSearch(accessToken, step.query, step.space, preferences)).rendered
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'unknown error'
    log.warn({ err, tool: step.tool }, 'retrieval tool failed')
    // Tell the model the lookup was ATTEMPTED and failed. Silence here invites
    // it to answer as though nothing was searched.
    return `#### ${step.tool}: "${step.query}"\n[This lookup failed: ${msg}]`
  }
}

/**
 * Plan and run on-demand retrieval for one chat turn.
 *
 * @returns A prompt block, or '' when nothing was retrieved.
 */
export async function runRetrieval(
  accessToken: string | undefined,
  query: string,
  preferences: ChatSpacePreferences = EMPTY_CHAT_SPACE_PREFERENCES,
): Promise<string> {
  if (!accessToken || !query.trim()) return ''

  // Don't spend a model call and Google round-trips on "thanks". Same gate the
  // Vertex/pgvector pipeline already uses, so routing stays consistent.
  if (isTrivialMessage(query)) {
    log.info('retrieval skipped for trivial message')
    return ''
  }

  return withDeadline((async () => {
    // The planner needs the space list to target one by name. This is the same
    // call the digest makes; it is cheap and cached upstream by Google.
    const spaces = await listChatSpaces(accessToken)
      .then(all => resolveVisibleSpaces(all, preferences))
      .catch(() => [])
    const spaceNames = spaces.map(s => s.displayName).filter(Boolean).slice(0, 20)

    const plan = await planRetrieval(query, spaceNames)
    if (plan.length === 0) {
      log.info('planner requested no lookups')
      return ''
    }

    log.info({ plan: plan.map(p => `${p.tool}:${p.query}${p.space ? `@${p.space}` : ''}`) }, 'executing retrieval plan')

    const blocks = await Promise.all(plan.map(step => executeStep(accessToken, step, preferences)))
    return renderRetrievalContext(blocks.filter(Boolean))
  })(), RETRIEVAL_TIMEOUT_MS, '', 'retrieval')
}
