'use client'

import { useEffect, useRef, useState } from 'react'
import { EmailPreviewCard } from '@/app/components/EmailPreviewCard'
import { FocusStrip } from '@/app/components/gmail/FocusStrip'
import { EmailActionSheet } from '@/app/components/gmail/EmailActionSheet'
import { useGmailInbox, type GmailThread } from '@/app/hooks/useGmailInbox'
import { useGmailFocus } from '@/app/hooks/useGmailFocus'
import { buildDiscussPrompt } from '@/lib/gmail-actions'

/* ══════════════════════════════════════════
   GMAIL VIEW — presentational; data/logic in useGmailInbox (NS-5)
   ══════════════════════════════════════════ */

const LONG_PRESS_MS = 450
const LONG_PRESS_MOVE_TOLERANCE_PX = 12

export function GmailView({
  onUnreadCount,
  onDiscussEmail,
}: {
  onUnreadCount: (n: number) => void
  /** Injects a message into the AI assistant chat (wired from page.tsx). */
  onDiscussEmail?: (text: string) => void
}) {
  const {
    threads,
    selectedThread,
    loading,
    isError,
    refetch,
    threadLoading,
    threadError,
    retryOpenThread,
    reply,
    sending,
    sendError,
    mobileView,
    isComposing,
    composeTo,
    composeSubject,
    bottomRef,
    setReply,
    setMobileView,
    setIsComposing,
    setComposeTo,
    setComposeSubject,
    openThread,
    handleComposeNew,
    handleSendCompose,
    handleSend,
    actionBusy,
    actionNotice,
    trashThread,
    saveThreadAsTask,
    loadMore,
    hasMore,
    loadingMore,
  } = useGmailInbox({ onUnreadCount })

  /* ── Action menu (long-press a list row, right-click, or ⋯ in the reader) ── */
  const [actionThread, setActionThread] = useState<GmailThread | null>(null)
  const pressTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pressOriginRef = useRef<{ x: number; y: number } | null>(null)
  const suppressClickRef = useRef(false)
  useEffect(() => () => { if (pressTimerRef.current) clearTimeout(pressTimerRef.current) }, [])

  const cancelPress = () => {
    if (pressTimerRef.current) clearTimeout(pressTimerRef.current)
    pressTimerRef.current = null
    pressOriginRef.current = null
  }

  const startPress = (t: GmailThread, e: React.PointerEvent) => {
    cancelPress()
    suppressClickRef.current = false
    pressOriginRef.current = { x: e.clientX, y: e.clientY }
    pressTimerRef.current = setTimeout(() => {
      // Long-press reached: open the menu and swallow the trailing click.
      suppressClickRef.current = true
      try { navigator?.vibrate?.(10) } catch { /* silent */ }
      setActionThread(t)
    }, LONG_PRESS_MS)
  }

  const movePress = (e: React.PointerEvent) => {
    const origin = pressOriginRef.current
    if (!origin) return
    // A scroll gesture is not a long-press.
    if (
      Math.abs(e.clientX - origin.x) > LONG_PRESS_MOVE_TOLERANCE_PX ||
      Math.abs(e.clientY - origin.y) > LONG_PRESS_MOVE_TOLERANCE_PX
    ) {
      cancelPress()
    }
  }

  const handleRowClick = (id: string) => {
    if (suppressClickRef.current) {
      suppressClickRef.current = false
      return
    }
    openThread(id)
  }

  const handleDiscuss = (t: GmailThread) => {
    setActionThread(null)
    onDiscussEmail?.(buildDiscussPrompt({ subject: t.subject, from: t.from, snippet: t.snippet }))
  }

  const { focusItems } = useGmailFocus()

  // Conversation context (Gmail-style): older messages in the thread render
  // COLLAPSED (sender + date + one-line preview) so the newest message leads,
  // and any earlier message — e.g. your own email this one replies to — is one
  // tap away. The newest message starts expanded.
  const [expandedMsgIds, setExpandedMsgIds] = useState<Set<string>>(new Set())
  const lastMsgId = selectedThread?.messages[selectedThread.messages.length - 1]?.id
  useEffect(() => {
    setExpandedMsgIds(lastMsgId ? new Set([lastMsgId]) : new Set())
  }, [selectedThread?.id, lastMsgId])

  const toggleMsg = (id: string) =>
    setExpandedMsgIds(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  // One-line plain-text preview of a message body for collapsed rows.
  const previewText = (html: string) =>
    html
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&[a-z#0-9]+;/gi, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 110)

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

  const threadSubject = selectedThread?.messages[0]?.subject

  return (
    <div style={{ display: 'flex', height: '100%', width: '100%', overflow: 'hidden' }}>
      {/* Thread list — full-width single pane on mobile (hidden while a thread
          is open), fixed-width column beside the thread on desktop. Visibility
          is class-driven (same pattern as GoogleChatPanel) so the mobile
          media query isn't fought by inline styles. */}
      <div className={`chat-panel-spaces gmail-list${mobileView === 'thread' ? ' chat-panel-spaces--mobile-hidden' : ''}`}>
        <div style={{ padding: '10px 14px', borderBottom: '1px solid var(--border)' }}>
          <button
            onClick={handleComposeNew}
            style={{
              width: '100%',
              padding: '10px 12px',
              background: 'var(--accent)',
              color: '#000',
              border: 'none',
              borderRadius: '8px',
              fontSize: '0.85rem',
              fontWeight: 700,
              cursor: 'pointer'
            }}
          >
            + Compose
          </button>
        </div>
        {!loading && (
          <FocusStrip items={focusItems} threads={threads} onOpen={openThread} />
        )}
        {loading ? (
          [1,2,3,4,5].map(i => (
            <div key={i} style={{ padding: '12px', borderBottom: '1px solid var(--border)', opacity: 0.4 }}>
              <div style={{ height: '10px', background: 'var(--surface-2)', borderRadius: '4px', marginBottom: '6px', width: '70%' }} />
              <div style={{ height: '8px', background: 'var(--surface-2)', borderRadius: '4px', width: '90%' }} />
            </div>
          ))
        ) : isError && threads.length === 0 ? (
          // A fetch FAILURE — distinct from an empty inbox. Show a recoverable
          // error with Retry instead of the misleading "No messages" copy. When
          // a background refetch fails but we already have threads, we keep the
          // stale list rather than replacing it with this block.
          <div role="alert" style={{ padding: '20px', textAlign: 'center', color: 'var(--text-muted)', fontSize: '0.8rem' }}>
            <div style={{ fontSize: '1.3rem', marginBottom: '6px' }} aria-hidden="true">⚠️</div>
            <div style={{ marginBottom: '10px' }}>Couldn’t load your inbox.</div>
            <button
              onClick={() => refetch()}
              style={{ padding: '5px 14px', background: 'var(--surface-2)', border: '1px solid var(--border)', borderRadius: '6px', color: 'var(--text-primary)', fontSize: '0.72rem', fontWeight: 600, cursor: 'pointer' }}
            >
              Retry
            </button>
          </div>
        ) : threads.length === 0 ? (
          <div style={{ padding: '20px', textAlign: 'center', color: 'var(--text-muted)', fontSize: '0.8rem' }}>
            No messages
          </div>
        ) : (
          threads.map(t => (
            <button
              key={t.id}
              onClick={() => handleRowClick(t.id)}
              onPointerDown={e => startPress(t, e)}
              onPointerMove={movePress}
              onPointerUp={cancelPress}
              onPointerCancel={cancelPress}
              onPointerLeave={cancelPress}
              onContextMenu={e => { e.preventDefault(); setActionThread(t) }}
              className={`gmail-list-item${t.isUnread ? ' gmail-list-item--unread' : ''}${selectedThread?.id === t.id ? ' gmail-list-item--selected' : ''}`}
            >
              <div className="gmail-list-item__top">
                <span className="gmail-list-item__from">{extractName(t.from)}</span>
                <span className="gmail-list-item__date">{formatDate(t.date)}</span>
              </div>
              <div className="gmail-list-item__subject">{t.subject}</div>
              <div className="gmail-list-item__snippet">{t.snippet}</div>
            </button>
          ))
        )}
        {!loading && !isError && threads.length > 0 && hasMore && (
          <button
            className="gmail-load-more"
            onClick={() => loadMore()}
            disabled={loadingMore}
          >
            {loadingMore ? 'Loading…' : 'Load older emails'}
          </button>
        )}
      </div>

      {/* Thread detail — hidden on mobile while the list is showing; always
          visible beside the list on desktop. */}
      <div className={`chat-panel-thread${mobileView === 'list' ? ' chat-panel-thread--mobile-hidden' : ''}`}>
        {/* Thread header: mobile back + subject */}
        {(selectedThread || isComposing || threadLoading || threadError) && (
          <div className="gmail-thread-header">
            <button
              className="chat-panel-back"
              onClick={() => setMobileView('list')}
              aria-label="Back to inbox"
            >
              ‹
            </button>
            <span className="gmail-thread-header__subject">
              {isComposing ? 'New Message' : threadSubject ?? ''}
            </span>
            {selectedThread && !isComposing && (
              <button
                className="gmail-thread-header__more"
                aria-label="Email actions"
                onClick={() => {
                  const listThread = threads.find(t => t.id === selectedThread.id)
                  const first = selectedThread.messages[0]
                  setActionThread(
                    listThread ?? {
                      id: selectedThread.id,
                      subject: threadSubject ?? '(no subject)',
                      from: first?.from ?? '',
                      date: first?.date ?? '',
                      snippet: '',
                      isUnread: false,
                      messageCount: selectedThread.messages.length,
                    }
                  )
                }}
              >
                ⋯
              </button>
            )}
          </div>
        )}

        {threadLoading ? (
          <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-muted)', fontSize: '0.8rem' }}>
            Loading…
          </div>
        ) : threadError && !selectedThread ? (
          // A failed thread-open surfaces feedback + Retry instead of a blank pane.
          <div role="alert" style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: '10px', color: 'var(--text-muted)', fontSize: '0.8rem', padding: '20px', textAlign: 'center' }}>
            <span aria-hidden="true" style={{ fontSize: '1.3rem' }}>⚠️</span>
            <span>{threadError}</span>
            <button
              onClick={retryOpenThread}
              style={{ padding: '5px 14px', background: 'var(--surface-2)', border: '1px solid var(--border)', borderRadius: '6px', color: 'var(--text-primary)', fontSize: '0.72rem', fontWeight: 600, cursor: 'pointer' }}
            >
              Retry
            </button>
          </div>
        ) : isComposing ? (
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', padding: '12px', gap: '12px' }}>
            {sendError && (
              <div style={{ padding: '6px 12px', color: 'var(--danger)', fontSize: '0.72rem', background: 'rgba(255,50,50,0.1)', borderRadius: '6px' }}>
                ⚠️ {sendError}
              </div>
            )}
            <input
              value={composeTo}
              onChange={e => setComposeTo(e.target.value)}
              placeholder="To: email@address.com"
              style={{
                background: 'var(--surface-2)', border: '1px solid var(--border)', borderRadius: '6px',
                padding: '8px 12px', color: 'var(--text-primary)', fontSize: '1rem', outline: 'none'
              }}
            />
            <input
              value={composeSubject}
              onChange={e => setComposeSubject(e.target.value)}
              placeholder="Subject"
              style={{
                background: 'var(--surface-2)', border: '1px solid var(--border)', borderRadius: '6px',
                padding: '8px 12px', color: 'var(--text-primary)', fontSize: '1rem', outline: 'none'
              }}
            />
            <textarea
              value={reply}
              onChange={e => setReply(e.target.value)}
              placeholder="Write your message..."
              style={{
                background: 'var(--surface-2)', border: '1px solid var(--border)', borderRadius: '6px',
                padding: '12px', color: 'var(--text-primary)', fontSize: '1rem', outline: 'none',
                flex: 1, resize: 'none'
              }}
            />
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px' }}>
              <button
                onClick={() => { setIsComposing(false); setMobileView('list') }}
                style={{ background: 'transparent', border: '1px solid var(--border)', color: 'var(--text-secondary)', padding: '6px 16px', borderRadius: '6px', cursor: 'pointer', fontSize: '0.75rem' }}
              >
                Cancel
              </button>
              <button
                onClick={handleSendCompose}
                disabled={sending || !composeTo || !reply}
                style={{ background: 'var(--accent)', border: 'none', color: '#000', padding: '6px 16px', borderRadius: '6px', cursor: 'pointer', fontSize: '0.75rem', fontWeight: 600, opacity: (sending || !composeTo || !reply) ? 0.5 : 1 }}
              >
                {sending ? 'Sending...' : 'Send Message'}
              </button>
            </div>
          </div>
        ) : selectedThread ? (
          <>
            {/* Messages — the EmailPreviewCard is the card; a slim meta row
                above it replaces the old double-bordered wrapper so the email
                body gets the full pane width. Older messages collapse to a
                tappable context row (Gmail-style). */}
            <div style={{ flex: 1, overflowY: 'auto', padding: '8px', display: 'flex', flexDirection: 'column', gap: '12px' }}>
              {selectedThread.messages.map(msg =>
                expandedMsgIds.has(msg.id) ? (
                  <div key={msg.id}>
                    <button
                      className="gmail-msg-meta"
                      onClick={() => selectedThread.messages.length > 1 && toggleMsg(msg.id)}
                      aria-expanded="true"
                      aria-label={`Collapse message from ${extractName(msg.from)}`}
                    >
                      <span className="gmail-msg-meta__from">{extractName(msg.from)}</span>
                      <span className="gmail-msg-meta__date">{formatDate(msg.date)}</span>
                    </button>
                    {msg.body && (
                      <EmailPreviewCard htmlContent={msg.body} />
                    )}
                  </div>
                ) : (
                  <button
                    key={msg.id}
                    className="gmail-msg-collapsed"
                    onClick={() => toggleMsg(msg.id)}
                    aria-expanded="false"
                    aria-label={`Expand earlier message from ${extractName(msg.from)}`}
                  >
                    <div className="gmail-msg-collapsed__top">
                      <span className="gmail-msg-collapsed__from">{extractName(msg.from)}</span>
                      <span className="gmail-msg-collapsed__date">{formatDate(msg.date)}</span>
                    </div>
                    <div className="gmail-msg-collapsed__preview">{previewText(msg.body || '')}</div>
                  </button>
                )
              )}
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
                style={{ fontSize: '1rem' }}
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

      {/* Action menu + transient action feedback */}
      {actionThread && (
        <EmailActionSheet
          thread={actionThread}
          busy={actionBusy}
          onDelete={() => { const id = actionThread.id; setActionThread(null); trashThread(id) }}
          onSaveTask={() => { const t = actionThread; setActionThread(null); saveThreadAsTask(t) }}
          onDiscuss={onDiscussEmail ? () => handleDiscuss(actionThread) : undefined}
          onClose={() => setActionThread(null)}
        />
      )}
      {actionNotice && (
        <div className="gmail-toast" role="status">{actionNotice}</div>
      )}
    </div>
  )
}
