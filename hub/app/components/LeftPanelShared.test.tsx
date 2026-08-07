// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'

const signInMock = vi.fn()
vi.mock('next-auth/react', () => ({
  signIn: (...args: unknown[]) => signInMock(...args),
}))

import { SectionMessage, AuthExpiredMessage } from './LeftPanelShared'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

/* The audit (docs/left-panel-audit/02) found "Session expired — please sign in
   again" rendered as a dead end: the documented reauth hook was mounted
   nowhere, and the message offered no way to actually sign in. These lock the
   replacement: an explicit per-section "Sign in again" affordance. */

function render(element: React.ReactElement) {
  const container = document.createElement('div')
  document.body.appendChild(container)
  let root: Root
  act(() => {
    root = createRoot(container)
    root.render(element)
  })
  return {
    container,
    unmount: () => act(() => { root.unmount(); container.remove() }),
  }
}

afterEach(() => signInMock.mockClear())

describe('SectionMessage action affordance', () => {
  it('renders no button without an action (existing call sites unchanged)', () => {
    const { container, unmount } = render(createElement(SectionMessage, { message: 'All quiet', type: 'info' }))
    expect(container.textContent).toContain('All quiet')
    expect(container.querySelector('button')).toBeNull()
    unmount()
  })

  it('renders the action button and forwards clicks', () => {
    const onClick = vi.fn()
    const { container, unmount } = render(
      createElement(SectionMessage, { message: 'Broken', type: 'error', action: { label: 'Retry', onClick } }),
    )
    const button = container.querySelector('button')
    expect(button?.textContent).toBe('Retry')
    act(() => button!.click())
    expect(onClick).toHaveBeenCalledTimes(1)
    unmount()
  })

  it('keeps the alert role on error messages so screen readers announce them', () => {
    const { container, unmount } = render(
      createElement(SectionMessage, { message: 'Broken', type: 'error', action: { label: 'Fix', onClick: () => {} } }),
    )
    expect(container.querySelector('[role="alert"]')).not.toBeNull()
    unmount()
  })
})

describe('AuthExpiredMessage', () => {
  it('offers "Sign in again" and triggers the Google sign-in on click', () => {
    const { container, unmount } = render(createElement(AuthExpiredMessage, {}))
    expect(container.textContent).toContain('Google session expired')
    const button = container.querySelector('button')
    expect(button?.textContent).toBe('Sign in again')
    act(() => button!.click())
    expect(signInMock).toHaveBeenCalledWith('google')
    unmount()
  })
})
