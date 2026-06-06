'use client'

import { useState, useCallback } from 'react'
import { useBusinessManager, healthToColor, roleLabel } from '@/app/hooks/useBusinessManager'
import type { DepartmentPulse, StallState } from '@/types'

/* ══════════════════════════════════════════════════════════════════════════════
   HEALTH RING — animated SVG circle showing global org health %
   ══════════════════════════════════════════════════════════════════════════════ */

function HealthRing({ pct, size = 56 }: { pct: number; size?: number }) {
  const r = (size - 8) / 2
  const circumference = 2 * Math.PI * r
  const offset = circumference - (pct / 100) * circumference
  const color = pct >= 80 ? 'var(--bm-green)' : pct >= 50 ? 'var(--bm-amber)' : 'var(--bm-red)'

  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden="true">
      {/* Track */}
      <circle
        cx={size / 2} cy={size / 2} r={r}
        fill="none"
        stroke="rgba(255,255,255,0.08)"
        strokeWidth={5}
      />
      {/* Progress */}
      <circle
        cx={size / 2} cy={size / 2} r={r}
        fill="none"
        stroke={color}
        strokeWidth={5}
        strokeDasharray={circumference}
        strokeDashoffset={offset}
        strokeLinecap="round"
        transform={`rotate(-90 ${size / 2} ${size / 2})`}
        style={{ transition: 'stroke-dashoffset 0.8s cubic-bezier(0.16, 1, 0.3, 1), stroke 0.4s ease' }}
      />
      {/* Label */}
      <text
        x={size / 2} y={size / 2 + 4}
        textAnchor="middle"
        fontSize="11"
        fontWeight="700"
        fill={color}
        fontFamily="var(--font-mono, monospace)"
      >
        {pct}%
      </text>
    </svg>
  )
}

/* ══════════════════════════════════════════════════════════════════════════════
   DEPARTMENT CHIP — one per C-Suite role
   ══════════════════════════════════════════════════════════════════════════════ */

function DeptChip({
  dept,
  selected,
  onClick,
}: {
  dept: DepartmentPulse
  selected: boolean
  onClick: () => void
}) {
  const color = healthToColor(dept.status)
  const colorVar = `var(--bm-${color})`

  return (
    <button
      className={`bm-dept-chip${selected ? ' bm-dept-chip--selected' : ''}`}
      onClick={onClick}
      aria-pressed={selected}
      title={`${roleLabel(dept.role)}: ${dept.status.replace('_', ' ')}`}
    >
      {/* Health dot */}
      <span
        className="bm-dept-chip__dot"
        style={{ background: colorVar, boxShadow: `0 0 6px ${colorVar}` }}
        aria-hidden="true"
      />
      {/* Role label */}
      <span className="bm-dept-chip__label">{roleLabel(dept.role)}</span>
    </button>
  )
}

/* ══════════════════════════════════════════════════════════════════════════════
   KPI SCORECARD — expandable per-dept detail
   ══════════════════════════════════════════════════════════════════════════════ */

function KPIScorecard({ dept }: { dept: DepartmentPulse }) {
  const color = healthToColor(dept.status)
  const statusLabel = dept.status === 'ON_TRACK' ? '✓ On Track'
    : dept.status === 'DRIFTING' ? '⚠ Drifting'
    : '✕ Critical'

  return (
    <div className={`bm-scorecard bm-scorecard--${color}`} role="region" aria-label={`${roleLabel(dept.role)} scorecard`}>
      <div className="bm-scorecard__header">
        <span className="bm-scorecard__role">{roleLabel(dept.role)}</span>
        <span className={`bm-scorecard__status bm-scorecard__status--${color}`}>{statusLabel}</span>
      </div>

      {/* KPI values */}
      {(dept.kpiLabel || dept.kpiActual) && (
        <div className="bm-scorecard__kpi-row">
          {dept.kpiLabel && (
            <span className="bm-scorecard__kpi-label">{dept.kpiLabel}</span>
          )}
          {dept.kpiActual && dept.kpiTarget && (
            <span className="bm-scorecard__kpi-values">
              <strong>{dept.kpiActual}</strong>
              <span className="bm-scorecard__kpi-sep"> / </span>
              <span className="bm-scorecard__kpi-target">{dept.kpiTarget}</span>
            </span>
          )}
        </div>
      )}

      {/* Last task */}
      {dept.lastTask && (
        <div className="bm-scorecard__last-task">
          <span className="bm-scorecard__last-task-label">Last: </span>
          {dept.lastTask}
        </div>
      )}

      {/* Corrective action */}
      {dept.correctiveAction && (
        <div className="bm-scorecard__corrective">
          <span className="bm-scorecard__corrective-icon" aria-hidden="true">🔧 </span>
          {dept.correctiveAction}
        </div>
      )}

      {/* Blocked tasks badge */}
      {!!dept.blockedTasks && dept.blockedTasks > 0 && (
        <div className="bm-scorecard__blocked">
          <span>{dept.blockedTasks} blocked task{dept.blockedTasks > 1 ? 's' : ''}</span>
        </div>
      )}
    </div>
  )
}

/* ══════════════════════════════════════════════════════════════════════════════
   DRIFT ALERTS — inline banners for DRIFTING/CRITICAL departments
   ══════════════════════════════════════════════════════════════════════════════ */

