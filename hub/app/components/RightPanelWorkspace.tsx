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

export type RightPanelTab = 'pulse' | 'issues' | 'routines' | 'goals' | 'agents' | 'spaces'

export const RIGHT_PANEL_TABS: Array<{ id: RightPanelTab; label: string }> = [
  { id: 'pulse', label: 'Pulse' },
  { id: 'issues', label: 'Issues' },
  { id: 'routines', label: 'Routines' },
  { id: 'goals', label: 'Goals' },
  { id: 'agents', label: 'Agents' },
  { id: 'spaces', label: 'Spaces' },
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

/* ── Placeholder views for not-yet-native tabs ── */

const TAB_PLACEHOLDERS: Record<
  Exclude<RightPanelTab, 'pulse'>,
  { title: string; description: string; prompt: string; phase: string }
> = {
  issues: {
    title: 'Issues',
    description: 'Native issue triage — statuses, comments, blockers, and run history — lands here.',
    prompt: 'Show me the current open issues and who each one is assigned to.',
    phase: 'Coming in Phase 2',
  },
  agents: {
    title: 'Agents',
    description: 'The agent roster — status, current run, spend vs budget, wake and clear-error controls.',
    prompt: "Give me a status report on every agent: what they're doing and any recent failures.",
    phase: 'Coming in Phase 2',
  },
  routines: {
    title: 'Routines',
    description: 'Scheduled and triggered work — pause, resume, run-now, and run history.',
    prompt: 'List the routines in this workspace, their schedules, and their last run outcomes.',
    phase: 'Coming in Phase 3',
  },
  goals: {
    title: 'Goals',
    description: 'The goal hierarchy from company mission down to task-level objectives.',
    prompt: 'Summarize our current goals and how active work maps to them.',
    phase: 'Coming in Phase 3',
  },
  spaces: {
    title: 'Spaces',
    description: 'Projects and their execution workspaces — branches, runtime services, and health.',
    prompt: 'List the projects and workspaces in this org and their current status.',
    phase: 'Coming in Phase 4',
  },
}

export function TabPlaceholder({
  tab,
  paperclipUrl,
  onInjectChat,
}: {
  tab: Exclude<RightPanelTab, 'pulse'>
  paperclipUrl: string
  onInjectChat: (msg: string) => void
}) {
  const meta = TAB_PLACEHOLDERS[tab]
  return (
    <div className="rp-placeholder" role="tabpanel" aria-label={meta.title}>
      <div className="rp-placeholder__phase">{meta.phase}</div>
      <div className="rp-placeholder__title">{meta.title}</div>
      <p className="rp-placeholder__desc">{meta.description}</p>
      <div className="rp-placeholder__actions">
        <button className="feed-filter-btn" onClick={() => onInjectChat(meta.prompt)}>
          Ask the assistant
        </button>
        <a
          className="feed-filter-btn"
          href={paperclipUrl}
          target="_blank"
          rel="noopener noreferrer"
          style={{ textDecoration: 'none', display: 'inline-flex', alignItems: 'center' }}
        >
          Open in Paperclip ↗
        </a>
      </div>
    </div>
  )
}
