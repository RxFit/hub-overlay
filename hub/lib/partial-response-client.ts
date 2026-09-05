'use client'

import { useSyncExternalStore } from 'react'

type Listener = () => void

let partialResponseVisible = false
const listeners = new Set<Listener>()

function emit(): void {
  for (const listener of listeners) listener()
}

/**
 * Preserve the server's degraded-read signal at the client boundary.
 *
 * Routes wrapped by withFault emit `x-hub-partial: 1` when an `emptyOn()`
 * fallback kept the request alive while omitting data. Every production
 * fetcher that can receive that header calls this before consuming the body.
 */
export function observePartialResponse(
  response: { headers?: Pick<Headers, 'get'> },
): boolean {
  if (response.headers?.get('x-hub-partial') !== '1') return false
  if (!partialResponseVisible) {
    partialResponseVisible = true
    emit()
  }
  return true
}

export function clearPartialResponseNotice(): void {
  if (!partialResponseVisible) return
  partialResponseVisible = false
  emit()
}

export function getPartialResponseNotice(): boolean {
  return partialResponseVisible
}

export function subscribeToPartialResponseNotice(listener: Listener): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function usePartialResponseNotice(): boolean {
  return useSyncExternalStore(
    subscribeToPartialResponseNotice,
    getPartialResponseNotice,
    () => false,
  )
}

/** Test-only: isolate the process-wide store between cases. */
export function __resetPartialResponseNoticeForTests(): void {
  partialResponseVisible = false
  listeners.clear()
}
