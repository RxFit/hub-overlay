'use client'

import { useSyncExternalStore } from 'react'

type Listener = () => void
type AssistantInjector = (message: string) => void

let partialResponseVisible = false
const listeners = new Set<Listener>()
let assistantInjector: AssistantInjector | null = null
const assistantAvailabilityListeners = new Set<Listener>()

export const PARTIAL_RESPONSE_ASSISTANT_PROMPT =
  'The Hub is showing a partial-data warning because at least one request returned incomplete data. Explain what that means for the values currently displayed and help me verify the affected data before I act on it.'

function emit(): void {
  for (const listener of listeners) {
    try {
      listener()
    } catch {
      // A subscriber that throws (a component mid-unmount, a bad test spy)
      // must not turn the fetch that armed the notice into a failed query:
      // markPartialResponseNotice() runs INSIDE queryFns, and TanStack would
      // treat the throw as the read failing — the opposite of the point.
    }
  }
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
  markPartialResponseNotice()
  return true
}

/**
 * Arm the notice from the CLIENT side, for degradations the server never saw.
 *
 * A 2xx whose body is truncated or not JSON carries no `x-hub-partial`
 * header — the server believed it answered in full — and a client-side
 * `emptyOn()` fallback cannot reach this store either: lib/swallow.ts is
 * isomorphic and its partial marker is injected only on the server (by
 * lib/partial-context.ts), so in the browser emptyOn counts and returns the
 * fallback and nothing else. A fetcher that swallows a parse failure into an
 * empty result therefore calls this explicitly, or the user sees "nothing
 * here" for what was a broken response.
 */
export function markPartialResponseNotice(): void {
  if (partialResponseVisible) return
  partialResponseVisible = true
  emit()
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

export function registerPartialResponseAssistantInjector(
  injector: AssistantInjector,
): () => void {
  assistantInjector = injector
  for (const listener of assistantAvailabilityListeners) listener()

  return () => {
    if (assistantInjector !== injector) return
    assistantInjector = null
    for (const listener of assistantAvailabilityListeners) listener()
  }
}

export function injectPartialResponseIntoAssistant(): boolean {
  if (!assistantInjector) return false
  assistantInjector(PARTIAL_RESPONSE_ASSISTANT_PROMPT)
  return true
}

export function usePartialResponseAssistantAvailable(): boolean {
  return useSyncExternalStore(
    (listener) => {
      assistantAvailabilityListeners.add(listener)
      return () => assistantAvailabilityListeners.delete(listener)
    },
    () => assistantInjector !== null,
    () => false,
  )
}

/** Test-only: isolate the process-wide store between cases. */
export function __resetPartialResponseNoticeForTests(): void {
  partialResponseVisible = false
  listeners.clear()
  assistantInjector = null
  assistantAvailabilityListeners.clear()
}
