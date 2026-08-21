'use client'

import { useState, useRef, useEffect, useCallback, useReducer } from 'react'
import { useSpaces, useMessages, useSendMessage, useSpaceMembers, useUnreadCounts, useMarkSpaceRead, useLegacyPinnedSpaceMigration } from '@/app/hooks/useGoogleChat'
import type { ChatSpace, ChatMessage, ChatThreadTarget, SpaceMember } from '@/app/hooks/useGoogleChat'
import { MentionPicker, useMentionTrigger } from '@/app/components/MentionPicker'
import { InfoPopover } from '@/app/components/InfoPopover'
import { GmailView } from '@/app/components/gmail/GmailView'
import { useModalA11y } from '@/app/hooks/useModalA11y'
import { classifyChatSpace, type ChatSpaceKind } from '@/lib/chat-spaces'
import {
  groupMessagesByThread,
  spaceSupportsThreadReplies,
  threadLastActivity,
  threadReplyCount,
  type ThreadGroup,
} from '@/lib/chat-threads'
import { renderableAttachments, type AttachmentKind } from '@/lib/chat-attachments'
import { tokenizeChatMarkup } from '@/lib/chat-markup'


/* ══════════════════════════════════════════
   SPACES LIST — left column
   ══════════════════════════════════════════ */

