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
