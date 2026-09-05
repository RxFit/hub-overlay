'use client'

import { memo } from 'react'
import type { ExecutionSnapshot } from '@/lib/execution-context'

/* ══════════════════════════════════════════════════════════════════════════════
   RIGHT PANEL WORKSPACE — Phase 1 scaffold

   Originally the Phase 1 six-tab scaffold against Paperclip
   (docs/architecture/RIGHT_PANEL_ARCHITECTURE_2026-07-19.md — archaeology).
   As of Phase 3 PR 2 this file carries the Runs + Pulse tab nav; as of
   Phase 4 PR 1 the Pulse tab renders ExecutionPulse below over the Hub's own
   execution snapshot (docs/architecture/PHASE4_AGENTIC_PANEL_2026-09-05.md §3).
   ══════════════════════════════════════════════════════════════════════════════ */

// Phase 3 PR 2 (docs/architecture/PHASE3_EXECUTION_PANEL_2026-08-22.md §4):
// the five Paperclip workspace tabs are gone — every one rendered a permanent
// "Select a workspace…" empty state against a retired engine. The panel is
// Pulse + Runs now; the TabView component files are deleted in PR 5.
export type RightPanelTab = 'pulse' | 'runs'

export const RIGHT_PANEL_TABS: Array<{ id: RightPanelTab; label: string }> = [
  { id: 'runs', label: 'Runs' },
  { id: 'pulse', label: 'Pulse' },
]

/* ── Segmented tab nav (reuses feed-filter styling for visual continuity) ── */

export function RightPanelTabsNav({
  active,
  onChange,
}: {
  active: RightPanelTab
  onChange: (tab: RightPanelTab) => void
}) {
  return (
    <div className="feed-filter-bar rp-tabs" role="tablist" aria-label="Execution workspace sections">
      {RIGHT_PANEL_TABS.map((tab) => {
        const isActive = active === tab.id
        return (
          <button
            key={tab.id}
            className={`feed-filter-btn ${isActive ? 'active' : ''}`}
            role="tab"
            aria-selected={isActive}
            onClick={() => onChange(tab.id)}
          >
            {tab.label}
          </button>
        )
      })}
    </div>
  )
}

/* ── Pulse: the Hub's own execution snapshot ──
   Phase 4 PR 1 (docs/architecture/PHASE4_AGENTIC_PANEL_2026-09-05.md §3).
   Replaces the Paperclip-era PulseStrip/AttentionStrip shells, which read a
   `dashboard` prop no live source ever supplied. The snapshot here is the
   SAME object the chat route injects as the "Execution Layer" prompt section
   (lib/execution-context.ts), so a tile and the assistant's answer about it
   can never disagree — and every chip below asks the assistant a question it
   already has the data to answer. */

function PulseStat({
  label,
  value,
  sub,
  alert,
  locked,
}: {
  label: string
  value: string
  sub?: string
  alert?: boolean
  locked?: boolean
}) {
  return (
    <div
      className={`pulse-stat ${alert ? 'pulse-stat--alert' : ''}`}
      role="status"
      aria-label={`${label}: ${value}${sub ? `, ${sub}` : ''}`}
      title={locked ? 'Admin-only plane' : undefined}
    >
      <div className="pulse-stat__value">{locked ? '🔒' : value}</div>
      <div className="pulse-stat__label">{label}</div>
      {sub && <div className="pulse-stat__sub">{locked ? 'admin only' : sub}</div>}
    </div>
  )
}

