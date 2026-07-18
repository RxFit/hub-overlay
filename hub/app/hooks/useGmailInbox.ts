'use client'

import { useState, useRef, useEffect } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { signIn } from 'next-auth/react'
import { extractEmail, replySubject } from '@/lib/email-address'

/**
 * useGmailInbox — the Gmail inbox data/logic extracted from GoogleChatPanel's
 * GmailView (NS-5), now backed by TanStack Query (NS-6).
 *
 * The inbox thread-list read runs on `useQuery` with `refetchInterval: 60_000`
 * and `refetchOnWindowFocus: true` — this REPLACES the hand-rolled `setInterval`
 * + `visibilitychange` polling from #28. react-query pauses the interval while
 * the tab is hidden by default and re-fetches on focus, so the #28 behavior
 * (don't hammer a backgrounded tab; refresh on return) is preserved by the
 * library instead of by bespoke plumbing.
 *
 * CRUCIALLY (the #28 guarantee): `selectedThread`, `isComposing`, and the
 * compose/reply draft fields remain LOCAL component state — they are NOT in the
 * query cache. A background list refetch therefore cannot disturb an open thread
 * or an in-progress compose draft. The unread count is emitted via an effect on
 * the query `data` (react-query v5 removed `onSuccess` on useQuery).
 *
 * INPUT: `onUnreadCount` — emitted with the inbox unread count whenever the
 * query resolves fresh data (mount, focus, 60s poll, and post-send refetch).
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
  const queryClient = useQueryClient()
  // Thread list mirrors the query cache but stays LOCAL so `openThread` can
  // optimistically mark a thread read; a background refetch resyncs it from the
  // server (same as the pre-NS-6 poll overwrote the list wholesale).
  const [threads, setThreads] = useState<GmailThread[]>([])
  const [selectedThread, setSelectedThread] = useState<SelectedThread | null>(null)
  const [threadLoading, setThreadLoading] = useState(false)
  // Distinct thread-open error so a failed open surfaces feedback + retry
  // instead of silently falling back to the blank "Select a thread" stub.
  const [threadError, setThreadError] = useState<string | null>(null)
  const lastThreadIdRef = useRef<string | null>(null)
  const [reply, setReply] = useState('')
  const [sending, setSending] = useState(false)
  const [sendError, setSendError] = useState<string | null>(null)
  const [mobileView, setMobileView] = useState<MobileGmailView>('list')
  const [isComposing, setIsComposing] = useState(false)
  const [composeTo, setComposeTo] = useState('')
  const [composeSubject, setComposeSubject] = useState('')
  const bottomRef = useRef<HTMLDivElement>(null)

  // Inbox thread-list read on TanStack Query. `refetchInterval` (paused while
  // the tab is hidden) + `refetchOnWindowFocus` replace the manual #28 poll.
  // The queryFn only reads the list + unread count — it never touches
  // selectedThread/compose/reply, so a background refetch cannot disturb an open
  // thread or an in-progress draft (the #28 guarantee).
  const { data, isLoading: loading, error, isError, refetch } = useQuery({
    queryKey: ['gmail', 'inbox'],
    queryFn: async () => {
      const r = await fetch('/api/google/gmail?view=inbox&maxResults=20')
      // Route 401 through reauth like the sibling Google hooks
      // (useKPIData / useWriteFetch) so an expired token re-authenticates
      // instead of parsing an error body into an empty inbox + a 0 badge.
      if (r.status === 401) {
        const body = await r.json().catch(() => ({}))
        if (body?.reauth !== false) signIn('google')
        const err = new Error(body?.error || 'Session expired — please sign in again')
        ;(err as any).status = 401
        throw err
      }
      // A non-ok response is a FAILURE, not an empty inbox — throw a
      // status-tagged error so `isError` is set and the unread badge is not
      // zeroed (the derive-from-`data` effect only runs on success).
      if (!r.ok) {
        const body = await r.json().catch(() => ({}))
        const err = new Error(body?.error || `Failed to load inbox (${r.status})`)
        ;(err as any).status = r.status
        throw err
      }
      return parseInboxResponse(await r.json())
    },
    refetchInterval: 60_000,
    refetchOnWindowFocus: true,
  })

  // Emit the fresh list + unread count into local state whenever the query
  // resolves (mount, 60s poll, focus, post-send refetch). react-query v5 has no
  // useQuery `onSuccess`, so we derive from `data` in an effect.
  useEffect(() => {
    if (!data) return
    setThreads(data.threads)
    onUnreadCount(data.unreadCount)
  }, [data, onUnreadCount])

  // Single refresh path for callers (post-send). Delegates to the query so the
  // 60s poll and manual refresh share one cache entry.
  const refreshInbox = () => refetch()

  const openThread = async (id: string) => {
    lastThreadIdRef.current = id
    setIsComposing(false)
    setThreadError(null)
    setThreadLoading(true)
    setMobileView('thread')
    try {
      const r = await fetch(`/api/google/gmail?threadId=${id}`)
      if (r.status === 401) {
        const body = await r.json().catch(() => ({}))
        if (body?.reauth !== false) signIn('google')
        throw new Error(body?.error || 'Session expired — please sign in again')
      }
      if (!r.ok) throw new Error('Unable to open this conversation')
      const d = await r.json()
      setSelectedThread(d.thread ?? null)
      // Mark as read locally
      setThreads(prev => prev.map(t => t.id === id ? { ...t, isUnread: false } : t))
      setTimeout(() => bottomRef.current?.scrollIntoView({ behavior: 'smooth' }), 100)
    } catch (err) {
      // Surface a thread-level error (with retry) instead of a blank pane.
      setThreadError(err instanceof Error ? err.message : 'Unable to open this conversation')
    }
    setThreadLoading(false)
  }

  // Retry the last attempted thread-open (used by the thread-error block).
  const retryOpenThread = () => {
    if (lastThreadIdRef.current) openThread(lastThreadIdRef.current)
  }

  /* ── Thread actions (action menu): trash + save-to-Google-Task ──
   * Trash is optimistic: the thread leaves the list (and closes if open)
   * immediately, and is restored on failure. Both surface a transient notice
   * so the sheet can close instantly without losing feedback. */
  const [actionBusy, setActionBusy] = useState(false)
  const [actionNotice, setActionNotice] = useState<string | null>(null)
  const noticeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => () => { if (noticeTimerRef.current) clearTimeout(noticeTimerRef.current) }, [])

  const flashNotice = (text: string) => {
    setActionNotice(text)
    if (noticeTimerRef.current) clearTimeout(noticeTimerRef.current)
    noticeTimerRef.current = setTimeout(() => setActionNotice(null), 3500)
  }

  const trashThread = async (id: string) => {
    setActionBusy(true)
    // Optimistic removal at the QUERY-CACHE level (standard TanStack pattern):
    // cancel any in-flight poll first, then filter the cached list — otherwise
    // a refetch that was already running resolves after our local removal and
    // the `data` effect resurrects the deleted thread.
    await queryClient.cancelQueries({ queryKey: ['gmail', 'inbox'] })
    queryClient.setQueryData<{ threads: GmailThread[]; unreadCount: number }>(
      ['gmail', 'inbox'],
      old => (old ? { ...old, threads: old.threads.filter(t => t.id !== id) } : old)
    )
    setThreads(prev => prev.filter(t => t.id !== id))
    if (selectedThread?.id === id) {
      setSelectedThread(null)
      setMobileView('list')
    }
    try {
      const r = await fetch('/api/google/gmail/actions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'trash', threadId: id }),
      })
      if (!r.ok) {
        const body = await r.json().catch(() => ({}))
        throw new Error(body?.error || 'Failed to delete')
      }
      flashNotice('Moved to Trash')
      refetch()
    } catch (err) {
      // Resync from the server rather than restoring a possibly-stale local
      // snapshot (a poll may have delivered fresh data mid-request).
      queryClient.invalidateQueries({ queryKey: ['gmail', 'inbox'] })
      flashNotice(err instanceof Error ? `⚠️ ${err.message}` : '⚠️ Failed to delete')
    }
    setActionBusy(false)
  }

  const saveThreadAsTask = async (t: Pick<GmailThread, 'id' | 'subject' | 'from' | 'snippet'>) => {
    setActionBusy(true)
    try {
      const r = await fetch('/api/google/gmail/actions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'save_task',
          threadId: t.id,
          subject: t.subject,
          from: t.from,
          snippet: t.snippet,
        }),
      })
      if (!r.ok) {
        const body = await r.json().catch(() => ({}))
        throw new Error(body?.error || 'Failed to save task')
      }
      flashNotice('Saved to Google Tasks')
    } catch (err) {
      flashNotice(err instanceof Error ? `⚠️ ${err.message}` : '⚠️ Failed to save task')
    }
    setActionBusy(false)
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
    // Inbox-list fetch failure (distinct from an empty inbox).
    error: (error as Error | undefined) ?? undefined,
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
    // ── Setters the view wires into events ──
    setReply,
    setMobileView,
    setIsComposing,
    setComposeTo,
    setComposeSubject,
    // ── Thread actions (action menu) ──
    actionBusy,
    actionNotice,
    trashThread,
    saveThreadAsTask,
    // ── Handlers / effects ──
    refreshInbox,
    openThread,
    handleComposeNew,
    handleSendCompose,
    handleSend,
  }
}
