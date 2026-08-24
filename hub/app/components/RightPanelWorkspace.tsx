'use client'

import { memo } from 'react'
import {
  deriveAttention,
  formatCents,
  type ExecutionDashboard,
} from '@/lib/execution-dashboard'

/* ══════════════════════════════════════════════════════════════════════════════
   RIGHT PANEL WORKSPACE — Phase 1 scaffold

   Tab scaffold + Pulse header + Attention strip for the Execution Layer
   (docs/architecture/RIGHT_PANEL_ARCHITECTURE_2026-07-19.md §5.1). Phase 1 is
   additive and read-only: Pulse hosts the existing feed, the other tabs are
   placeholders that deep-link to Paperclip and offer an assistant query, and
   every attention chip resolves through a read-style chat injection.
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

/* ── Pulse header: dashboard headline stats ── */

function PulseStat({
  label,
  value,
  sub,
  alert,
}: {
  label: string
  value: string
  sub?: string
  alert?: boolean
}) {
  return (
    <div className={`pulse-stat ${alert ? 'pulse-stat--alert' : ''}`} role="status">
      <div className="pulse-stat__value">{value}</div>
      <div className="pulse-stat__label">{label}</div>
      {sub && <div className="pulse-stat__sub">{sub}</div>}
    </div>
  )
}

export const PulseStrip = memo(function PulseStrip({
  dashboard,
  isLoading,
}: {
  dashboard: ExecutionDashboard | null
  isLoading: boolean
}) {
  // Degrade to nothing rather than a wall of zeros: no data and not loading
  // means the snapshot endpoint is unavailable — the feed below still renders.
  if (!dashboard && !isLoading) return null

  if (!dashboard) {
    return (
      <div className="pulse-strip" aria-label="Workspace health" aria-busy="true">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="pulse-stat pulse-stat--skeleton" aria-hidden="true" />
        ))}
      </div>
    )
  }

  const { agents, tasks, costs, pendingApprovals } = dashboard
  const spend = formatCents(costs.monthSpendCents)
  const budgetSub = costs.monthBudgetCents > 0
    ? `${Math.round(costs.monthUtilizationPercent)}% of ${formatCents(costs.monthBudgetCents)}`
    : 'no budget cap'

  return (
    <div className="pulse-strip" aria-label="Workspace health">
      <PulseStat
        label="Agents"
        value={`${agents.running}/${agents.active + agents.running + agents.paused}`}
        sub={agents.error > 0 ? `${agents.error} in error` : 'running / total'}
        alert={agents.error > 0}
      />
      <PulseStat
        label="Open work"
        value={String(tasks.open)}
        sub={tasks.blocked > 0 ? `${tasks.blocked} blocked` : `${tasks.inProgress} in progress`}
        alert={tasks.blocked > 0}
      />
      <PulseStat label="Month spend" value={spend} sub={budgetSub} alert={costs.monthUtilizationPercent >= 80} />
      <PulseStat
        label="Approvals"
        value={String(pendingApprovals)}
        sub={pendingApprovals > 0 ? 'awaiting you' : 'none pending'}
        alert={pendingApprovals > 0}
      />
    </div>
  )
})

/* ── Attention strip (persistent footer) ── */

export const AttentionStrip = memo(function AttentionStrip({
  dashboard,
  onInjectChat,
}: {
  dashboard: ExecutionDashboard | null
  // Read-style injection only — Phase 1 adds no new write paths.
  onInjectChat: (msg: string) => void
}) {
  const items = dashboard ? deriveAttention(dashboard) : []
  if (items.length === 0) return null

  return (
    <div className="attention-strip" role="region" aria-label="Needs attention">
      {items.map((item) => (
        <button
          key={item.key}
          className="attention-chip"
          data-attention={item.key}
          onClick={() => onInjectChat(item.prompt)}
          aria-label={`${item.count} ${item.label} — ask the assistant`}
        >
          <span className="attention-chip__count">{item.count}</span>
          <span className="attention-chip__label">{item.label}</span>
        </button>
      ))}
    </div>
  )
})

/* All six tabs are native as of Phase 4 — the interim TabPlaceholder
   component (Phases 1–3) is gone. The header's "📎 Paperclip →" deep link
   remains the escape hatch for long-tail screens. */
