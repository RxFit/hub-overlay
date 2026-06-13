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

  it('isolates history by scope so user A does not trip user B', () => {
    const body = JSON.stringify({ title: 'x' })
    // User A executes 2 write requests
    expect(() => loopDetector.detectAndRecord('POST', '/api/issues', body, 'userA@example.com')).not.toThrow()
    expect(() => loopDetector.detectAndRecord('POST', '/api/issues', body, 'userA@example.com')).not.toThrow()

    // User B executes a write request with same payload — should not throw
    expect(() => loopDetector.detectAndRecord('POST', '/api/issues', body, 'userB@example.com')).not.toThrow()

    // User A executes a 3rd write request — should trip for User A
    expect(() => loopDetector.detectAndRecord('POST', '/api/issues', body, 'userA@example.com')).toThrow(LoopDetectedError)

    // User B executes a 2nd write request — should not throw for User B
    expect(() => loopDetector.detectAndRecord('POST', '/api/issues', body, 'userB@example.com')).not.toThrow()
  })
})
