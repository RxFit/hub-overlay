'use client'

import { useState, useRef, useEffect, useCallback, useReducer } from 'react'
import { useSpaces, useMessages, useSendMessage, useSpaceMembers } from '@/app/hooks/useGoogleChat'
import type { ChatSpace, ChatMessage, SpaceMember } from '@/app/hooks/useGoogleChat'
import { MentionPicker, useMentionTrigger } from '@/app/components/MentionPicker'
import { InfoPopover } from '@/app/components/InfoPopover'
import { EmailPreviewCard } from '@/app/components/EmailPreviewCard'


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

function SpacesList({
  spaces,
  selectedId,
  onSelect,
  isLoading,
  missingScope,
}: {
  spaces: ChatSpace[]
  selectedId: string | null
  onSelect: (space: ChatSpace) => void
  isLoading: boolean
  missingScope: boolean
}) {
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

  return (
    <div className="chat-spaces-list" role="listbox" aria-label="Google Chat spaces">
      {spaces.map(space => (
        <button
          key={space.name}
          role="option"
          aria-selected={selectedId === space.name}
          className={`chat-space-item${selectedId === space.name ? ' chat-space-item--active' : ''}`}
          onClick={() => onSelect(space)}
          title={space.displayName}
        >
          <SpaceAvatar space={space} />
          <span className="chat-space-name">{space.displayName || space.name.split('/')[1]}</span>
        </button>
      ))}
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
  const { members } = useSpaceMembers(spaceId)
  const [draft, setDraft] = useState('')
  const [cursorPos, setCursorPos] = useState(0)
  const bottomRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const composerRef = useRef<HTMLDivElement>(null)

  // Mention trigger detection
  const mention = useMentionTrigger(draft, cursorPos)

  // Scroll to bottom when messages change
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

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
      <div className="chat-thread" role="log" aria-label={`Messages in ${spaceName}`} aria-live="polite">
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

/* ══════════════════════════════════════════
   GMAIL VIEW — embedded in the panel body
   ══════════════════════════════════════════ */

interface GmailThread {
  id: string
  subject: string
  from: string
  date: string
  snippet: string
  isUnread: boolean
  messageCount: number
}

interface GmailMessage {
  id: string
  from: string
  to: string
  subject: string
  date: string
  body: string
  isUnread: boolean
  inReplyTo: string
}

function GmailView({ onUnreadCount }: { onUnreadCount: (n: number) => void }) {
  const [threads, setThreads] = useState<GmailThread[]>([])
  const [selectedThread, setSelectedThread] = useState<{ id: string; messages: GmailMessage[] } | null>(null)
  const [loading, setLoading] = useState(true)
  const [threadLoading, setThreadLoading] = useState(false)
  const [reply, setReply] = useState('')
  const [sending, setSending] = useState(false)
  const [sendError, setSendError] = useState<string | null>(null)
  const [mobileView, setMobileView] = useState<'list' | 'thread'>('list')
  const bottomRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    fetch('/api/google/gmail?view=inbox&maxResults=20')
      .then(r => r.json())
      .then(d => {
        setThreads(d.threads ?? [])
        onUnreadCount(d.unreadCount ?? 0)
      })
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [onUnreadCount])

  const openThread = async (id: string) => {
    setThreadLoading(true)
    setMobileView('thread')
    try {
      const d = await fetch(`/api/google/gmail?threadId=${id}`).then(r => r.json())
      setSelectedThread(d.thread ?? null)
      // Mark as read locally
      setThreads(prev => prev.map(t => t.id === id ? { ...t, isUnread: false } : t))
      setTimeout(() => bottomRef.current?.scrollIntoView({ behavior: 'smooth' }), 100)
    } catch {}
    setThreadLoading(false)
  }

  const handleSend = async () => {
    if (!reply.trim() || !selectedThread) return
    const last = selectedThread.messages[selectedThread.messages.length - 1]
    setSending(true)
    setSendError(null)
    try {
      const res = await fetch('/api/google/gmail', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          to: last.from,
          threadId: selectedThread.id,
          inReplyTo: last.inReplyTo,
          message: reply,
        }),
      })
      const d = await res.json()
      if (!res.ok) throw new Error(d.error)
      setReply('')
      // Optimistically append reply
      setSelectedThread(prev => prev ? {
        ...prev,
        messages: [...prev.messages, {
          id: d.messageId,
          from: 'me',
          to: last.from,
          subject: last.subject,
          date: new Date().toUTCString(),
          body: reply,
          isUnread: false,
          inReplyTo: '',
        }],
      } : prev)
      setTimeout(() => bottomRef.current?.scrollIntoView({ behavior: 'smooth' }), 100)
    } catch (err) {
      setSendError(err instanceof Error ? err.message : 'Failed to send')
    }
    setSending(false)
  }

  const formatDate = (dateStr: string) => {
    try {
      const d = new Date(dateStr)
      const now = new Date()
      const isToday = d.toDateString() === now.toDateString()
      return isToday
        ? d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
        : d.toLocaleDateString([], { month: 'short', day: 'numeric' })
    } catch { return '' }
  }

  const extractName = (fromStr: string) => {
    const match = fromStr.match(/^(.+?)\s*</)
    return match ? match[1].trim() : fromStr.split('@')[0]
  }

  return (
    <div style={{ display: 'flex', height: '100%', overflow: 'hidden' }}>
      {/* Thread list */}
      <div style={{
        width: '220px',
        flexShrink: 0,
        borderRight: '1px solid var(--border)',
        overflowY: 'auto',
        display: mobileView === 'thread' ? 'none' : 'flex',
        flexDirection: 'column',
      }}
        className="chat-panel-spaces"
      >
        {loading ? (
          [1,2,3,4,5].map(i => (
            <div key={i} style={{ padding: '12px', borderBottom: '1px solid var(--border)', opacity: 0.4 }}>
              <div style={{ height: '10px', background: 'var(--surface-2)', borderRadius: '4px', marginBottom: '6px', width: '70%' }} />
              <div style={{ height: '8px', background: 'var(--surface-2)', borderRadius: '4px', width: '90%' }} />
            </div>
          ))
        ) : threads.length === 0 ? (
          <div style={{ padding: '20px', textAlign: 'center', color: 'var(--text-muted)', fontSize: '0.8rem' }}>
            No messages
          </div>
        ) : (
          threads.map(t => (
            <button
              key={t.id}
              onClick={() => openThread(t.id)}
              style={{
                display: 'block',
                width: '100%',
                textAlign: 'left',
                padding: '10px 12px',
                border: 'none',
                borderBottom: '1px solid var(--border)',
                background: selectedThread?.id === t.id ? 'var(--surface-2)' : 'transparent',
                cursor: 'pointer',
                transition: 'background 0.1s ease',
              }}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '3px' }}>
                <span style={{
                  fontSize: '0.72rem',
                  fontWeight: t.isUnread ? 700 : 400,
                  color: t.isUnread ? 'var(--text-primary)' : 'var(--text-secondary)',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                  maxWidth: '130px',
                }}>
                  {extractName(t.from)}
                </span>
                <span style={{ fontSize: '0.6rem', color: 'var(--text-muted)', flexShrink: 0 }}>
                  {formatDate(t.date)}
                </span>
              </div>
              <div style={{
                fontSize: '0.68rem',
                color: t.isUnread ? 'var(--text-primary)' : 'var(--text-muted)',
                fontWeight: t.isUnread ? 600 : 400,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}>
                {t.subject}
              </div>
              <div style={{
                fontSize: '0.62rem',
                color: 'var(--text-muted)',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
                marginTop: '2px',
              }}>
                {t.snippet}
              </div>
            </button>
          ))
        )}
      </div>

      {/* Thread detail */}
      <div style={{
        flex: 1,
        display: mobileView === 'list' ? 'none' : 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
      }}
        className="chat-panel-thread"
      >
        {/* Mobile back */}
        {mobileView === 'thread' && (
          <button
            onClick={() => setMobileView('list')}
            style={{ background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', padding: '8px 12px', textAlign: 'left', fontSize: '0.8rem' }}
          >
            ‹ Back
          </button>
        )}

        {threadLoading ? (
          <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-muted)', fontSize: '0.8rem' }}>
            Loading…
          </div>
        ) : selectedThread ? (
          <>
            {/* Messages */}
            <div style={{ flex: 1, overflowY: 'auto', padding: '12px', display: 'flex', flexDirection: 'column', gap: '12px' }}>
              {selectedThread.messages.map(msg => (
                <div key={msg.id} style={{
                  padding: '10px 12px',
                  background: 'var(--surface-2, rgba(255,255,255,0.04))',
                  borderRadius: '8px',
                  border: '1px solid var(--border)',
                }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '6px' }}>
                    <span style={{ fontSize: '0.72rem', fontWeight: 600, color: 'var(--text-secondary)' }}>
                      {extractName(msg.from)}
                    </span>
                    <span style={{ fontSize: '0.6rem', color: 'var(--text-muted)' }}>
                      {formatDate(msg.date)}
                    </span>
                  </div>
                  {msg.body && (
                    <EmailPreviewCard htmlContent={msg.body} />
                  )}
                </div>
              ))}
              <div ref={bottomRef} />
            </div>

            {/* Reply composer */}
            {sendError && (
              <div style={{ padding: '6px 12px', color: 'var(--danger)', fontSize: '0.72rem', borderTop: '1px solid var(--border)' }}>
                ⚠️ {sendError}
              </div>
            )}
            <div className="chat-composer" style={{ borderTop: '1px solid var(--border)', padding: '8px 12px', gap: '8px' }}>
              <textarea
                className="chat-composer__input"
                value={reply}
                onChange={e => setReply(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSend() } }}
                placeholder="Reply…"
                rows={1}
                disabled={sending}
                style={{ fontSize: '0.8rem' }}
              />
              <button
                className="chat-composer__send"
                onClick={handleSend}
                disabled={!reply.trim() || sending}
                aria-label="Send reply"
              >
                {sending ? (
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
          </>
        ) : (
          <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-muted)', fontSize: '0.8rem' }}>
            Select a thread
          </div>
        )}
      </div>
    </div>
  )
}

