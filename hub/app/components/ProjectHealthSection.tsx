'use client'

import type { ProjectKPI } from '@/types'
import styles from './LeftPanelSections.module.css'
import { CollapsibleSection, SectionMessage, SectionError } from './LeftPanelShared'
import { RequestAccessLink } from './RequestAccessLink'

/* ══════════════════════════════════════════════════════════════════════════════
   PROJECT HEALTH SECTION — Live Paperclip data
   ══════════════════════════════════════════════════════════════════════════════ */

const HEALTH_COLORS: Record<string, string> = {
  healthy: 'var(--accent)',
  'at-risk': 'var(--warn)',
  critical: 'var(--danger)',
}

export function ProjectHealthSection({
  projects,
  onInjectChat,
  userRole,
  isLoading,
  error,
  onRetry,
}: {
  projects?: ProjectKPI[]
  onInjectChat: (msg: string) => void
  userRole?: string
  isLoading?: boolean
  error?: unknown
  onRetry?: () => void
}) {
  if (isLoading) {
    return (
      <CollapsibleSection title="Project Health" protocolNum="05" defaultOpen={false}>
        <div className={styles.lpsSkeletonBlock} aria-label="Loading project health" role="status">
          {[1, 2, 3].map(i => (
            <div key={i} className={styles.lpsSkeletonLine} style={{ width: `${85 - i * 10}%`, height: '38px', marginBottom: '6px', borderRadius: '8px' }} />
          ))}
        </div>
      </CollapsibleSection>
    )
  }

  // A fetch FAILURE is distinct from "no companies / no projects" — never show
  // the empty copy when the cause is an error.
  if (error) {
    return (
      <CollapsibleSection title="Project Health" protocolNum="05" defaultOpen={false}>
        <SectionError message="Unable to load project health — try again." onRetry={onRetry} />
      </CollapsibleSection>
    )
  }

  if (!projects || projects.length === 0) {
    const isStaff = userRole === 'staff'
    const emptyMsg =
      userRole === 'superadmin' || userRole === 'admin'
        ? 'No companies in Paperclip yet.'
        : isStaff
          ? 'No projects assigned — contact your admin to get access.'
          : 'No project data'
    return (
      <CollapsibleSection title="Project Health" protocolNum="05" defaultOpen={false}>
        <SectionMessage message={emptyMsg} type="empty" />
        {isStaff && (
          <div style={{ marginTop: '6px', paddingLeft: '2px', fontSize: '0.72rem' }}>
            <RequestAccessLink role={userRole} reason="No projects assigned in Project Health" />
          </div>
        )}
      </CollapsibleSection>
    )
  }

  return (
    <CollapsibleSection title="Project Health" protocolNum="05" defaultOpen={false}>
      <div className={styles.projectHealthList} role="list" aria-label="Project health status">
        {projects.map((p) => {
          const statusColor = HEALTH_COLORS[p.health] ?? 'var(--text-muted)'
          const abbr = (p.identifier ?? p.companyName ?? '??').slice(0, 3).toUpperCase()
          return (
            <div
              key={p.companyId}
              role="listitem"
              tabIndex={0}
              aria-label={`${p.companyName}: ${p.health}`}
              className={`project-health-item project-health-item--live`}
              onClick={() => onInjectChat(`Show me the health status for ${p.companyName}`)}
              onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onInjectChat(`Show me the health status for ${p.companyName}`) } }}
            >
              <span
                aria-hidden="true"
                className={styles.projectHealthBadge}
                style={{
                  background: `${statusColor}1a`,
                  border: `1px solid ${statusColor}44`,
                  color: statusColor,
                }}
              >
                {abbr}
              </span>
              <span className={styles.projectHealthName}>{p.companyName}</span>
              <span className="project-health-stats">
                {p.openIssues} open · {p.completionRate}%
              </span>
              <span
                aria-hidden="true"
                className={`project-status-pulse ${styles.projectHealthStatusDot}`}
                style={{
                  background: statusColor,
                  boxShadow: `0 0 6px ${statusColor}`,
                }}
              />
            </div>
          )
        })}
      </div>
    </CollapsibleSection>
  )
}

