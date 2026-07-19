'use client'

import { useState } from 'react'
import type { Routine } from '@/types'
import { ROLE_RANK } from '@/lib/proxyAuthz'
import { useRoutinesPanel, useRoutineRuns, useRoutineAction } from '@/app/hooks/useExecutionPanel'

/* ══════════════════════════════════════════════════════════════════════════════
   ROUTINES TAB (Phase 3) — recurring agent work.

   Run-now is staff-tier; pause/resume is admin-tier; creation routes through
   Interview Mode (create_routine intent, gate-token-guarded) via the
   action-style inject. The [...path] proxy enforces all tiers server-side.
   ══════════════════════════════════════════════════════════════════════════════ */

function relTime(iso?: string | null): string {
  if (!iso) return ''
  try {
    const mins = Math.floor((Date.now() - new Date(iso).getTime()) / 60_000)
    if (mins < 1) return 'just now'
    if (mins < 60) return `${mins}m ago`
    const hours = Math.floor(mins / 60)
    if (hours < 24) return `${hours}h ago`
    return `${Math.floor(hours / 24)}d ago`
  } catch {
    return ''
  }
}

function RoutineRunsList({ routineId }: { routineId: string }) {
  const { runs, isLoading } = useRoutineRuns(routineId)
  if (isLoading) return <div className="exec-muted">Loading runs…</div>
  if (runs.length === 0) return <div className="exec-muted">No runs yet</div>
  return (
    <div className="exec-runs" role="list" aria-label="Recent routine runs">
      {runs.slice(0, 5).map((run) => (
        <div key={run.id} className="exec-run" role="listitem" data-run-status={run.status}>
          <span className="exec-run__status">{run.status}</span>
          <span className="exec-run__issue">{run.source}{run.failureReason ? ` — ${run.failureReason.slice(0, 60)}` : ''}</span>
          <span className="exec-run__time">{relTime(run.completedAt ?? run.createdAt)}</span>
        </div>
      ))}
    </div>
  )
}

function RoutineCard({
  routine,
  orgId,
  canRun,
  canManage,
  onInjectChat,
}: {
  routine: Routine
  orgId?: string
  canRun: boolean
  canManage: boolean
  onInjectChat: (msg: string) => void
}) {
  const [expanded, setExpanded] = useState(false)
  const routineAction = useRoutineAction(orgId)
  const paused = routine.status === 'paused'

  return (
    <div className="exec-row-wrap" data-routine-status={routine.status}>
      <button
        className={`exec-row ${expanded ? 'exec-row--expanded' : ''}`}
        onClick={() => setExpanded(!expanded)}
        aria-expanded={expanded}
      >
        <span className="exec-row__title">{routine.title}</span>
        {routine.assigneeName && <span className="exec-row__id">→ {routine.assigneeName}</span>}
        <span className="exec-row__state" data-routine-status={routine.status}>{routine.status}</span>
      </button>

      {expanded && (
        <div className="exec-drawer">
          {routine.description && <p className="exec-drawer__desc">{routine.description.length > 300 ? routine.description.slice(0, 297) + '…' : routine.description}</p>}
          <div className="exec-drawer__meta">
            {routine.updatedAt && <span>updated {relTime(routine.updatedAt)}</span>}
          </div>

          <RoutineRunsList routineId={routine.id} />

          <div className="agent-card__actions">
            {canRun && (
              <button
                className="feed-filter-btn"
                disabled={routineAction.isPending || paused}
                title={paused ? 'Resume the routine before firing it' : undefined}
                onClick={() => routineAction.mutate({ routineId: routine.id, action: 'run' })}
              >
                {routineAction.isPending ? '…' : 'Run now'}
              </button>
            )}
            {canManage && (
              <button
                className="feed-filter-btn"
                disabled={routineAction.isPending}
                onClick={() => routineAction.mutate({ routineId: routine.id, action: paused ? 'resume' : 'pause' })}
              >
                {paused ? 'Resume' : 'Pause'}
              </button>
            )}
            <button
              className="feed-filter-btn"
              onClick={() => onInjectChat(`Tell me about the "${routine.title}" routine: its schedule, recent run outcomes, and any failures.`)}
            >
              Ask the assistant
            </button>
          </div>

          {routineAction.error && (
            <div className="exec-error" role="alert">{(routineAction.error as Error).message}</div>
          )}
        </div>
      )}
    </div>
  )
}

export function RoutinesTabView({
  orgId,
  userRole,
  onInjectChat,
  onInjectAction,
}: {
  orgId?: string
  userRole?: string
  onInjectChat: (msg: string) => void
  // Action-style inject → Interview Mode (create_routine, gate-token-guarded)
  onInjectAction: (msg: string) => void
}) {
  const { routines, isLoading, error, refetch } = useRoutinesPanel(orgId)
  const rank = ROLE_RANK[userRole ?? ''] ?? 0
  const canRun = rank >= ROLE_RANK.staff
  const canManage = rank >= ROLE_RANK.admin

  if (!orgId) {
    return <div className="exec-muted" style={{ padding: 'var(--space-3)' }}>Select a workspace to see its routines.</div>
  }

  return (
    <div className="exec-tab" role="tabpanel" aria-label="Routines">
      {canManage && (
        <button
          className="feed-filter-btn"
          style={{ alignSelf: 'flex-start' }}
          onClick={() => onInjectAction('I want to create a new routine — recurring scheduled agent work. Guide me.')}
        >
          + New routine
        </button>
      )}

      {isLoading ? (
        <div className="exec-muted">Loading routines…</div>
      ) : error ? (
        <div className="feed-empty" role="alert">
          <div className="feed-empty__text">Unable to load routines</div>
          <button className="feed-filter-btn" onClick={() => refetch()} style={{ marginTop: 'var(--space-2)' }}>Retry</button>
        </div>
      ) : routines.length === 0 ? (
        <div className="exec-muted">No routines yet — recurring agent work lands here.</div>
      ) : (
        <div role="list" aria-label="Routine list">
          {routines.map((routine) => (
            <RoutineCard
              key={routine.id}
              routine={routine}
              orgId={orgId}
              canRun={canRun}
              canManage={canManage}
              onInjectChat={onInjectChat}
            />
          ))}
        </div>
      )}
    </div>
  )
}
