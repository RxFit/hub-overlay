import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  __resetPartialResponseNoticeForTests,
  clearPartialResponseNotice,
  getPartialResponseNotice,
  injectPartialResponseIntoAssistant,
  observePartialResponse,
  PARTIAL_RESPONSE_ASSISTANT_PROMPT,
  registerPartialResponseAssistantInjector,
  subscribeToPartialResponseNotice,
} from './partial-response-client'

afterEach(() => {
  __resetPartialResponseNoticeForTests()
})

describe('partial-response client state', () => {
  it('turns x-hub-partial: 1 into persistent visible state', () => {
    const listener = vi.fn()
    const unsubscribe = subscribeToPartialResponseNotice(listener)

    expect(observePartialResponse(new Response(null))).toBe(false)
    expect(getPartialResponseNotice()).toBe(false)

    const partial = new Response(null, { headers: { 'x-hub-partial': '1' } })
    expect(observePartialResponse(partial)).toBe(true)
    expect(getPartialResponseNotice()).toBe(true)
    expect(listener).toHaveBeenCalledTimes(1)

    unsubscribe()
  })

  it('dismisses the notice and announces a later degraded response again', () => {
    const listener = vi.fn()
    subscribeToPartialResponseNotice(listener)
    const partial = new Response(null, { headers: { 'x-hub-partial': '1' } })

    observePartialResponse(partial)
    clearPartialResponseNotice()
    expect(getPartialResponseNotice()).toBe(false)
    observePartialResponse(partial)

    expect(getPartialResponseNotice()).toBe(true)
    expect(listener).toHaveBeenCalledTimes(3)
  })

  it('injects the warning through the registered assistant path', () => {
    const inject = vi.fn()
    const unregister = registerPartialResponseAssistantInjector(inject)

    expect(injectPartialResponseIntoAssistant()).toBe(true)
    expect(inject).toHaveBeenCalledWith(PARTIAL_RESPONSE_ASSISTANT_PROMPT)

    unregister()
    expect(injectPartialResponseIntoAssistant()).toBe(false)
  })
})
