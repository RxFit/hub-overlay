'use client'

import { useState, useRef, useEffect, useCallback, useReducer } from 'react'
import { useSpaces, useMessages, useSendMessage, useSpaceMembers, useUnreadCounts, useMarkSpaceRead } from '@/app/hooks/useGoogleChat'
import type { ChatSpace, ChatMessage, SpaceMember } from '@/app/hooks/useGoogleChat'
import { MentionPicker, useMentionTrigger } from '@/app/components/MentionPicker'
import { InfoPopover } from '@/app/components/InfoPopover'
import { GmailView } from '@/app/components/gmail/GmailView'
import { useModalA11y } from '@/app/hooks/useModalA11y'


/* ══════════════════════════════════════════
   SPACES LIST — left column
   ══════════════════════════════════════════ */

function SpaceAvatar({ space }: { space: ChatSpace }) {
  const initials = space.displayName
    ? space.displayName.split(' ').map(w => w[0]).slice(0, 2).join('').toUpperCase()
    : '#'
  const isDM = space.type === 'DM'
  return (
    <span className={`chat-space-avatar ${isDM ? 'chat-space-avatar--dm' : ''}`} aria-hidden="true">
      {isDM ? (
        <span className="rx-icon rx-icon--sm">
          <svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
            <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
            <circle cx="12" cy="7" r="4" />
          </svg>
        </span>
      ) : initials}
    </span>
  )
}

const SECTION_ORDER: { type: string; label: string; icon: string }[] = [
  { type: 'SPACE', label: 'Spaces', icon: '#' },
  { type: 'ROOM', label: 'Rooms', icon: '#' },
  { type: 'GROUP_CHAT', label: 'Group Chats', icon: '👥' },
  { type: 'DM', label: 'Direct Messages', icon: '👤' },
]

function SpacesList({
  spaces,
  selectedId,
  onSelect,
  isLoading,
  missingScope,
  unreadMap,
}: {
  spaces: ChatSpace[]
  selectedId: string | null
  onSelect: (space: ChatSpace) => void
  isLoading: boolean
  missingScope: boolean
  unreadMap: Map<string, number>
}) {
  const [collapsedSections, setCollapsedSections] = useState<Set<string>>(new Set())

  const toggleSection = (type: string) => {
    setCollapsedSections(prev => {
      const next = new Set(prev)
      if (next.has(type)) next.delete(type)
      else next.add(type)
      return next
    })
  }

  if (missingScope) {
    return (
      <div className="chat-spaces-empty">
        <div className="chat-scope-warning">
          <span className="chat-scope-warning__icon">🔐</span>
          <p>Google Chat access not yet granted.</p>
          <p className="chat-scope-warning__hint">Sign out and back in to authorize Chat permissions.</p>
        </div>
      </div>
    )
  }

  if (isLoading) {
    return (
      <div className="chat-spaces-list" aria-label="Loading spaces" role="status">
        {[1, 2, 3, 4].map(i => (
          <div key={i} className="chat-space-skeleton">
            <div className="chat-space-skeleton__avatar" />
            <div className="chat-space-skeleton__name" />
          </div>
        ))}
      </div>
    )
  }

  if (spaces.length === 0) {
    return (
      <div className="chat-spaces-empty">
        <p>No spaces visible.</p>
        <p className="chat-scope-warning__hint">Go to Settings to select which spaces to show.</p>
      </div>
    )
  }

  // Sort spaces by unread count (desc) within each type group
  const sortedSpaces = [...spaces].sort((a, b) => {
    const unreadA = unreadMap.get(a.name) ?? 0
    const unreadB = unreadMap.get(b.name) ?? 0
    return unreadB - unreadA
  })

  // Group by type
  const grouped = new Map<string, ChatSpace[]>()
  for (const space of sortedSpaces) {
    const type = space.type || 'SPACE'
    if (!grouped.has(type)) grouped.set(type, [])
    grouped.get(type)!.push(space)
  }

  // Build ordered sections (only show sections that have spaces)
  const sections = SECTION_ORDER.filter(s => grouped.has(s.type))
  // Add any types not in SECTION_ORDER
  for (const type of Array.from(grouped.keys())) {
    if (!SECTION_ORDER.find(s => s.type === type)) {
      sections.push({ type, label: type, icon: '#' })
    }
  }

  return (
    <div className="chat-spaces-list" role="listbox" aria-label="Google Chat spaces">
      {sections.map(section => {
        const sectionSpaces = grouped.get(section.type) ?? []
        const isCollapsed = collapsedSections.has(section.type)
        const sectionUnread = sectionSpaces.reduce((sum, s) => sum + (unreadMap.get(s.name) ?? 0), 0)

        return (
          <div key={section.type} className="chat-space-section">
            <button
              className="chat-space-section__header"
              onClick={() => toggleSection(section.type)}
              aria-expanded={!isCollapsed}
            >
              <span className="chat-space-section__arrow" style={{ transform: isCollapsed ? 'rotate(-90deg)' : 'rotate(0deg)' }}>▾</span>
              <span className="chat-space-section__label">{section.label}</span>
              <span className="chat-space-section__count">{sectionSpaces.length}</span>
              {sectionUnread > 0 && (
                <span className="chat-space-section__unread">{sectionUnread}</span>
              )}
            </button>
            {!isCollapsed && sectionSpaces.map(space => {
              const unread = unreadMap.get(space.name) ?? 0
              return (
                <button
                  key={space.name}
                  role="option"
                  aria-selected={selectedId === space.name}
                  className={`chat-space-item${selectedId === space.name ? ' chat-space-item--active' : ''}${unread > 0 ? ' chat-space-item--unread' : ''}`}
                  onClick={() => onSelect(space)}
                  title={space.displayName}
                >
                  <SpaceAvatar space={space} />
                  <span className="chat-space-name">{space.displayName || space.name.split('/')[1]}</span>
                  {unread > 0 && (
                    <span className="chat-space-unread-badge">{unread > 99 ? '99+' : unread}</span>
                  )}
                </button>
              )
            })}
          </div>
        )
      })}
    </div>
  )
}

