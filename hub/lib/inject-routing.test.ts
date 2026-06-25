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
