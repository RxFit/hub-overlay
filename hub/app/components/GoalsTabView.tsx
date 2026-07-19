'use client'

import { useMemo, useState } from 'react'
import type { Goal } from '@/types'
import { ROLE_RANK } from '@/lib/proxyAuthz'
import { buildGoalTree, GOAL_STATUS_OPTIONS } from '@/lib/execution-panel'
import { useGoalsPanel, useUpdateGoalStatus } from '@/app/hooks/useExecutionPanel'

/* ══════════════════════════════════════════════════════════════════════════════
   GOALS TAB (Phase 3) — the goal hierarchy (company → team → agent → task).

   Status changes are admin-tier via the proxy; goal creation routes through
   Interview Mode (create_goal intent, gate-token-guarded).
   ══════════════════════════════════════════════════════════════════════════════ */

function GoalRow({
  goal,
  depth,
  orgId,
  canManage,
  onInjectChat,
}: {
  goal: Goal
  depth: number
  orgId?: string
  canManage: boolean
  onInjectChat: (msg: string) => void
}) {
  const [expanded, setExpanded] = useState(false)
  const updateStatus = useUpdateGoalStatus(orgId)

  return (
    <div className="exec-row-wrap" style={{ marginLeft: Math.min(depth, 4) * 14 }}>
      <button
        className={`exec-row ${expanded ? 'exec-row--expanded' : ''}`}
        onClick={() => setExpanded(!expanded)}
        aria-expanded={expanded}
      >
        <span className="exec-row__id">{goal.level}</span>
        <span className="exec-row__title">{goal.title}</span>
        <span className="exec-row__state" data-goal-status={goal.status}>{goal.status}</span>
      </button>

      {expanded && (
        <div className="exec-drawer">
          {goal.description && <p className="exec-drawer__desc">{goal.description.length > 300 ? goal.description.slice(0, 297) + '…' : goal.description}</p>}

          {canManage && (
            <div className="exec-drawer__row">
              <label className="exec-drawer__label" htmlFor={`goal-status-${goal.id}`}>Status</label>
              <select
                id={`goal-status-${goal.id}`}
                className="exec-select"
                value={goal.status}
                disabled={updateStatus.isPending}
                onChange={(e) => updateStatus.mutate({ goalId: goal.id, status: e.target.value })}
              >
                {GOAL_STATUS_OPTIONS.map((o) => (
                  <option key={o.status} value={o.status}>{o.label}</option>
                ))}
                {!GOAL_STATUS_OPTIONS.some((o) => o.status === goal.status) && (
                  <option value={goal.status}>{goal.status}</option>
                )}
              </select>
            </div>
          )}

          {updateStatus.error && (
            <div className="exec-error" role="alert">{(updateStatus.error as Error).message}</div>
          )}

          <button
            className="feed-filter-btn"
            style={{ alignSelf: 'flex-start' }}
            onClick={() => onInjectChat(`How is the "${goal.title}" goal progressing? What active work maps to it?`)}
          >
            Ask the assistant
          </button>
        </div>
      )}
    </div>
  )
}

export function GoalsTabView({
  orgId,
  userRole,
  onInjectChat,
  onInjectAction,
}: {
  orgId?: string
  userRole?: string
  onInjectChat: (msg: string) => void
  // Action-style inject → Interview Mode (create_goal, gate-token-guarded)
  onInjectAction: (msg: string) => void
}) {
  const { goals, isLoading, error, refetch } = useGoalsPanel(orgId)
  const canManage = (ROLE_RANK[userRole ?? ''] ?? 0) >= ROLE_RANK.admin

  const tree = useMemo(() => buildGoalTree(goals), [goals])

  if (!orgId) {
    return <div className="exec-muted" style={{ padding: 'var(--space-3)' }}>Select a workspace to see its goals.</div>
  }

  return (
    <div className="exec-tab" role="tabpanel" aria-label="Goals">
      {canManage && (
        <button
          className="feed-filter-btn"
          style={{ alignSelf: 'flex-start' }}
          onClick={() => onInjectAction('I want to define a new business goal for this workspace. Guide me.')}
        >
          + New goal
        </button>
      )}

      {isLoading ? (
        <div className="exec-muted">Loading goals…</div>
      ) : error ? (
        <div className="feed-empty" role="alert">
          <div className="feed-empty__text">Unable to load goals</div>
          <button className="feed-filter-btn" onClick={() => refetch()} style={{ marginTop: 'var(--space-2)' }}>Retry</button>
        </div>
      ) : tree.length === 0 ? (
        <div className="exec-muted">No goals yet — the mission tree starts here.</div>
      ) : (
        <div role="list" aria-label="Goal hierarchy">
          {tree.map(({ goal, depth }) => (
            <GoalRow
              key={goal.id}
              goal={goal}
              depth={depth}
              orgId={orgId}
              canManage={canManage}
              onInjectChat={onInjectChat}
            />
          ))}
        </div>
      )}
    </div>
  )
}