/* ══════════════════════════════════════════
   MESSAGE THREAD
   ══════════════════════════════════════════ */

function MessageBubble({ msg, prevMsg }: { msg: ChatMessage; prevMsg: ChatMessage | null }) {
  const showSender = !prevMsg || prevMsg.sender.name !== msg.sender.name

  const time = (() => {
    try {
      return new Date(msg.createTime).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
    } catch { return '' }
  })()

  return (
    <div className="chat-msg">
      {showSender && (
        <div className="chat-msg__header">
          <span className="chat-msg__sender">{msg.sender.displayName}</span>
          <span className="chat-msg__time">{time}</span>
        </div>
      )}
      <div className="chat-msg__bubble">{msg.text || msg.formattedText || ''}</div>
    </div>
  )
}

function MessageThread({
  spaceId,
  spaceName,
}: {
  spaceId: string
  spaceName: string
}) {
  const { messages, isLoading } = useMessages(spaceId)
  const { send, isSending, sendError, clearError } = useSendMessage()
  const { markRead } = useMarkSpaceRead()
  const { members } = useSpaceMembers(spaceId)
  const [draft, setDraft] = useState('')
  const [cursorPos, setCursorPos] = useState(0)
  const bottomRef = useRef<HTMLDivElement>(null)
  const threadRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const composerRef = useRef<HTMLDivElement>(null)
  // Whether the user is pinned near the bottom of the thread. Starts true so the
  // initial load and a freshly-opened space scroll down. Flipped false once the
  // user scrolls up so the 30s poll no longer yanks them back to the bottom.
  const nearBottomRef = useRef(true)
  const prevSpaceRef = useRef(spaceId)

  // Mention trigger detection
  const mention = useMentionTrigger(draft, cursorPos)

  const handleThreadScroll = useCallback(() => {
    const el = threadRef.current
    if (!el) return
    const distFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight
    nearBottomRef.current = distFromBottom < 120
  }, [])

  // Auto-scroll only when appropriate: on a space switch (treated as initial
  // load) or when the user is already near the bottom. A user reading scrollback
  // is left in place on each poll instead of being force-scrolled down.
  useEffect(() => {
    if (prevSpaceRef.current !== spaceId) {
      prevSpaceRef.current = spaceId
      nearBottomRef.current = true
    }
    if (nearBottomRef.current) {
      bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
    }
  }, [messages, spaceId])

  // Viewing a space marks it read — server-side readstate write + immediate
  // local badge clear. Keyed to the latest message so each new arrival while
  // the thread is open re-marks, but poll refetches with no new mail don't.
  useEffect(() => {
    if (!messages.length) return
    markRead(spaceId, messages[messages.length - 1]?.name)
  }, [messages, spaceId, markRead])

  const handleMentionSelect = useCallback((member: SpaceMember) => {
    if (mention.atIndex === -1) return
    const before = draft.slice(0, mention.atIndex)
    const after = draft.slice(cursorPos)
    // Insert the Google Chat mention tag
    const mentionTag = member.email
      ? `<users/${member.email}>`
      : `<${member.name}>`
    const newDraft = `${before}${mentionTag} ${after}`
    setDraft(newDraft)
    // Move cursor after the inserted mention
    const newPos = before.length + mentionTag.length + 1
    setCursorPos(newPos)
    // Focus and set cursor position
    requestAnimationFrame(() => {
      if (inputRef.current) {
        inputRef.current.focus()
        inputRef.current.setSelectionRange(newPos, newPos)
      }
    })
  }, [draft, cursorPos, mention.atIndex])

  const handleSend = useCallback(async () => {
    const text = draft.trim()
    if (!text || isSending) return
    setDraft('')
    setCursorPos(0)
    if (inputRef.current) inputRef.current.style.height = 'auto'
    // The user's own send should always scroll them to the newest message, even
    // if they had scrolled up to read history.
    nearBottomRef.current = true
    await send(spaceId, text)
  }, [draft, spaceId, send, isSending])

  const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // Don't intercept Enter/Arrow when mention picker is open
    if (mention.active && members.length > 0) {
      if (['ArrowUp', 'ArrowDown', 'Enter', 'Tab', 'Escape'].includes(e.key)) {
        return // Let MentionPicker handle these
      }
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSend()
    }
  }, [handleSend, mention.active, members.length])

  const handleInputChange = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setDraft(e.target.value)
    setCursorPos(e.target.selectionStart ?? e.target.value.length)
    e.target.style.height = 'auto'
    e.target.style.height = Math.min(e.target.scrollHeight, 100) + 'px'
  }, [])

  const handleInputClick = useCallback((e: React.MouseEvent<HTMLTextAreaElement>) => {
    setCursorPos((e.target as HTMLTextAreaElement).selectionStart ?? 0)
  }, [])

  if (isLoading) {
    return (
      <div className="chat-thread chat-thread--loading" role="status" aria-label="Loading messages">
        {[1, 2, 3, 4, 5].map(i => (
          <div key={i} className="chat-msg-skeleton" style={{ width: `${50 + i * 8}%` }} />
        ))}
      </div>
    )
  }

  return (
    <div className="chat-thread-wrapper">
      {/* Space header */}
      <div className="chat-thread-header">
        <span className="chat-thread-header__name">{spaceName}</span>
      </div>

      {/* Messages */}
      <div ref={threadRef} onScroll={handleThreadScroll} className="chat-thread" role="log" aria-label={`Messages in ${spaceName}`} aria-live="polite">
        {messages.length === 0 ? (
          <div className="chat-thread__empty">No messages yet</div>
        ) : (
          messages.map((msg, i) => (
            <MessageBubble key={msg.name} msg={msg} prevMsg={messages[i - 1] ?? null} />
          ))
        )}
        <div ref={bottomRef} />
      </div>

      {/* Send error */}
      {sendError && (
        <div className="chat-send-error" role="alert">
          <span>{sendError}</span>
          <button onClick={clearError} aria-label="Dismiss error">✕</button>
        </div>
      )}

      {/* Mention picker — floats above composer */}
      {mention.active && members.length > 0 && (
        <MentionPicker
          members={members}
          filter={mention.filter}
          onSelect={handleMentionSelect}
          onClose={() => setCursorPos(0)} // Reset to dismiss
          anchorRect={composerRef.current?.getBoundingClientRect() ?? null}
        />
      )}

      {/* Composer */}
      <div className="chat-composer" ref={composerRef}>
        <textarea
          ref={inputRef}
          id="chat-composer-input"
          className="chat-composer__input"
          value={draft}
          onChange={handleInputChange}
          onClick={handleInputClick}
          onKeyDown={handleKeyDown}
          placeholder={`Message ${spaceName}… (type @ to mention)`}
          aria-label={`Compose message to ${spaceName}`}
          rows={1}
          disabled={isSending}
        />
        <div style={{ marginBottom: '11px', flexShrink: 0 }}>
          <InfoPopover
            align="left"
            content={
              <>
                <p style={{ fontWeight: 600, color: 'var(--accent)' }}>✦ Message Guidelines</p>
                <p style={{ marginTop: '6px' }}><b>Mentions:</b> Type <code>@</code> to open the space members picker and mention someone.</p>
                <p><b>Google Workspace:</b> Your message will sync directly with the Google Chat space in real time.</p>
              </>
            }
          />
        </div>
        <button
          id="chat-send-btn"
          className="chat-composer__send"
          onClick={handleSend}
          disabled={!draft.trim() || isSending}
          aria-label="Send message"
        >
          {isSending ? (
            <span className="chat-composer__spinner" aria-hidden="true" />
          ) : (
            <span className="rx-icon rx-icon--sm" aria-hidden="true">
              <svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
                <line x1="22" y1="2" x2="11" y2="13" />
                <polygon points="22 2 15 22 11 13 2 9 22 2" />
              </svg>
            </span>
          )}
        </button>
      </div>
    </div>
  )
}

