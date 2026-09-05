'use client'

import { memo, useState } from 'react'
import { useNeedsYou } from '@/app/hooks/useHubData'
import type { NeedsYouItem, NeedsYouKind } from '@/lib/needs-you'
import type { ChatAttachment } from '@/types'

/* ══════════════════════════════════════════════════════════════════════════════
   NEEDS-YOU QUEUE — the inbox at the top of the Runs tab (Phase 4 PR 2,
   docs/architecture/PHASE4_AGENTIC_PANEL_2026-09-05.md §5 PR 2).

   Every card is something the Hub's AI could not finish on its own, with
   three verbs:
     Explain — the PR 1 record tap: the row travels by reference and the
               assistant explains THAT record (read-style inject).
     Retry   — deep runs re-enter the real start path (POST retry); failed
               actions re-open the app's own confirm-card flow through an
               execute-style inject. Nothing is ever re-sent unreviewed.
     Dismiss — a per-user overlay; the ledger row is untouched.
   ══════════════════════════════════════════════════════════════════════════════ */

const KIND_LABEL: Record<NeedsYouKind, string> = { review: 'Review', question: 'Question', notify: 'FYI' }

function relTime(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime()
  if (!Number.isFinite(ms) || ms < 60_000) return 'now'
  const m = Math.floor(ms / 60_000)
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h`
  return `${Math.floor(h / 24)}d`
}

/** The message an Explain tap sends — the same read-style form as a feed-card tap. */
export function buildQueueExplainMessage(item: NeedsYouItem): string {
  const ask = item.kind === 'notify'
    ? 'What does this alert mean for me, and is there anything I should do?'
    : item.kind === 'question'
      ? 'Is this run stuck, and should I retry it or wait?'
      : 'What happened, why did it fail, and what should I do about it?'
  return `Tell me more about: ${item.title}\n\n${ask}`
}

/** The record attachment behind an Explain tap, when the card has a ledger row. */
export function queueItemToAttachment(item: NeedsYouItem): ChatAttachment | null {
  if (!item.record) return null
  return {
    id: `record-${item.key}`,
    type: 'record',
    label: item.title,
    recordKind: item.record.recordKind,
    recordId: item.record.recordId,
  }
}

const QueueCard = memo(function QueueCard({
  item,
  busy,
  onExplain,
  onRetry,
  onDismiss,
}: {
  item: NeedsYouItem
  busy: boolean
  onExplain: (item: NeedsYouItem) => void
  onRetry: (item: NeedsYouItem) => void
  onDismiss: (item: NeedsYouItem) => void
}) {
  return (
    <div className="needs-you__card" data-kind={item.kind} data-source={item.source} role="listitem">
      <div className="needs-you__head">
        <span className="needs-you__kind" data-kind={item.kind}>{KIND_LABEL[item.kind]}</span>
        <span className="needs-you__title">{item.title}</span>
        <span className="needs-you__time">{relTime(item.createdAt)}</span>
      </div>
      {item.description && <div className="needs-you__desc">{item.description}</div>}
      <div className="needs-you__actions">
        {item.record && (
          <button className="feed-filter-btn" onClick={() => onExplain(item)} disabled={busy}>
            Explain
          </button>
        )}
        {item.retry && (
          <button className="feed-filter-btn needs-you__retry" onClick={() => onRetry(item)} disabled={busy}>
            {busy ? 'Retrying…' : 'Retry'}
          </button>
        )}
        <button className="feed-filter-btn needs-you__dismiss" onClick={() => onDismiss(item)} disabled={busy} aria-label={`Dismiss: ${item.title}`}>
          Dismiss
        </button>
      </div>
    </div>
  )
})

export function NeedsYouQueue({
  onInjectChat,
  onInjectAction,
}: {
  /** Read-style inject (Explain) — carries the record attachment. */
  onInjectChat: (msg: string, attachments?: ChatAttachment[]) => void
  /** Execute-style inject (action Retry) — runs the full intent → interview → confirm-card pipeline. */
  onInjectAction: (msg: string) => void
}) {
  const { items, dismissedCount, notices, isLoading, error, refetch, dismiss, retryDeepRun } = useNeedsYou(true)
  const [busyKey, setBusyKey] = useState<string | null>(null)
  const [flash, setFlash] = useState<{ key: string; text: string; tone: 'ok' | 'err' } | null>(null)

  const handleExplain = (item: NeedsYouItem) => {
    const att = queueItemToAttachment(item)
    onInjectChat(buildQueueExplainMessage(item), att ? [att] : undefined)
  }

  const handleRetry = async (item: NeedsYouItem) => {
    if (!item.retry) return
    if (item.retry.mode === 'action') {
      // The body was never stored; the app's own flow collects and gates it.
      onInjectAction(item.retry.prompt)
      return
    }
    setBusyKey(item.key)
    const result = await retryDeepRun(item.retry.runId)
    setBusyKey(null)
    setFlash(result.ok
      ? { key: item.key, text: 'Retried — a new run is queued', tone: 'ok' }
      : { key: item.key, text: result.error, tone: 'err' })
  }

  const handleDismiss = async (item: NeedsYouItem) => {
    setBusyKey(item.key)
    await dismiss(item.key)
    setBusyKey(null)
  }

  // Nothing to show and nothing wrong: the queue takes no space at all.
  if (!isLoading && !error && items.length === 0 && dismissedCount === 0 && notices.length === 0) return null

  return (
    <section className="needs-you" aria-label="Needs you">
      <div className="needs-you__bar">
        <span className="needs-you__heading">Needs you</span>
        <span className="needs-you__count" data-empty={items.length === 0}>{items.length}</span>
        {dismissedCount > 0 && <span className="needs-you__muted">{dismissedCount} dismissed</span>}
      </div>

      {error ? (
        <div className="feed-empty" role="alert">
          <div className="feed-empty__text">Unable to load the queue</div>
          <button className="feed-filter-btn" onClick={() => { void refetch() }} style={{ marginTop: 'var(--space-2)' }}>Retry</button>
        </div>
      ) : isLoading && items.length === 0 ? (
        <div className="needs-you__card needs-you__card--skeleton" aria-hidden="true" />
      ) : items.length === 0 ? (
        <div className="needs-you__muted needs-you__clear" role="status">Nothing needs you right now</div>
      ) : (
        <div role="list" aria-label="Needs-you items" className="needs-you__list">
          {items.map((item) => (
            <div key={item.key}>
              <QueueCard
                item={item}
                busy={busyKey === item.key}
                onExplain={handleExplain}
                onRetry={handleRetry}
                onDismiss={handleDismiss}
              />
              {flash?.key === item.key && (
                <div className="needs-you__flash" data-tone={flash.tone} role="status">{flash.text}</div>
              )}
            </div>
          ))}
        </div>
      )}

      {notices.length > 0 && (
        <div className="needs-you__muted" role="status">Not readable right now: {notices.join('; ')}</div>
      )}
    </section>
  )
}
