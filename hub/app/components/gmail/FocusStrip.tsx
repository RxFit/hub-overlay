'use client'

import type { FocusItem, FocusAction } from '@/lib/gmail-focus'
import type { GmailThread } from '@/app/hooks/useGmailInbox'

/**
 * FocusStrip — the AI-ranked "handle these first" row above the inbox list.
 *
 * Each card = one thread the ranking model flagged, with its one-line reason
 * and suggested action; tapping opens the thread. Cards are display-joined
 * with the live thread list (sender/subject come from Gmail data the user
 * already sees, never from the model), so a focus item whose thread has left
 * the list is simply not rendered.
 */

const ACTION_LABEL: Record<FocusAction, string> = {
  reply: 'Reply',
  read: 'Read',
  archive: 'Archive',
  schedule: 'Schedule',
}

interface FocusStripProps {
  items: FocusItem[]
  threads: GmailThread[]
  onOpen: (threadId: string) => void
}

export function FocusStrip({ items, threads, onOpen }: FocusStripProps) {
  const byId = new Map(threads.map(t => [t.id, t]))
  const cards = items
    .map(item => ({ item, thread: byId.get(item.id) }))
    .filter((c): c is { item: FocusItem; thread: GmailThread } => Boolean(c.thread))

  if (cards.length === 0) return null

  const extractName = (fromStr: string) => {
    const match = fromStr.match(/^(.+?)\s*</)
    return match ? match[1].trim() : fromStr.split('@')[0]
  }

  return (
    <section className="gmail-focus" aria-label="Focus — threads that need your attention">
      <div className="gmail-focus__title">
        <span className="gmail-focus__spark" aria-hidden="true">✦</span>
        Focus
        <span className="gmail-focus__hint">AI-suggested priorities</span>
      </div>
      <div className="gmail-focus__rail">
        {cards.map(({ item, thread }) => (
          <button
            key={item.id}
            className="gmail-focus-card"
            onClick={() => onOpen(item.id)}
          >
            <div className="gmail-focus-card__top">
              <span className="gmail-focus-card__from">{extractName(thread.from)}</span>
              <span className={`gmail-focus-card__action gmail-focus-card__action--${item.action}`}>
                {ACTION_LABEL[item.action]}
              </span>
            </div>
            <div className="gmail-focus-card__subject">{thread.subject}</div>
            {item.reason && <div className="gmail-focus-card__reason">{item.reason}</div>}
          </button>
        ))}
      </div>
    </section>
  )
}
