'use client'

import { useState, useRef, useEffect, useCallback } from 'react'
import { extractEmail, replySubject } from '@/lib/email-address'

/**
 * useGmailInbox — the Gmail inbox data/logic extracted from GoogleChatPanel's
 * GmailView (NS-5). This is a behavior-preserving MOVE: the handler bodies below
 * are byte-equivalent to the ones that used to live inline in GmailView —
 * including the single `refreshInbox` path, the 60s poll + visibilitychange
 * pause (#28), the `replySubject` reply subject (#25), and the optimistic reply
 * append. Only the seam changed: state + handlers live here and are returned for
 * the presentational GmailView to render, so a background poll can refresh the
 * list while a thread is open or the user is composing without disturbing them.
 *
 * INPUT: `onUnreadCount` — emitted with the inbox unread count on every refresh
 * (mount, post-send, and poll all flow through the single `refreshInbox`).
 */

export interface GmailThread {
  id: string
  subject: string
  from: string
  date: string
  snippet: string
  isUnread: boolean
  messageCount: number
}

export interface GmailMessage {
  id: string
  from: string
  to: string
  subject: string
  date: string
  body: string
  isUnread: boolean
  inReplyTo: string
}

export interface SelectedThread {
  id: string
  messages: GmailMessage[]
}

/**
 * Pure mapping of the `/api/google/gmail?view=inbox` response onto the two
 * pieces of state `refreshInbox` touches — the thread list and the unread
 * count — applying the same `?? []` / `?? 0` defaults the inline code used.
 * Isolated so the refresh derivation is unit-testable (it never reads or resets
 * selectedThread / compose / reply — the #28 guarantee).
 */
export function parseInboxResponse(
  d: { threads?: GmailThread[] | null; unreadCount?: number | null } | null | undefined,
): { threads: GmailThread[]; unreadCount: number } {
  return {
    threads: d?.threads ?? [],
    unreadCount: d?.unreadCount ?? 0,
  }
}

export type MobileGmailView = 'list' | 'thread'

export interface UseGmailInboxOptions {
  onUnreadCount: (n: number) => void
}

export function useGmailInbox({ onUnreadCount }: UseGmailInboxOptions) {
  const [threads, setThreads] = useState<GmailThread[]>([])
  const [selectedThread, setSelectedThread] = useState<SelectedThread | null>(null)
  const [loading, setLoading] = useState(true)
  const [threadLoading, setThreadLoading] = useState(false)
  const [reply, setReply] = useState('')
  const [sending, setSending] = useState(false)
  const [sendError, setSendError] = useState<string | null>(null)
  const [mobileView, setMobileView] = useState<MobileGmailView>('list')
  const [isComposing, setIsComposing] = useState(false)
  const [composeTo, setComposeTo] = useState('')
  const [composeSubject, setComposeSubject] = useState('')
  const bottomRef = useRef<HTMLDivElement>(null)

  // Single refresh path for the inbox thread list. Only touches the list +
  // unread count — never selectedThread/compose/reply — so a background poll
  // can safely run while a thread is open or the user is composing.
  const refreshInbox = useCallback(() => {
    return fetch('/api/google/gmail?view=inbox&maxResults=20')
      .then(r => r.json())
      .then(d => {
        const { threads: nextThreads, unreadCount } = parseInboxResponse(d)
        setThreads(nextThreads)
        onUnreadCount(unreadCount)
      })
      .catch(() => {})
  }, [onUnreadCount])

  // Initial load on mount.
  useEffect(() => {
    refreshInbox().finally(() => setLoading(false))
  }, [refreshInbox])

  // Lightweight SWR-style polling: refresh every 60s while the tab is visible.
  // Pause while hidden (don't hammer the Gmail API for a backgrounded tab) and
  // refresh immediately when the tab becomes visible again.
  useEffect(() => {
    const interval = setInterval(() => {
      if (document.visibilityState === 'visible') refreshInbox()
    }, 60_000)

    const onVisibility = () => {
      if (document.visibilityState === 'visible') refreshInbox()
    }
    document.addEventListener('visibilitychange', onVisibility)

    return () => {
      clearInterval(interval)
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [refreshInbox])

  const openThread = async (id: string) => {
    setIsComposing(false)
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

  const handleComposeNew = () => {
    setSelectedThread(null)
    setIsComposing(true)
    setComposeTo('')
    setComposeSubject('')
    setReply('')
    setMobileView('thread')
  }

  const handleSendCompose = async () => {
    if (!composeTo.trim() || !reply.trim()) return
    setSending(true)
    setSendError(null)
    try {
      const res = await fetch('/api/google/gmail', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          to: composeTo,
          subject: composeSubject,
          message: reply,
        }),
      })
      const d = await res.json()
      if (!res.ok) throw new Error(d.error)

      // Reset compose state
      setIsComposing(false)
      setComposeTo('')
      setComposeSubject('')
      setReply('')
      setMobileView('list')
      // Optimistically reload threads to see the new message
      refreshInbox()
    } catch (err) {
      setSendError(err instanceof Error ? err.message : 'Failed to send')
    }
    setSending(false)
  }

  const handleSend = async () => {
    if (!reply.trim() || !selectedThread) return
    const last = selectedThread.messages[selectedThread.messages.length - 1]
    // Reply to the other party, not blindly the last message — our own
    // optimistic replies are appended with from: 'me', so skip those and
    // fall back to the thread's first sender.
    const target = [...selectedThread.messages].reverse().find(m => m.from !== 'me')
      ?? selectedThread.messages[0]
    const targetEmail = extractEmail(target.from)
    // Send an explicit "Re: <original subject>" so the route doesn't fall back
    // to stamping the Message-ID as the subject (which breaks threading).
    const subject = replySubject(last.subject)
    setSending(true)
    setSendError(null)
    try {
      const res = await fetch('/api/google/gmail', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          to: targetEmail,
          subject,
          threadId: selectedThread.id,
          inReplyTo: target.inReplyTo,
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
          to: targetEmail,
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

  return {
    // ── State (read in JSX) ──
    threads,
    selectedThread,
    loading,
    threadLoading,
    reply,
    sending,
    sendError,
    mobileView,
    isComposing,
    composeTo,
    composeSubject,
    bottomRef,
    // ── Setters the view wires into events ──
    setReply,
    setMobileView,
    setIsComposing,
    setComposeTo,
    setComposeSubject,
    // ── Handlers / effects ──
    refreshInbox,
    openThread,
    handleComposeNew,
    handleSendCompose,
    handleSend,
  }
}
