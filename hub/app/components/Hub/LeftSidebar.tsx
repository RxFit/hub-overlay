'use client'

import { useTenant } from '@/app/components/TenantProvider'
import { KPISection, CalendarSection, TasksSection, DocumentsSection } from '@/app/components/LeftPanelSections'

export interface LeftSidebarProps {
  isOpen?: boolean
  onClose?: () => void
  onInjectChat: (msg: string, useCase?: string) => void
  panelRef?: React.Ref<HTMLElement>
  style?: React.CSSProperties
  activeProject?: string
  workspaceName?: string
}

export function LeftSidebar({ isOpen, onClose, onInjectChat, panelRef, style, activeProject, workspaceName }: LeftSidebarProps) {
  const tenant = useTenant()
  return (
    <aside ref={panelRef} className={`panel-left ${isOpen ? 'mobile-open' : ''}`} aria-label="Context Layer" style={style}>
      <div className="panel-header">
        <h2 className="panel-title">
          <span className="panel-title-display">{workspaceName || tenant?.name || 'Business'}</span>
        </h2>
        {onClose && (
          <button className="panel-close-btn" onClick={onClose} aria-label="Close Context Layer">
            &times;
          </button>
        )}
      </div>

      <div className="panel-content">
        <KPISection activeProject={activeProject} onInjectChat={onInjectChat} />
        <CalendarSection onInjectChat={onInjectChat} />
        <TasksSection onInjectChat={onInjectChat} />
        <DocumentsSection onInjectChat={onInjectChat} />
      </div>
    </aside>
  )
}