function fmtLatency(ms: number | null): string {
  if (ms === null) return '—'
  return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`
}

function fmtAgo(iso: string, now: number): string {
  const ms = now - new Date(iso).getTime()
  if (!Number.isFinite(ms) || ms < 60_000) return 'just now'
  const m = Math.floor(ms / 60_000)
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  return h < 48 ? `${h}h ago` : `${Math.floor(h / 24)}d ago`
}

/** One "ask the assistant" chip derived from the snapshot. Pure and exported
 *  so the derivation is unit-testable without a renderer. */
export interface PulseChip {
  key: 'runs_failed' | 'worker_offline' | 'queue_backlog' | 'actions_failed' | 'deep_active' | 'summary'
  label: string
  count?: number
  alert: boolean
  prompt: string
}

export function derivePulseChips(snap: ExecutionSnapshot): PulseChip[] {
  const chips: PulseChip[] = []
  const r = snap.runs
  if (r && r.error > 0) {
    const classes = Object.entries(r.errorClasses).map(([c, n]) => `${c}×${n}`).join(', ')
    chips.push({
      key: 'runs_failed',
      label: 'failed runs',
      count: r.error,
      alert: true,
      prompt: `${r.error} of the last ${r.total} model runs failed in the past ${r.windowHours}h (${classes}). What went wrong, is it one cause or several, and what should I do about it?`,
    })
  }
  const d = snap.dispatch
  if (d && (d.enabled || d.workers.length > 0)) {
    const live = d.workers.filter((w) => w.fresh).length
    if (live === 0) {
      chips.push({
        key: 'worker_offline',
        label: 'worker offline',
        alert: true,
        prompt: 'The desktop dispatch worker looks offline. What does that mean for chat and deep runs right now, and how do I bring it back?',
      })
    }
    const backlog = (d.queue.queued ?? 0) + (d.queue.leased ?? 0)
    if (backlog > 3) {
      chips.push({
        key: 'queue_backlog',
        label: 'queued jobs',
        count: backlog,
        alert: true,
        prompt: `There are ${backlog} jobs waiting in the dispatch queue. Is that a backlog I should worry about, and what is holding them up?`,
      })
    }
  }
  if (snap.actions.failed > 0) {
    chips.push({
      key: 'actions_failed',
      label: 'failed actions',
      count: snap.actions.failed,
      alert: true,
      prompt: `${snap.actions.failed} of my recent AI actions failed. Which ones, why, and should I retry them?`,
    })
  }
  if (snap.toolRuns.active > 0) {
    chips.push({
      key: 'deep_active',
      label: 'deep runs active',
      count: snap.toolRuns.active,
      alert: false,
      prompt: 'Which of my deep runs are still in progress, and roughly when should I expect them to land?',
    })
  }
  chips.push({
    key: 'summary',
    label: 'health summary',
    alert: false,
    prompt: 'Give me a plain-English health summary of the Execution Layer: what ran today, what it cost, what failed, and whether anything needs my attention.',
  })
  return chips
}

export const ExecutionPulse = memo(function ExecutionPulse({
  snapshot,
  isLoading,
  error,
  onRetry,
  onInjectChat,
}: {
  snapshot: ExecutionSnapshot | null
  isLoading: boolean
  error?: unknown
  onRetry?: () => void
  // Read-style injection only — chips ask, they never write.
  onInjectChat: (msg: string) => void
}) {
  if (isLoading && !snapshot) {
    return (
      <div className="pulse-strip" aria-label="Execution health" aria-busy="true">
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} className="pulse-stat pulse-stat--skeleton" aria-hidden="true" />
        ))}
      </div>
    )
  }

  if (!snapshot) {
    return (
      <div className="feed-empty" role="alert">
        <div className="feed-empty__icon">⚠️</div>
        <div className="feed-empty__text">
          {error ? 'Unable to read the execution ledger — try again' : 'No execution data yet'}
        </div>
        {onRetry && (
          <button className="feed-filter-btn" onClick={onRetry} style={{ marginTop: 'var(--space-3)' }}>
            Retry
          </button>
        )}
      </div>
    )
  }

  const now = Date.now()
  const r = snapshot.runs
  const d = snapshot.dispatch
  const liveWorkers = d ? d.workers.filter((w) => w.fresh) : []
  const newestWorker = d?.workers[0]
  const dispatchOff = d ? !d.enabled && d.workers.length === 0 : false
  const backlog = d ? (d.queue.queued ?? 0) + (d.queue.leased ?? 0) : 0
  const chips = derivePulseChips(snapshot)

  return (
    <div className="execution-pulse">
      <div className="pulse-strip" aria-label="Execution health">
        <PulseStat
          label="Allotment share"
          value={r ? (r.allotmentSharePercent === null ? '—' : `${r.allotmentSharePercent}%`) : '—'}
          sub={r ? 'of chat served on agy' : undefined}
          locked={!r}
        />
        <PulseStat
          label={`Runs · ${r?.windowHours ?? 24}h`}
          value={r ? String(r.total) : '—'}
          sub={r ? (r.error > 0 ? `${r.error} failed` : `${r.ok} ok`) : undefined}
          alert={Boolean(r && r.error > 0)}
          locked={!r}
        />
        <PulseStat
          label="p50 latency"
          value={r ? fmtLatency(r.p50LatencyMs) : '—'}
          sub={r ? `${r.totalTokens.toLocaleString()} tok` : undefined}
          locked={!r}
        />
        <PulseStat
          label="Worker"
          value={!d ? '—' : dispatchOff ? 'off' : liveWorkers.length > 0 ? 'live' : d.workers.length === 0 ? 'none' : 'offline'}
          sub={
            !d ? undefined
              : dispatchOff ? 'dispatch disabled'
              : newestWorker ? `${newestWorker.id} · ${fmtAgo(newestWorker.lastSeenAt, now)}`
              : 'never registered'
          }
          alert={Boolean(d && !dispatchOff && liveWorkers.length === 0)}
          locked={!d}
        />
        <PulseStat
          label="Your AI actions"
          value={String(snapshot.actions.total)}
          sub={snapshot.actions.failed > 0 ? `${snapshot.actions.failed} failed` : 'recent, none failed'}
          alert={snapshot.actions.failed > 0}
        />
        <PulseStat
          label="Deep runs"
          value={String(snapshot.toolRuns.active)}
          sub={
            snapshot.toolRuns.recent.length > 0
              ? `active · last ${snapshot.toolRuns.recent[0].status}`
              : d && backlog > 0 ? `${backlog} queued` : 'active'
          }
        />
      </div>

      <div className="attention-strip attention-strip--pulse" role="region" aria-label="Ask the assistant">
        {chips.map((chip) => (
          <button
            key={chip.key}
            className={`attention-chip ${chip.alert ? '' : 'attention-chip--calm'}`}
            data-attention={chip.key}
            onClick={() => onInjectChat(chip.prompt)}
            aria-label={`${chip.count !== undefined ? `${chip.count} ` : ''}${chip.label} — ask the assistant`}
          >
            {chip.count !== undefined && <span className="attention-chip__count">{chip.count}</span>}
            <span className="attention-chip__label">{chip.label}</span>
          </button>
        ))}
      </div>

      {snapshot.notices.length > 0 && (
        <div className="pulse-notice" role="status">
          Not readable right now: {snapshot.notices.join('; ')}
        </div>
      )}
    </div>
  )
})
