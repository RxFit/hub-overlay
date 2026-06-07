'use client'

export type MobileTab = 'chat' | 'command' | 'execution' | 'google_chat' | 'tool_panel'

export interface MobileNavProps {
  mobileTab: MobileTab
  chatTotalUnread: number
  onTabChange: (tab: MobileTab) => void
}

export function MobileNav({ mobileTab, chatTotalUnread, onTabChange }: MobileNavProps) {
  return (
    <nav className="mobile-bottom-nav" aria-label="Mobile navigation" role="tablist">
      <button
        className={`mobile-nav-btn ${mobileTab === 'command' ? 'active' : ''}`}
        onClick={() => onTabChange('command')}
        aria-label="Tasks"
        role="tab"
        aria-selected={mobileTab === 'command'}
      >
        <span className="mobile-nav-icon" aria-hidden="true">☰</span>
        <span className="mobile-nav-label">Tasks</span>
      </button>
      <button
        className={`mobile-nav-btn mobile-nav-btn--center ${mobileTab === 'google_chat' ? 'active' : ''}`}
        onClick={() => onTabChange('google_chat')}
        aria-label={`Google Chat${chatTotalUnread > 0 ? `, ${chatTotalUnread} unread` : ''}`}
        role="tab"
        aria-selected={mobileTab === 'google_chat'}
      >
        <span className="mobile-nav-icon mobile-nav-icon--chat" aria-hidden="true" style={{ position: 'relative' }}>
          <span className="rx-icon" style={{marginTop: '4px'}}>
            <svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
              <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
            </svg>
          </span>
          {chatTotalUnread > 0 && (
            <span style={{ position: 'absolute', top: '-6px', right: '-8px', background: 'var(--accent)', color: 'var(--btn-text)', fontSize: '10px', padding: '2px 6px', borderRadius: '12px', fontWeight: 'bold' }} aria-label={`${chatTotalUnread} unread`}>
              {chatTotalUnread > 99 ? '99+' : chatTotalUnread}
            </span>
          )}
        </span>
        <span className="mobile-nav-label">Google Chat</span>
      </button>
      <button
        className={`mobile-nav-btn ${mobileTab === 'execution' ? 'active' : ''}`}
        onClick={() => onTabChange('execution')}
        aria-label="Activity"
        role="tab"
        aria-selected={mobileTab === 'execution'}
      >
        <span className="mobile-nav-icon" aria-hidden="true">⚡</span>
        <span className="mobile-nav-label">Activity</span>
      </button>
    </nav>
  )
}
