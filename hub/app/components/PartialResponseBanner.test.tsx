// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { PartialResponseBanner } from './PartialResponseBanner'
import {
  __resetPartialResponseNoticeForTests,
  observePartialResponse,
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
      ;(container!.querySelector('button') as HTMLButtonElement).click()
    })
    expect(container.querySelector('[role="status"]')).toBeNull()
  })
})