export function GoogleChatPanel({
  isOpen,
  onClose,
  onDiscussEmail,
}: {
  isOpen: boolean
  onClose: () => void
  /** Injects an email summary into the AI assistant chat (page.tsx wiring). */
  onDiscussEmail?: (text: string) => void
}) {
  const { visibleSpaces, isLoading, missingScope } = useSpaces()
  const { unreadMap } = useUnreadCounts(visibleSpaces)
  const [selectedSpace, setSelectedSpace] = useState<ChatSpace | null>(null)
  const [mobileView, setMobileView] = useState<'spaces' | 'thread'>('spaces')
  const [activeTab, setActiveTab] = useState<'chat' | 'gmail'>('chat')
  const [gmailUnread, setGmailUnread] = useState(0)

  // Auto-select first space on desktop. Kept in the parent (which stays mounted)
  // so the selection persists across open/close and the space list keeps
  // prefetching while the panel is closed.
  useEffect(() => {
    if (!selectedSpace && visibleSpaces.length > 0) {
      setSelectedSpace(visibleSpaces[0])
    }
  }, [visibleSpaces, selectedSpace])

  const handleSelectSpace = (space: ChatSpace) => {
    setSelectedSpace(space)
    setMobileView('thread')
  }

  // Mount the dialog ONLY while open so useModalA11y (Tab-trap + return-focus +
  // Escape-to-close) runs its open/close lifecycle correctly — mirroring the
  // CalendarSection create/delete modals, which are likewise gated on render.
  if (!isOpen) return null

  return (
    <GoogleChatPanelDialog
      onClose={onClose}
      visibleSpaces={visibleSpaces}
      isLoading={isLoading}
      missingScope={missingScope}
      unreadMap={unreadMap}
      selectedSpace={selectedSpace}
      onSelectSpace={handleSelectSpace}
      mobileView={mobileView}
      setMobileView={setMobileView}
      activeTab={activeTab}
      setActiveTab={setActiveTab}
      gmailUnread={gmailUnread}
      setGmailUnread={setGmailUnread}
      onDiscussEmail={onDiscussEmail}
    />
  )
}

