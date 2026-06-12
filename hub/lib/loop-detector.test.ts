import { describe, it, expect, beforeEach } from 'vitest'
import { loopDetector, LoopDetectedError } from '@/lib/loop-detector'

describe('loopDetector', () => {
  beforeEach(() => loopDetector.clear())

  it('throws when the same write repeats 3x in the time window', () => {
    const body = JSON.stringify({ title: 'x' })
    expect(() => loopDetector.detectAndRecord('POST', '/api/issues', body)).not.toThrow()
    expect(() => loopDetector.detectAndRecord('POST', '/api/issues', body)).not.toThrow()
    expect(() => loopDetector.detectAndRecord('POST', '/api/issues', body)).toThrow(LoopDetectedError)
  })

  it('never throttles GET/HEAD reads', () => {
    for (let i = 0; i < 10; i++) {
      expect(() => loopDetector.detectAndRecord('GET', '/api/companies')).not.toThrow()
    }
  })

  it('does not trip for distinct write payloads', () => {
    expect(() => loopDetector.detectAndRecord('POST', '/api/issues', '{"title":"a"}')).not.toThrow()
    expect(() => loopDetector.detectAndRecord('POST', '/api/issues', '{"title":"b"}')).not.toThrow()
    expect(() => loopDetector.detectAndRecord('POST', '/api/issues', '{"title":"c"}')).not.toThrow()
  })
})
