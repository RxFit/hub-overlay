import { describe, it, expect } from 'vitest'
import { clampInt } from './num'

describe('clampInt', () => {
  it('returns the fallback for missing or empty input', () => {
    expect(clampInt(null, 20, 1, 100)).toBe(20)
    expect(clampInt(undefined, 20, 1, 100)).toBe(20)
    expect(clampInt('', 20, 1, 100)).toBe(20)
  })

  it('returns the fallback for non-numeric input', () => {
    expect(clampInt('abc', 15, 1, 100)).toBe(15)
  })

  it('clamps to the allowed range', () => {
    expect(clampInt('-1', 20, 1, 100)).toBe(1)
    expect(clampInt('0', 20, 1, 100)).toBe(1)
    expect(clampInt('999999', 20, 1, 100)).toBe(100)
    expect(clampInt('50', 20, 1, 100)).toBe(50)
  })

  it('floors a numeric-with-trailing-garbage value (parseInt semantics)', () => {
    expect(clampInt('25abc', 20, 1, 100)).toBe(25)
  })
})
