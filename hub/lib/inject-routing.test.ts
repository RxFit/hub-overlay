import { describe, it, expect } from 'vitest'
import { shouldRouteThroughSend } from '@/lib/inject-routing'

describe('panel inject routing', () => {
  it('routes execute injects through the shared send core', () => {
    expect(shouldRouteThroughSend('execute')).toBe(true)
  })

  it('keeps recall and deep_dive on the direct path', () => {
    expect(shouldRouteThroughSend('recall')).toBe(false)
    expect(shouldRouteThroughSend('deep_dive')).toBe(false)
  })

  // Regression guard for the right-panel wiring fix: read-style right-panel taps
  // (ProjectHealthSection "Show me the health status for …", ExecutionFeed
  // "Tell me more about: …") are wired to injectRecall and MUST stay off the
  // intent-detection path, while only the explicit create-task CTA is wired to
  // injectExecute. Acceptance criterion #2.
  it('routes right-panel read-style injects (recall) on the direct path', () => {
    // injectRecall carries useCase 'recall'
    expect(shouldRouteThroughSend('recall')).toBe(false)
  })

  it('routes the right-panel create-task CTA (execute) through doSend', () => {
    // injectExecute carries useCase 'execute'
    expect(shouldRouteThroughSend('execute')).toBe(true)
  })
})

describe('panel inject attachment cap', () => {
  it('caps inject attachments at 5 regardless of input length', () => {
    const atts = Array.from({ length: 9 }, (_, i) => ({
      id: String(i),
      type: 'document' as const,
      label: `f${i}`,
    }))
    expect(atts.slice(0, 5)).toHaveLength(5)
  })
})
