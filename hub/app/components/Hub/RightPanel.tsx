'use client'

import { ProjectHealthSection } from '@/app/components/LeftPanelSections'
import { ExecutionFeed } from '@/app/components/RightPanelSections'
import type { ProjectKPI } from '@/types'

export interface RightPanelProps {
  isOpen?: boolean
  onClose?: () => void
  onInjectChat: (msg: string, useCase?: string) => void
  panelRef?: React.Ref<HTMLElement>
  style?: React.CSSProperties
  projects?: ProjectKPI[]
  activeProject?: string
  userRole?: string
  kpiLoading?: boolean
  onCustomizeCSuite: (orgId: string, orgName: string) => void
  activeOrgId?: string
}

export function RightPanel({
  isOpen,
  onClose,
  onInjectChat,
  panelRef,
  style,
  projects,
  activeProject,
  userRole,
  kpiLoading,
  onCustomizeCSuite,
  activeOrgId,
}: RightPanelProps) {
  // Build Paperclip workspace URL from the active project
  const paperclipBaseUrl = process.env.NEXT_PUBLIC_PAPERCLIP_URL || 'https://rxfit-paperclip-11747747730.us-central1.run.app'
  const activeCompany = projects?.find(p => p.identifier?.toLowerCase() === activeProject?.toLowerCase() || p.companyName?.toLowerCase().includes(activeProject?.toLowerCase() || ''))
  const paperclipUrl = activeCompany?.companyId
    ? `${paperclipBaseUrl}/companies/${activeCompany.companyId}`
    : paperclipBaseUrl

  return (
    <aside ref={panelRef} className={`panel-right ${isOpen ? 'mobile-open' : ''}`} aria-label="Execution Layer" style={style}>
      <div className="panel-header">
        <h2 className="panel-title">
          <span className="panel-title-display">Execution</span>
        </h2>
        <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
          <a
            href={paperclipUrl}
            target="_blank"
            rel="noopener noreferrer"
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: '4px',
              padding: '4px 10px',
              fontSize: '0.7rem',
              fontWeight: 600,
              color: 'var(--accent-gold)',
              border: '1px solid var(--accent-gold)',
              borderRadius: 'var(--radius-md)',
              textDecoration: 'none',
              transition: 'all 0.15s ease',
              opacity: 0.85,
            }}
            onMouseEnter={(e) => { (e.target as HTMLElement).style.opacity = '1'; (e.target as HTMLElement).style.background = 'rgba(197,160,89,0.1)' }}
            onMouseLeave={(e) => { (e.target as HTMLElement).style.opacity = '0.85'; (e.target as HTMLElement).style.background = 'transparent' }}
            aria-label="Open Paperclip workspace"
          >
            📎 Paperclip →
          </a>
          {onClose && (
            <button className="panel-close-btn" onClick={onClose} aria-label="Close Execution Layer">
              &times;
            </button>
          )}
        </div>
      </div>

      <div className="panel-content">
        <ProjectHealthSection projects={projects} onInjectChat={onInjectChat} userRole={userRole} isLoading={kpiLoading} />
        <ExecutionFeed onInjectChat={onInjectChat} onCustomizeCSuite={onCustomizeCSuite} orgId={activeOrgId || activeCompany?.companyId} />
      </div>
    </aside>
  )
}