function DriftAlerts({
  departments,
  stalledCount,
}: {
  departments: DepartmentPulse[]
  stalledCount: number
}) {
  const drifting = departments.filter(d => d.status === 'DRIFTING')
  const critical = departments.filter(d => d.status === 'CRITICAL')

  if (drifting.length === 0 && critical.length === 0 && stalledCount === 0) return null

  return (
    <div className="bm-alerts" role="alert" aria-label="Business Manager alerts">
      {critical.map(d => (
        <div key={d.role} className="bm-alert bm-alert--red">
          <span aria-hidden="true">✕ </span>
          <strong>{roleLabel(d.role)}</strong> is CRITICAL — needs immediate attention
        </div>
      ))}
      {drifting.map(d => (
        <div key={d.role} className="bm-alert bm-alert--amber">
          <span aria-hidden="true">⚠ </span>
          <strong>{roleLabel(d.role)}</strong> is drifting from KPI target
        </div>
      ))}
      {stalledCount > 0 && (
        <div className="bm-alert bm-alert--amber">
          <span aria-hidden="true">⏸ </span>
          {stalledCount} automated task{stalledCount > 1 ? 's' : ''} appear stalled — check the feed below
        </div>
      )}
    </div>
  )
}

/* ══════════════════════════════════════════════════════════════════════════════
   BUSINESS MANAGER PANEL (main export)
   ══════════════════════════════════════════════════════════════════════════════ */

export function BusinessManagerPanel({
  orgId,
  onCreateTask,
  stalledCount = 0,
  onCustomizeCSuite,
}: {
  orgId?: string
  onCreateTask: () => void
  stalledCount?: number
  onCustomizeCSuite: (orgId: string, orgName: string) => void
}) {
  const { pulse, globalHealthPct, orgName, isLoading } = useBusinessManager(orgId)
  const [selectedRole, setSelectedRole] = useState<string | null>(null)
  const [showScorecard, setShowScorecard] = useState(false)

  const handleChipClick = useCallback((role: string) => {
    if (selectedRole === role && showScorecard) {
      setShowScorecard(false)
      setSelectedRole(null)
    } else {
      setSelectedRole(role)
      setShowScorecard(true)
    }
  }, [selectedRole, showScorecard])

  const selectedDept = pulse?.departments.find(d => d.role === selectedRole)

  const healthLabel = globalHealthPct >= 80 ? 'Healthy'
    : globalHealthPct >= 50 ? 'Needs Attention'
    : 'Critical'

  const healthColor = globalHealthPct >= 80 ? 'var(--bm-green)'
    : globalHealthPct >= 50 ? 'var(--bm-amber)'
    : 'var(--bm-red)'

  return (
    <>
      <div className="bm-panel" role="region" aria-label="Business Manager">
        {/* ── Header ── */}
        <div className="bm-header">
          <div className="bm-header__left">
            <div className="bm-header__title">
              <span className="bm-header__dot" aria-hidden="true" />
              Business Manager
            </div>
            <div className="bm-header__org">
              {isLoading ? '—' : (orgName || 'Your Organization')}
            </div>
          </div>

          <div className="bm-header__right">
            {isLoading ? (
              <div className="bm-health-skeleton" aria-label="Loading health data" />
            ) : (
              <div className="bm-health-block">
                <HealthRing pct={globalHealthPct} />
                <span
                  className="bm-health-label"
                  style={{ color: healthColor }}
                  aria-label={`Organization health: ${globalHealthPct}% — ${healthLabel}`}
                >
                  {healthLabel}
                </span>
              </div>
            )}
          </div>
        </div>

        {/* ── C-Suite status row ── */}
        {!isLoading && pulse && pulse.departments.length > 0 && (
          <div className="bm-dept-row" role="list" aria-label="Department status">
            {pulse.departments.map(dept => (
              <div key={dept.role} role="listitem">
                <DeptChip
                  dept={dept}
                  selected={selectedRole === dept.role}
                  onClick={() => handleChipClick(dept.role)}
                />
              </div>
            ))}
          </div>
        )}

        {/* ── Skeleton chips when loading ── */}
        {isLoading && (
          <div className="bm-dept-row bm-dept-row--loading" aria-hidden="true">
            {[1, 2, 3, 4].map(i => (
              <div key={i} className="bm-dept-chip-skeleton" style={{ animationDelay: `${i * 80}ms` }} />
            ))}
          </div>
        )}

        {/* ── Expanded KPI scorecard ── */}
        {showScorecard && selectedDept && (
          <div className="bm-scorecard-container">
            <KPIScorecard dept={selectedDept} />
            <button
              className="bm-scorecard__close"
              onClick={() => { setShowScorecard(false); setSelectedRole(null) }}
              aria-label="Close scorecard"
            >
              ✕
            </button>
          </div>
        )}

        {/* ── Drift alerts ── */}
        {!isLoading && pulse && (
          <DriftAlerts
            departments={pulse.departments}
            stalledCount={stalledCount}
          />
        )}

        {/* ── CTAs ── */}
        <div className="bm-ctas">
          <button
            id="bm-create-task-btn"
            className="bm-cta bm-cta--primary"
            onClick={onCreateTask}
            aria-label="Create a new task via Interview Mode"
          >
            <span aria-hidden="true">＋</span>
            Create Task
          </button>
          <button
            id="bm-customize-csuite-btn"
            className="bm-cta bm-cta--secondary"
            onClick={() => onCustomizeCSuite(orgId ?? pulse?.orgId ?? '', orgName || 'Your Organization')}
            aria-label="Customize your C-Suite"
          >
            <span aria-hidden="true">⚙</span>
            Customize C-Suite
          </button>
          <button
            id="bm-manage-keys-btn"
            className="bm-cta bm-cta--secondary"
            onClick={() => window.location.href = '/settings#api-keys'}
            aria-label="Manage API Keys"
          >
            <span aria-hidden="true">🔑</span>
            Manage Keys
          </button>
        </div>
      </div>
    </>
  )
}
