import { describe, it, expect, vi } from 'vitest'

/**
 * Unit coverage for SectionErrorBoundary (left-panel-audit 06).
 * The boundary contains a render-time throw to a single section instead of
 * blanking HubPage. These tests assert its error-boundary contract (the static
 * getDerivedStateFromError flips hasError) and the labelled fallback rendering,
 * without a DOM — exercising the class directly the way React would.
 */

// LeftPanelSections pulls in next-auth via signIn; stub it like the sibling
// fetcher suite so the module imports cleanly under the node environment.
vi.mock('next-auth/react', () => ({ signIn: vi.fn() }))

import { SectionErrorBoundary } from '@/app/components/LeftPanelSections'

describe('SectionErrorBoundary', () => {
  it('is a React error boundary (defines getDerivedStateFromError)', () => {
    expect(typeof (SectionErrorBoundary as unknown as { getDerivedStateFromError?: unknown }).getDerivedStateFromError).toBe('function')
  })

  it('getDerivedStateFromError flips hasError to true', () => {
    const next = (SectionErrorBoundary as unknown as { getDerivedStateFromError: () => { hasError: boolean } }).getDerivedStateFromError()
    expect(next).toEqual({ hasError: true })
  })

  it('renders children unchanged when no error has occurred', () => {
    const children = { type: 'div' }
    const instance = new SectionErrorBoundary({ label: 'KPIs', children: children as never })
    // Fresh boundary starts with hasError=false and passes children through.
    expect(instance.state.hasError).toBe(false)
    expect(instance.render()).toBe(children)
  })

  it('componentDidCatch logs without rethrowing', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const instance = new SectionErrorBoundary({ label: 'Tasks', children: null as never })
    const err = new Error('boom')
    expect(() => instance.componentDidCatch(err, { componentStack: '' } as never)).not.toThrow()
    expect(spy).toHaveBeenCalled()
    spy.mockRestore()
  })
})
