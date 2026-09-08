// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { PartialResponseBanner } from './PartialResponseBanner'
import {
  __resetPartialResponseNoticeForTests,
  observePartialResponse,
  PARTIAL_RESPONSE_ASSISTANT_PROMPT,
  registerPartialResponseAssistantInjector,
} from '@/lib/partial-response-client'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root | null = null
let container: HTMLDivElement | null = null

afterEach(() => {
  act(() => { root?.unmount() })
  container?.remove()
  root = null
  container = null
  __resetPartialResponseNoticeForTests()
})

describe('PartialResponseBanner', () => {
  it('persists a degraded-read warning until the user dismisses it', () => {
    const inject = vi.fn()
    registerPartialResponseAssistantInjector(inject)
    container = document.createElement('div')
    document.body.appendChild(container)
    act(() => {
      root = createRoot(container!)
      root.render(createElement(PartialResponseBanner))
    })
    expect(container.querySelector('[role="status"]')).toBeNull()

    act(() => {
      observePartialResponse(new Response(null, { headers: { 'x-hub-partial': '1' } }))
    })

    const banner = container.querySelector('[role="status"]')
    expect(banner?.textContent).toContain('Some data could not be loaded')
    expect(banner?.textContent).toContain('Values shown may be incomplete')

    act(() => {
      const askButton = Array.from(container!.querySelectorAll('button'))
        .find(button => button.textContent === 'Ask assistant')
      askButton?.click()
    })
    expect(inject).toHaveBeenCalledWith(PARTIAL_RESPONSE_ASSISTANT_PROMPT)

    act(() => {
      const dismissButton = Array.from(container!.querySelectorAll('button'))
        .find(button => button.textContent === 'Dismiss')
      dismissButton?.click()
    })
    expect(container.querySelector('[role="status"]')).toBeNull()
  })
})
