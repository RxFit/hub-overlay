'use client'

import { useState, useEffect, useRef, useCallback } from 'react'
import type { FeedItem } from '@/app/hooks/useHubData'
import type { StallState, StallStatus } from '@/types'

/* ══════════════════════════════════════════════════════════════════════════════
   useStallDetector
   Monitors in_progress feed items for stall conditions.
   
   Thresholds (configurable):
     - AMBER: item hasn't updated in >= amberMinutes (default: 30)
     - RED:   item hasn't updated in >= redMinutes   (default: 60)
   
   Polls on an interval (default: 5 minutes) and on mount.
   ══════════════════════════════════════════════════════════════════════════════ */

const DEFAULT_AMBER_MS = 30 * 60 * 1000   // 30 minutes
const DEFAULT_RED_MS   = 60 * 60 * 1000   // 60 minutes
const POLL_INTERVAL_MS =  5 * 60 * 1000   //  5 minutes

function computeStallStatus(
  timestampIso: string,
  nowMs: number,
  amberMs: number,
  redMs: number
): StallStatus {
  try {
    const itemMs = new Date(timestampIso).getTime()
    const diffMs = nowMs - itemMs
    if (diffMs >= redMs) return 'red'
    if (diffMs >= amberMs) return 'amber'
    return 'normal'
  } catch {
    return 'normal'
  }
}

interface StallDetectorOptions {
  amberMinutes?: number
  redMinutes?: number
  pollIntervalMs?: number
}

interface StallDetectorResult {
  stallMap: Map<string, StallState>
  stalledItems: StallState[]
  redItems: StallState[]
  amberItems: StallState[]
}

export function useStallDetector(
  items: FeedItem[],
  options: StallDetectorOptions = {}
): StallDetectorResult {
  const amberMs = (options.amberMinutes ?? 30) * 60 * 1000
  const redMs   = (options.redMinutes   ?? 60) * 60 * 1000
  const pollMs  = options.pollIntervalMs ?? POLL_INTERVAL_MS

  const [stallMap, setStallMap] = useState<Map<string, StallState>>(new Map())
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const recompute = useCallback(() => {
    const now = Date.now()
    const inProgress = items.filter(i => (i as any).type === 'in_progress')
    
    const nextMap = new Map<string, StallState>()
    for (const item of inProgress) {
      const status = computeStallStatus(item.timestamp, now, amberMs, redMs)
      nextMap.set(item.id, {
        itemId: item.id,
        status,
        stalledSinceMs: status !== 'normal'
          ? now - new Date(item.timestamp).getTime()
          : undefined,
      })
    }
    setStallMap(nextMap)
  }, [items, amberMs, redMs])

  // Run on mount and whenever items change
  useEffect(() => {
    recompute()
  }, [recompute])

  // Poll on interval
  useEffect(() => {
    timerRef.current = setInterval(recompute, pollMs)
    return () => {
      if (timerRef.current) clearInterval(timerRef.current)
    }
  }, [recompute, pollMs])

  const stalledItems = Array.from(stallMap.values()).filter(s => s.status !== 'normal')
  const redItems     = stalledItems.filter(s => s.status === 'red')
  const amberItems   = stalledItems.filter(s => s.status === 'amber')

  return { stallMap, stalledItems, redItems, amberItems }
}
