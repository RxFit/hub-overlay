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

/** Error classes are typed Hub-side but the union is open and worker-adjacent;
 *  clamp before the value reaches a card title — which a tap sends into chat
 *  verbatim ("Tell me more about: …") — or the metadata channel. Mirrors the
 *  same clamp in lib/dispatch-alerts.ts. */
function sanitizeClass(k: string | null): string {
  const clean = (k ?? 'unknown').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 32)
  return clean || 'unknown'
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
    : `Run ${shortId} — ${run.engine} ${run.source} failed (${sanitizeClass(run.errorClass)})`

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
      errorClass: run.errorClass === null ? null : sanitizeClass(run.errorClass),
      latencyMs: run.latencyMs,
      requestId: run.requestId,
    },
  }
}
