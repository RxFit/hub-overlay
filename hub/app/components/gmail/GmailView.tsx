'use client'

import { EmailPreviewCard } from '@/app/components/EmailPreviewCard'
import { useGmailInbox } from '@/app/hooks/useGmailInbox'

/* ══════════════════════════════════════════
   GMAIL VIEW — presentational; data/logic in useGmailInbox (NS-5)
   ══════════════════════════════════════════ */

export function GmailView({ onUnreadCount }: { onUnreadCount: (n: number) => void }) {
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
  } = useGmailInbox({ onUnreadCount })

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
        <div style={{ padding: '8px 12px', borderBottom: '1px solid var(--border)' }}>
          <button
            onClick={handleComposeNew}
            style={{
              width: '100%',
              padding: '6px 12px',
              background: 'var(--accent)',
              color: '#000',
              border: 'none',
              borderRadius: '6px',
              fontSize: '0.75rem',
              fontWeight: 700,
              cursor: 'pointer'
            }}
          >
            + Compose
          </button>
        </div>
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
            <div style={{ fontSize: '0.85rem', fontWeight: 600, color: 'var(--text-primary)', marginBottom: '8px' }}>
              New Message
            </div>
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
                padding: '8px 12px', color: 'var(--text-primary)', fontSize: '0.8rem', outline: 'none'
              }}
            />
            <input
              value={composeSubject}
              onChange={e => setComposeSubject(e.target.value)}
              placeholder="Subject"
              style={{
                background: 'var(--surface-2)', border: '1px solid var(--border)', borderRadius: '6px',
                padding: '8px 12px', color: 'var(--text-primary)', fontSize: '0.8rem', outline: 'none'
              }}
            />
            <textarea
              value={reply}
              onChange={e => setReply(e.target.value)}
              placeholder="Write your message..."
              style={{
                background: 'var(--surface-2)', border: '1px solid var(--border)', borderRadius: '6px',
                padding: '12px', color: 'var(--text-primary)', fontSize: '0.8rem', outline: 'none',
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
