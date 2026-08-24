import type { AiRunRecord } from './runs'
import type { FeedItem } from '@/types'

/**
 * lib/run-feed.ts — AiRunRecord → FeedItem, the Phase 3 PR 2 mapping
 * (docs/architecture/PHASE3_EXECUTION_PANEL_2026-08-22.md §4).
 *
 * Pure, mirroring lib/ai-action-feed.ts, so the panel's runs feed reuses the
 * existing ExecutionFeed presentation unmodified and the mapping is
 * unit-testable in isolation.
 *
 * CONTENT RULE: the ledger stores provenance, never content — and this mapper
 * must not undo that at the presentation layer. `run.error` (a flattened
 * message that can carry model-output tails; HARDENING_REVIEW § "Output tails
 * leak") is deliberately NEVER surfaced here: the feed card and the chat
 * injection built from it carry only the typed `errorClass`.
 */

const ENGINE_LABELS: Record<string, string> = {
  agy: 'agy · allotment',
  gemini: 'Gemini · metered',
  claude: 'Claude · metered',
}

export function engineLabel(engine: string): string {
  return ENGINE_LABELS[engine] ?? engine
}

function formatLatency(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`
  return `${(ms / 1000).toFixed(1)}s`
}

export function runToFeedItem(run: AiRunRecord): FeedItem {
  const ok = run.status === 'ok'
  const shortId = run.id.slice(0, 8)
  // The title is what a card tap injects into chat ("Tell me more about: …"),
  // so it must carry the run's identity and verdict on its own.
  const title = ok
    ? `Run ${shortId} — ${run.engine} ${run.source} served`
    : `Run ${shortId} — ${run.engine} ${run.source} failed (${run.errorClass ?? 'unknown'})`

  const parts: string[] = [engineLabel(run.engine)]
  if (run.model) parts.push(run.model)
  parts.push(formatLatency(run.latencyMs))
  if (typeof run.totalTokens === 'number') parts.push(`${run.totalTokens} tok`)
  const workerId = run.meta?.workerId
  if (typeof workerId === 'string' && workerId) parts.push(`via ${workerId}`)

  return {
    id: `run-${run.id}`,
    source: 'run',
    // A failed run is the panel's business to surface, not to file quietly:
    // 'needs_you' puts it behind the attention filter with the alert dot.
    type: ok ? 'completed' : 'needs_you',
    title,
    description: parts.join(' · '),
    timestamp: run.createdAt,
    icon: ok ? 'zap' : 'alert-triangle',
    metadata: {
      runId: run.id,
      engine: run.engine,
      model: run.model,
      status: run.status,
      errorClass: run.errorClass,
      latencyMs: run.latencyMs,
      requestId: run.requestId,
    },
  }
}
