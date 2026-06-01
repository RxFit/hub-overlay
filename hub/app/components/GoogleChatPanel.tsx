'use client'

import { useState, useRef, useEffect, useCallback } from 'react'
import { useSpaces, useMessages, useSendMessage, useSpaceMembers } from '@/app/hooks/useGoogleChat'
import type { ChatSpace, ChatMessage, SpaceMember } from '@/app/hooks/useGoogleChat'
import { MentionPicker, useMentionTrigger } from '@/app/components/MentionPicker'

/* ══════════════════════════════════════════
   CHAT BOTTOM BAR — always-visible pill
   ══════════════════════════════════════════ */

export function ChatBottomBar({
  unreadCount,
  onOpen,
}: {
  unreadCount: number
  onOpen: () => void
}) {
  return (
    <div className="chat-bottom-bar" aria-label="Google Chat" role="complementary">
      <button
        id="chat-bottom-bar-btn"
        className="chat-bottom-bar__pill"
        onClick={onOpen}
        aria-label={`Open Google Chat${unreadCount > 0 ? `, ${unreadCount} unread` : ''}`}
      >
        {/* Chat bubble icon */}
        <svg
          aria-hidden="true"
          width="18"
          height="18"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
        </svg>
        <span className="chat-bottom-bar__label">Chat</span>
        {unreadCount > 0 && (
          <span className="chat-bottom-bar__badge" aria-label={`${unreadCount} unread`}>
            {unreadCount > 99 ? '99+' : unreadCount}
          </span>
        )}
      </button>
    </div>
  )
}

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
        <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
          <path d="M12 12c2.7 0 4.8-2.1 4.8-4.8S14.7 2.4 12 2.4 7.2 4.5 7.2 7.2 9.3 12 12 12zm0 2.4c-3.2 0-9.6 1.6-9.6 4.8v2.4h19.2v-2.4c0-3.2-6.4-4.8-9.6-4.8z" />
        </svg>
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
            <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
              <path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z" />
            </svg>
          )}
        </button>
      </div>
    </div>
  )
}

/* ══════════════════════════════════════════
   MAIN PANEL — full modal overlay
   ══════════════════════════════════════════ */

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
          {mobileView === 'thread' && (
            <button
              className="chat-panel-back"
              onClick={() => setMobileView('spaces')}
              aria-label="Back to spaces list"
            >
              ‹
            </button>
          )}

          <div className="chat-panel-header__title">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
            </svg>
            <span>Google Chat</span>
          </div>

          <button
            className="chat-panel-close"
            onClick={onClose}
            aria-label="Close Google Chat"
          >
            ✕
          </button>
        </div>

        {/* Panel body */}
        <div className="chat-panel-body">
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
                <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
                  <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
                </svg>
                <p>Select a space to start chatting</p>
              </div>
            )}
          </div>
        </div>
      </div>
    </>
  )
}
