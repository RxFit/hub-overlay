'use client'

import { useEffect, useRef, useState } from 'react'
import { selectNewUrgentItems } from '@/lib/gmail-focus'
import { useGmailFocus, type FocusDisplayItem } from '@/app/hooks/useGmailFocus'

/**
 * useFocusNotifications — opt-in desktop alerts for URGENT-tier Focus emails.
 *
 * The safe slice of the 4-D routing plan: a notification is the ONLY action a
 * tier triggers — nothing is archived, forwarded, or marked read. Strictly
 * opt-in (the Settings toggle stores NOTIFY_KEY and requests browser
 * permission from a user gesture; this hook never prompts). Each thread is
 * alerted AT MOST ONCE ever (persisted id set), at most 3 per refresh.
 *
 * Mounted at the page level so alerts work while the Gmail overlay is closed;
 * the underlying query polls in background tabs too (that's the whole point
 * of a desktop alert) and shares the ['gmail','focus'] cache with the strip.
 */

export const FOCUS_NOTIFY_KEY = 'hub-focus-notify'
const NOTIFIED_IDS_KEY = 'hub-focus-notified-ids'
const NOTIFIED_IDS_CAP = 200

export function isFocusNotifyEnabled(): boolean {
  try {
    return typeof window !== 'undefined' && localStorage.getItem(FOCUS_NOTIFY_KEY) === '1'
  } catch {
    return false
  }
}

function loadNotifiedIds(): string[] {
  try {
    const raw = localStorage.getItem(NOTIFIED_IDS_KEY)
    const parsed = raw ? JSON.parse(raw) : []
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : []
  } catch {
    return []
  }
}

function saveNotifiedIds(ids: string[]): void {
  try {
    localStorage.setItem(NOTIFIED_IDS_KEY, JSON.stringify(ids.slice(-NOTIFIED_IDS_CAP)))
  } catch {
    // Storage full/blocked — worst case a repeat notification after reload.
  }
}

const extractName = (fromStr: string) => {
  const match = fromStr.match(/^(.+?)\s*</)
  return match ? match[1].trim() : fromStr.split('@')[0]
}

export function useFocusNotifications() {
  // Read once on mount: /settings is a separate route, so returning from the
  // toggle re-mounts this page and picks the new value up.
  const [enabled] = useState(isFocusNotifyEnabled)
  const active =
    enabled &&
    typeof window !== 'undefined' &&
    'Notification' in window &&
    Notification.permission === 'granted'

  const { focusItems } = useGmailFocus(active, { background: true })
  const notifiedRef = useRef<string[] | null>(null)

  useEffect(() => {
    if (!active || focusItems.length === 0) return
    if (notifiedRef.current === null) notifiedRef.current = loadNotifiedIds()

    const fresh = selectNewUrgentItems(
      focusItems,
      new Set(notifiedRef.current),
    ) as FocusDisplayItem[]
    if (fresh.length === 0) return

    for (const item of fresh) {
      try {
        const title = item.from ? `Urgent: ${extractName(item.from)}` : 'Urgent email needs you'
        const body = [item.subject, item.reason].filter(Boolean).join(' — ')
        // tag = thread id → the browser collapses accidental duplicates.
        const n = new Notification(title, { body, tag: `hub-focus-${item.id}`, silent: false })
        n.onclick = () => {
          window.focus()
          n.close()
        }
      } catch {
        // Notification construction can throw (e.g. some mobile browsers
        // require a service worker) — treat as best-effort, still mark
        // notified so we don't retry forever.
      }
    }

    notifiedRef.current = [...notifiedRef.current, ...fresh.map(i => i.id)]
    saveNotifiedIds(notifiedRef.current)
  }, [active, focusItems])
}
