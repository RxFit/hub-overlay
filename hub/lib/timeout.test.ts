import { describe, it, expect } from 'vitest'
import { withTimeout } from './timeout'

function delayed<T>(value: T, ms: number): Promise<T> {
  return new Promise((resolve) => setTimeout(() => resolve(value), ms))
}

describe('withTimeout', () => {
  it('returns the promise value when it settles before the deadline', async () => {
    await expect(withTimeout(delayed('fast', 5), 1000, 'fallback', 'test')).resolves.toBe('fast')
  })

  it('returns the fallback when the promise outlives the deadline', async () => {
    await expect(withTimeout(delayed('slow', 500), 10, 'fallback', 'test')).resolves.toBe(
      'fallback',
    )
  })

  it('propagates a rejection instead of masking it with the fallback', async () => {
    // Errors must surface to the caller — withTimeout only guards against
    // HANGS, it must not convert real failures into a fake success value.
    await expect(
      withTimeout(Promise.reject(new Error('upstream exploded')), 1000, 'fallback', 'test'),
    ).rejects.toThrow('upstream exploded')
  })

  it('supports non-primitive fallback values', async () => {
    const fallback = { items: [] as string[] }
    const result = await withTimeout(delayed({ items: ['a'] }, 500), 10, fallback, 'test')
    expect(result).toBe(fallback)
  })
})