export function GoogleChatPanel({
  isOpen,
  onClose,
}: {
  isOpen: boolean
  onClose: () => void
}) {
  const { visibleSpaces, isLoading, missingScope } = useSpaces()
  const [selectedSpace, setSelectedSpace] = useState<ChatSpace | null>(null)
  const [mobileView, setMobileView] = useState<'spaces' | 'thread'>('spaces')
  const [activeTab, setActiveTab] = useState<'chat' | 'gmail'>('chat')
  const [gmailUnread, setGmailUnread] = useState(0)
  const panelRef = useRef<HTMLDivElement>(null)

  // Auto-select first space on desktop
  useEffect(() => {
    if (!selectedSpace && visibleSpaces.length > 0) {
      setSelectedSpace(visibleSpaces[0])
    }
  }, [visibleSpaces, selectedSpace])

  // Keyboard close on Escape
  useEffect(() => {
    if (!isOpen) return
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [isOpen, onClose])

  // Trap focus
  useEffect(() => {
    if (isOpen) {
      panelRef.current?.focus()
    }
  }, [isOpen])

  const handleSelectSpace = (space: ChatSpace) => {
    setSelectedSpace(space)
    setMobileView('thread')
  }

  if (!isOpen) return null

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
                aria-selected={activeTab === tab}
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
            <GmailView onUnreadCount={setGmailUnread} />
          ) : (
            <>
              {/* Spaces column (hidden on mobile when viewing thread) */}
              <div className={`chat-panel-spaces${mobileView === 'thread' ? ' chat-panel-spaces--mobile-hidden' : ''}`}>
                <SpacesList
                  spaces={visibleSpaces}
                  selectedId={selectedSpace?.name ?? null}
                  onSelect={handleSelectSpace}
                  isLoading={isLoading}
                  missingScope={missingScope}
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