function SpaceAvatar({ space }: { space: ChatSpace }) {
  const initials = space.displayName
    ? space.displayName.split(' ').map(w => w[0]).slice(0, 2).join('').toUpperCase()
    : '#'
  // Classify rather than test `type === 'DM'`: in the Chat API that deprecated
  // value means a Chat-APP conversation, while a human DM reports `ROOM`. The
  // old check therefore never matched a real person-to-person DM.
  const kind = spaceKind(space)
  const isDM = kind === 'dm'
  if (kind === 'bot') {
    // A Chat app conversation (e.g. the Hermes agent) — robot glyph, not initials.
    return (
      <span className="chat-space-avatar chat-space-avatar--bot" aria-hidden="true">
        <span className="rx-icon rx-icon--sm">
          <svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
            <rect x="4" y="8" width="16" height="12" rx="2" />
            <path d="M12 8V4M8 4h8" />
            <circle cx="9" cy="13" r="1" />
            <circle cx="15" cy="13" r="1" />
            <path d="M9 17h6" />
          </svg>
        </span>
      </span>
    )
  }
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

/**
 * Sidebar sections, keyed by the classifier in lib/chat-spaces.ts rather than
 * by the Chat API's deprecated `type` field. That field reports `ROOM` for
 * named spaces, group chats AND human DMs alike, so the previous grouping filed
 * every direct message under "Rooms" and left "Direct Messages" permanently
 * empty.
 */
const SECTION_ORDER: { kind: ChatSpaceKind; label: string; icon: string }[] = [
  { kind: 'named', label: 'Spaces', icon: '#' },
  { kind: 'group', label: 'Group & Meet Chats', icon: '👥' },
  { kind: 'dm', label: 'Direct Messages', icon: '👤' },
  { kind: 'bot', label: 'Apps', icon: '🤖' },
]

/** A space's kind — server-annotated when available, computed otherwise. */
function spaceKind(space: ChatSpace): ChatSpaceKind {
  return space.kind ?? classifyChatSpace(space)
}

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
  const [collapsedSections, setCollapsedSections] = useState<Set<ChatSpaceKind>>(new Set())

  const toggleSection = (kind: ChatSpaceKind) => {
    setCollapsedSections(prev => {
      const next = new Set(prev)
      if (next.has(kind)) next.delete(kind)
      else next.add(kind)
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

  // Group by classified kind
  const grouped = new Map<ChatSpaceKind, ChatSpace[]>()
  for (const space of sortedSpaces) {
    const kind = spaceKind(space)
    if (!grouped.has(kind)) grouped.set(kind, [])
    grouped.get(kind)!.push(space)
  }

  // Build ordered sections (only show sections that have spaces). Every kind
  // the classifier can return is covered by SECTION_ORDER, so there is no
  // unlabeled remainder to append.
  const sections = SECTION_ORDER.filter(s => grouped.has(s.kind))

  return (
    <div className="chat-spaces-list" role="listbox" aria-label="Google Chat spaces">
      {sections.map(section => {
        const sectionSpaces = grouped.get(section.kind) ?? []
        const isCollapsed = collapsedSections.has(section.kind)
        const sectionUnread = sectionSpaces.reduce((sum, s) => sum + (unreadMap.get(s.name) ?? 0), 0)

        return (
          <div key={section.kind} className="chat-space-section">
            <button
              className="chat-space-section__header"
              onClick={() => toggleSection(section.kind)}
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

function formatMsgTime(iso: string): string {
  try {
    return new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
  } catch { return '' }
}

const ATTACHMENT_ICONS: Record<AttachmentKind, string> = {
  image: '🖼️',
  video: '🎬',
  audio: '🎵',
  pdf: '📄',
  file: '📎',
}

/**
 * Chat markup → React elements. Tokens only, no HTML strings, so message
 * content can never smuggle markup; links are forced into new tabs with an
 * opener-safe rel.
 */
function renderChatMarkup(text: string): React.ReactNode[] {
  return tokenizeChatMarkup(text).map((tok, i) => {
    switch (tok.type) {
      case 'bold': return <strong key={i}>{tok.text}</strong>
      case 'italic': return <em key={i}>{tok.text}</em>
      case 'strike': return <del key={i}>{tok.text}</del>
      case 'code': return <code key={i} className="chat-msg__code">{tok.text}</code>
      case 'codeblock': return <pre key={i} className="chat-msg__codeblock">{tok.text}</pre>
      case 'link':
        return (
          <a key={i} href={tok.href} target="_blank" rel="noopener noreferrer" className="chat-msg__link">
            {tok.text}
          </a>
        )
      default: return <span key={i}>{tok.text}</span>
    }
  })
}

function MessageBubble({
  msg,
  prevMsg,
  onReplyInThread,
}: {
  msg: ChatMessage
  prevMsg: ChatMessage | null
  /** When set, a hover/focus "Reply in thread" action shows on the message. */
  onReplyInThread?: () => void
}) {
  const showSender = !prevMsg || prevMsg.sender.name !== msg.sender.name
  const time = formatMsgTime(msg.createTime)
  const isApp = (msg.sender.type ?? '').toUpperCase() === 'BOT'
  const bodyText = msg.text || msg.formattedText || ''
  const attachments = renderableAttachments(msg.attachment)
  // Apps often send card-only messages (no text body the REST list exposes) —
  // an empty bubble reads as a bug, so say what it actually is.
  const cardOnly = !bodyText && attachments.length === 0 && (msg.cardsV2?.length ?? 0) > 0

  return (
    <div className="chat-msg">
      {showSender && (
        <div className="chat-msg__header">
          <span className="chat-msg__sender">{msg.sender.displayName}</span>
          {isApp && <span className="chat-msg__app-badge">APP</span>}
          <span className="chat-msg__time">{time}</span>
        </div>
      )}
      {/* Attachment-only messages skip the text bubble — chips carry the message. */}
      {(bodyText || cardOnly || attachments.length === 0) && (
        <div className="chat-msg__bubble">
          {cardOnly ? (
            <span className="chat-msg__card-note">Interactive card — open Google Chat to view it.</span>
          ) : (
            renderChatMarkup(bodyText)
          )}
        </div>
      )}
      {attachments.length > 0 && (
        <div className="chat-msg__attachments">
          {attachments.map(a => {
            const inner = (
              <>
                <span aria-hidden="true">{ATTACHMENT_ICONS[a.kind]}</span>
                <span className="chat-msg-attachment__name">{a.label}</span>
              </>
            )
            return a.href ? (
              <a
                key={a.key}
                className="chat-msg-attachment"
                href={a.href}
                target="_blank"
                rel="noopener noreferrer"
              >
                {inner}
              </a>
            ) : (
              <span
                key={a.key}
                className="chat-msg-attachment chat-msg-attachment--nolink"
                title="Open in Google Chat to view this file"
              >
                {inner}
              </span>
            )
          })}
        </div>
      )}
      {onReplyInThread && (
        <button
          type="button"
          className="chat-msg__reply-action"
          onClick={onReplyInThread}
          aria-label="Reply in thread"
          title="Reply in thread"
        >
          <span className="rx-icon rx-icon--sm" aria-hidden="true">
            <svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
              <polyline points="9 17 4 12 9 7" />
              <path d="M20 18v-2a4 4 0 0 0-4-4H4" />
            </svg>
          </span>
        </button>
      )}
    </div>
  )
}

/**
 * One collapsed thread in the main conversation — the starter message plus a
 * "N replies" chip, exactly how official Google Chat presents threads inline.
 */
function ThreadGroupBlock({
  group,
  prevRoot,
  canReply,
  onOpenThread,
}: {
  group: ThreadGroup<ChatMessage>
  prevRoot: ChatMessage | null
  canReply: boolean
  onOpenThread: (threadName: string) => void
}) {
  const replies = threadReplyCount(group)
  const openable = canReply && !!group.threadName

  return (
    <div className="chat-thread-group">
      <MessageBubble
        msg={group.root}
        prevMsg={prevRoot}
        onReplyInThread={openable ? () => onOpenThread(group.threadName!) : undefined}
      />
      {openable && replies > 0 && (
        <button
          type="button"
          className="chat-thread-chip"
          onClick={() => onOpenThread(group.threadName!)}
          aria-label={`Open thread — ${replies} ${replies === 1 ? 'reply' : 'replies'}`}
        >
          <span className="rx-icon rx-icon--sm" aria-hidden="true">
            <svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
              <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
            </svg>
          </span>
          <span className="chat-thread-chip__count">
            {replies} {replies === 1 ? 'reply' : 'replies'}
          </span>
          <span className="chat-thread-chip__time">{formatMsgTime(threadLastActivity(group))}</span>
        </button>
      )}
    </div>
  )
}

/* ══════════════════════════════════════════
   COMPOSER — shared by the space view and the thread view
   ══════════════════════════════════════════ */

function MessageComposer({
  spaceId,
  members,
  thread,
  placeholder,
  ariaLabel,
  autoFocus,
  onSendStart,
}: {
  spaceId: string
  members: SpaceMember[]
  /** Present in the thread view — replies land in this thread. */
  thread?: ChatThreadTarget
  placeholder: string
  ariaLabel: string
  autoFocus?: boolean
  /** Called synchronously as a send begins (the space view re-pins its scroll). */
  onSendStart?: () => void
}) {
  const { send, isSending, sendError, clearError } = useSendMessage()
  const [draft, setDraft] = useState('')
  const [cursorPos, setCursorPos] = useState(0)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const composerRef = useRef<HTMLDivElement>(null)
  const threadName = thread?.threadName
  const threadKey = thread?.threadKey

  // Mention trigger detection
  const mention = useMentionTrigger(draft, cursorPos)

  useEffect(() => {
    if (autoFocus) inputRef.current?.focus()
  }, [autoFocus])

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
    onSendStart?.()
    await send(
      spaceId,
      text,
      threadName || threadKey ? { threadName, threadKey } : undefined
    )
  }, [draft, spaceId, send, isSending, threadName, threadKey, onSendStart])

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

  return (
    <>
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
          placeholder={placeholder}
          aria-label={ariaLabel}
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
                {thread ? (
                  <p><b>Threads:</b> This reply stays inside the thread you opened — teammates following the thread are notified.</p>
                ) : (
                  <p><b>Google Workspace:</b> Your message will sync directly with the Google Chat space in real time.</p>
                )}
              </>
            }
          />
        </div>
        <button
          id="chat-send-btn"
          className="chat-composer__send"
          onClick={handleSend}
          disabled={!draft.trim() || isSending}
          aria-label={thread ? 'Send reply' : 'Send message'}
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
    </>
  )
}

/* ══════════════════════════════════════════
   THREAD VIEW — one thread, opened from the space view
   ══════════════════════════════════════════ */

function ThreadPanel({
  space,
  threadName,
  members,
  onBack,
}: {
  space: ChatSpace
  threadName: string
  members: SpaceMember[]
  onBack: () => void
}) {
  const spaceId = space.name
  const spaceLabel = space.displayName || space.name.split('/')[1]
  // Thread-scoped fetch: the server filters by thread.name, so the panel shows
  // the COMPLETE thread even when its replies predate the space view's window.
  const { messages, isLoading } = useMessages(spaceId, threadName)
  const { markRead } = useMarkSpaceRead()
  const bottomRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  // Reading the thread reads the space — same contract as the space view.
  useEffect(() => {
    if (!messages.length) return
    markRead(spaceId, messages[messages.length - 1]?.name)
  }, [messages, spaceId, markRead])

  const root = messages[0] ?? null
  const replies = messages.slice(1)

  return (
    <div className="chat-thread-wrapper">
      <div className="chat-thread-header chat-thread-header--thread">
        <button
          type="button"
          className="chat-thread-back"
          onClick={onBack}
          aria-label="Back to conversation"
        >
          ‹
        </button>
        <div className="chat-thread-header__titles">
          <span className="chat-thread-header__name">Thread</span>
          <span className="chat-thread-header__sub">{spaceLabel}</span>
        </div>
      </div>

      <div className="chat-thread" role="log" aria-label={`Thread in ${spaceLabel}`} aria-live="polite">
        {isLoading ? (
          [1, 2, 3].map(i => (
            <div key={i} className="chat-msg-skeleton" style={{ width: `${55 + i * 10}%` }} />
          ))
        ) : !root ? (
          <div className="chat-thread__empty">No messages in this thread yet</div>
        ) : (
          <>
            <MessageBubble msg={root} prevMsg={null} />
            {replies.length > 0 && (
              <div className="chat-thread-divider" aria-hidden="true">
                <span>{replies.length} {replies.length === 1 ? 'reply' : 'replies'}</span>
              </div>
            )}
            {replies.map((m, i) => (
              <MessageBubble key={m.name} msg={m} prevMsg={replies[i - 1] ?? null} />
            ))}
          </>
        )}
        <div ref={bottomRef} />
      </div>

      <MessageComposer
        spaceId={spaceId}
        members={members}
        thread={{ threadName }}
        placeholder="Reply in thread…"
        ariaLabel={`Reply in thread in ${spaceLabel}`}
        autoFocus
      />
    </div>
  )
}

function MessageThread({ space }: { space: ChatSpace }) {
  const spaceId = space.name
  const spaceName = space.displayName || space.name.split('/')[1]
  const { messages, isLoading } = useMessages(spaceId)
  const { markRead } = useMarkSpaceRead()
  const { members } = useSpaceMembers(spaceId)
  // Reply-in-thread only where Google supports it (named spaces). DMs and
  // group chats — including app DMs like Hermes — stay flat, as in Google Chat.
  const threadsEnabled = spaceSupportsThreadReplies(space)
  const [openThreadName, setOpenThreadName] = useState<string | null>(null)
  const bottomRef = useRef<HTMLDivElement>(null)
  const threadRef = useRef<HTMLDivElement>(null)
  // Whether the user is pinned near the bottom of the thread. Starts true so the
  // initial load and a freshly-opened space scroll down. Flipped false once the
  // user scrolls up so the 30s poll no longer yanks them back to the bottom.
  const nearBottomRef = useRef(true)
  const prevSpaceRef = useRef(spaceId)

  // Switching spaces closes any open thread — it belongs to the old space.
  useEffect(() => {
    setOpenThreadName(null)
  }, [spaceId])

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

  // A thread is open: the column shows that thread alone (root, replies and a
  // composer that replies INTO it), with a back button to the conversation —
  // Google Chat's own thread-panel flow.
  if (openThreadName) {
    return (
      <ThreadPanel
        space={space}
        threadName={openThreadName}
        members={members}
        onBack={() => setOpenThreadName(null)}
      />
    )
  }

  if (isLoading) {
    return (
      <div className="chat-thread chat-thread--loading" role="status" aria-label="Loading messages">
        {[1, 2, 3, 4, 5].map(i => (
          <div key={i} className="chat-msg-skeleton" style={{ width: `${50 + i * 8}%` }} />
        ))}
      </div>
    )
  }

  // In threaded spaces the flat API page is collapsed Google Chat-style: each
  // thread renders once (its starter + reply-count chip) instead of replies
  // interleaving with unrelated messages.
  const groups = threadsEnabled ? groupMessagesByThread(messages) : null

  return (
    <div className="chat-thread-wrapper">
      {/* Space header */}
      <div className="chat-thread-header">
        <span className="chat-thread-header__name">{spaceName}</span>
        {space.singleUserBotDm && <span className="chat-msg__app-badge">APP</span>}
      </div>

      {/* Messages */}
      <div ref={threadRef} onScroll={handleThreadScroll} className="chat-thread" role="log" aria-label={`Messages in ${spaceName}`} aria-live="polite">
        {messages.length === 0 ? (
          <div className="chat-thread__empty">No messages yet</div>
        ) : groups ? (
          groups.map((group, i) => (
            <ThreadGroupBlock
              key={group.root.name}
              group={group}
              prevRoot={groups[i - 1]?.root ?? null}
              canReply
              onOpenThread={setOpenThreadName}
            />
          ))
        ) : (
          messages.map((msg, i) => (
            <MessageBubble key={msg.name} msg={msg} prevMsg={messages[i - 1] ?? null} />
          ))
        )}
        <div ref={bottomRef} />
      </div>

      <MessageComposer
        spaceId={spaceId}
        members={members}
        placeholder={`Message ${spaceName}… (type @ to mention)`}
        ariaLabel={`Compose message to ${spaceName}`}
        onSendStart={() => {
          // The user's own send should always scroll them to the newest
          // message, even if they had scrolled up to read history.
          nearBottomRef.current = true
        }}
      />
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
  const { allSpaces, visibleSpaces, preferences, isLoading, missingScope } = useSpaces()
  // One-time lift of any surviving browser-local pinned list into the durable
  // server-side preferences. Mounted here (above the isOpen early return) so it
  // runs whether or not the user ever opens the panel.
  useLegacyPinnedSpaceMigration(allSpaces, preferences, isLoading)
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

  // Read the selected space through the LATEST fetch, not the click-time
  // snapshot — a poll can hydrate a bot DM's name or the threading state after
  // selection, and the thread column should follow.
  const currentSpace = selectedSpace
    ? visibleSpaces.find(s => s.name === selectedSpace.name) ?? selectedSpace
    : null

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
      selectedSpace={currentSpace}
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
                  <MessageThread space={selectedSpace} />
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