function GoogleChatPanelDialog({
  onClose,
  visibleSpaces,
  isLoading,
  missingScope,
  unreadMap,
  selectedSpace,
  onSelectSpace,
  mobileView,
  setMobileView,
  activeTab,
  setActiveTab,
  gmailUnread,
  setGmailUnread,
  onDiscussEmail,
}: {
  onClose: () => void
  visibleSpaces: ChatSpace[]
  isLoading: boolean
  missingScope: boolean
  unreadMap: Map<string, number>
  selectedSpace: ChatSpace | null
  onSelectSpace: (space: ChatSpace) => void
  mobileView: 'spaces' | 'thread'
  setMobileView: (v: 'spaces' | 'thread') => void
  activeTab: 'chat' | 'gmail'
  setActiveTab: (v: 'chat' | 'gmail') => void
  gmailUnread: number
  setGmailUnread: (v: number) => void
  onDiscussEmail?: (text: string) => void
}) {
  const panelRef = useRef<HTMLDivElement>(null)
  // Focus trap + return-focus-to-opener + Escape-to-close, shared with the
  // calendar modals. Replaces the ad-hoc focus()/Escape handlers this panel had.
  useModalA11y(panelRef, onClose)

  return (
    <>
      {/* Backdrop */}
      <div
        className="chat-panel-backdrop"
        onClick={onClose}
        aria-hidden="true"
      />

      {/* Panel */}
      <div
        ref={panelRef}
        className="chat-panel-overlay"
        role="dialog"
        aria-modal="true"
        aria-label="Google Chat"
        tabIndex={-1}
      >
        {/* Panel header */}
        <div className="chat-panel-header">
          {/* Mobile back button */}
          {activeTab === 'chat' && mobileView === 'thread' && (
            <button
              className="chat-panel-back"
              onClick={() => setMobileView('spaces')}
              aria-label="Back to spaces list"
            >
              ‹
            </button>
          )}

          {/* Tab toggle: Gmail | Chat */}
          <div style={{
            display: 'flex',
            alignItems: 'center',
            gap: '2px',
            background: 'rgba(255,255,255,0.06)',
            borderRadius: '8px',
            padding: '3px',
            flex: 1,
            maxWidth: '180px',
          }}>
            {(['gmail', 'chat'] as const).map(tab => (
              <button
                key={tab}
                onClick={() => setActiveTab(tab)}
                aria-pressed={activeTab === tab}
                style={{
                  flex: 1,
                  padding: '4px 8px',
                  borderRadius: '6px',
                  border: 'none',
                  background: activeTab === tab ? 'var(--surface-3, rgba(255,255,255,0.12))' : 'transparent',
                  color: activeTab === tab ? 'var(--text-primary)' : 'var(--text-muted)',
                  fontSize: '0.72rem',
                  fontWeight: activeTab === tab ? 700 : 400,
                  fontFamily: 'var(--font-mono)',
                  cursor: 'pointer',
                  transition: 'all 0.15s ease',
                  textTransform: 'uppercase',
                  letterSpacing: '0.05em',
                  position: 'relative',
                }}
              >
                {tab === 'gmail' ? 'Gmail' : 'Chat'}
                {tab === 'gmail' && gmailUnread > 0 && (
                  <span style={{
                    position: 'absolute',
                    top: '2px',
                    right: '4px',
                    background: 'var(--accent)',
                    color: '#000',
                    borderRadius: '10px',
                    fontSize: '0.55rem',
                    fontWeight: 800,
                    padding: '0 4px',
                    lineHeight: '14px',
                    minWidth: '14px',
                    textAlign: 'center',
                  }}>
                    {gmailUnread > 99 ? '99+' : gmailUnread}
                  </span>
                )}
              </button>
            ))}
          </div>

          <button
            className="chat-panel-close"
            onClick={onClose}
            aria-label="Close panel"
          >
            ✕
          </button>
        </div>

        {/* Panel body */}
        <div className="chat-panel-body">
          {activeTab === 'gmail' ? (
            <GmailView onUnreadCount={setGmailUnread} onDiscussEmail={onDiscussEmail} />
          ) : (
            <>
              {/* Spaces column (hidden on mobile when viewing thread) */}
              <div className={`chat-panel-spaces${mobileView === 'thread' ? ' chat-panel-spaces--mobile-hidden' : ''}`}>
                <SpacesList
                  spaces={visibleSpaces}
                  selectedId={selectedSpace?.name ?? null}
                  onSelect={onSelectSpace}
                  isLoading={isLoading}
                  missingScope={missingScope}
                  unreadMap={unreadMap}
                />
              </div>

              {/* Thread column */}
              <div className={`chat-panel-thread${mobileView === 'spaces' ? ' chat-panel-thread--mobile-hidden' : ''}`}>
                {selectedSpace ? (
                  <MessageThread
                    spaceId={selectedSpace.name}
                    spaceName={selectedSpace.displayName || selectedSpace.name}
                  />
                ) : (
                  <div className="chat-thread__empty chat-thread__select-prompt">
                    <span className="rx-icon rx-icon--lg" aria-hidden="true">
                      <svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
                        <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
                      </svg>
                    </span>
                    <p>Select a space to start chatting</p>
                  </div>
                )}
              </div>
            </>
          )}
        </div>
      </div>
    </>
  )
}
