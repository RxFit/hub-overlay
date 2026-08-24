'use client'

import { useCallback, useEffect, useRef, useState } from 'react'

/**
 * useDeepAvailability — the client half of the deep engine's honest
 * availability (DEEP_LANE_2026-08-23.md §6.3, PR D).
 *
 * Polls /api/deep-runs/availability on a slow clock (the server read is a
 * ~5 ms indexed query, but there is no reason to hammer it) and re-checks
 * when the tab regains focus — the common "I just started my desktop
 * worker, is it live now?" moment. Fails toward available:null (unknown),
 * which the chips render as neutral rather than falsely dead.
 */

const POLL_MS = 60_000

export interface DeepAvailability {
  /** true = engine live · false = offline/disabled · null = not yet known */
  available: boolean | null
  reason: 'no_worker' | 'dispatch_disabled' | null
}

export function useDeepAvailability(enabled: boolean): DeepAvailability {
  const [state, setState] = useState<DeepAvailability>({ available: null, reason: null })
  const aliveRef = useRef(true)

  const check = useCallback(async () => {
    try {
      const res = await fetch('/api/deep-runs/availability')
      if (!res.ok) return // auth/transient — keep last known state
      const body = (await res.json()) as { available?: boolean; reason?: DeepAvailability['reason'] }
      if (!aliveRef.current) return
      setState({ available: body.available === true, reason: body.reason ?? null })
    } catch {
      /* network blip — keep last known state */
    }
  }, [])

  useEffect(() => {
    aliveRef.current = true
    if (!enabled) return
    void check()
    const timer = setInterval(() => void check(), POLL_MS)
    const onVisible = () => {
      if (document.visibilityState === 'visible') void check()
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      aliveRef.current = false
      clearInterval(timer)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [enabled, check])

  return state
}
