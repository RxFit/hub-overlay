import { describe, it, expect } from 'vitest'
import { runToFeedItem, engineLabel } from './run-feed'
import type { AiRunRecord } from './runs'

/**
 * AiRunRecord → FeedItem (Phase 3 PR 2). Locks:
 *  - the verdict mapping (ok → completed, error → needs_you),
 *  - the injectable title carries the run's identity (short id, engine,
 *    source, typed class) on its own,
 *  - `run.error` message text NEVER reaches the card — the hardening
 *    review's content-leak rule applied at the presentation layer,
 *  - metadata carries the correlation fields the assistant will need.
 */

function record(over: Partial<AiRunRecord> = {}): AiRunRecord {
  return {
    id: 'a1b2c3d4-0000-0000-0000-000000000000',
    createdAt: '2026-08-24T04:00:00.000Z',
    engine: 'agy',
    model: 'gemini-3-flash',
    source: 'chat',
    status: 'ok',
    errorClass: null,
    error: null,
    latencyMs: 3210,
    inputTokens: null,
    outputTokens: null,
    cacheReadTokens: null,
    totalTokens: 812,
    promptChars: 120,
    promptSha256: 'abcd1234abcd1234',
    requestId: 'req-1',
    userEmail: null,
    meta: null,
    ...over,
  }
}

describe('runToFeedItem', () => {
  it('maps a served run to a completed card with identity in the title', () => {
    const item = runToFeedItem(record())
    expect(item.type).toBe('completed')
    expect(item.source).toBe('run')
    expect(item.id).toBe('run-a1b2c3d4-0000-0000-0000-000000000000')
    expect(item.title).toBe('Run a1b2c3d4 — agy chat served')
    expect(item.description).toContain('agy · allotment')
    expect(item.description).toContain('gemini-3-flash')
    expect(item.description).toContain('3.2s')
    expect(item.description).toContain('812 tok')
    expect(item.timestamp).toBe('2026-08-24T04:00:00.000Z')
  })

  it('maps a failed run to needs_you with the typed class — never the message text', () => {
    const item = runToFeedItem(
      record({
        status: 'error',
        errorClass: 'parse',
        error: 'SENSITIVE-OUTPUT-TAIL the model said something private here',
      }),
    )
    expect(item.type).toBe('needs_you')
    expect(item.title).toBe('Run a1b2c3d4 — agy chat failed (parse)')
    expect(item.title).not.toContain('SENSITIVE')
    expect(item.description).not.toContain('SENSITIVE')
    expect(JSON.stringify(item.metadata)).not.toContain('SENSITIVE')
  })

  it('a failed run with no class reads as unknown', () => {
    const item = runToFeedItem(record({ status: 'error', errorClass: null }))
    expect(item.title).toContain('failed (unknown)')
  })

  it('metered engines are labeled as metered; unknown engines pass through', () => {
    expect(engineLabel('gemini')).toBe('Gemini · metered')
    expect(engineLabel('claude')).toBe('Claude · metered')
    expect(engineLabel('somefuture')).toBe('somefuture')
  })

  it('sub-second latency renders in ms; missing model and tokens are omitted', () => {
    const item = runToFeedItem(record({ latencyMs: 430, model: null, totalTokens: null }))
    expect(item.description).toContain('430ms')
    expect(item.description).not.toContain('null')
    expect(item.description).not.toContain('tok')
  })

  it('a dispatch-served run names its worker', () => {
    const item = runToFeedItem(record({ meta: { dispatch: true, workerId: 'danny-desktop' } }))
    expect(item.description).toContain('via danny-desktop')
  })

  it('metadata carries the correlation fields', () => {
    const item = runToFeedItem(record({ status: 'error', errorClass: 'no_worker' }))
    expect(item.metadata).toMatchObject({
      runId: 'a1b2c3d4-0000-0000-0000-000000000000',
      engine: 'agy',
      status: 'error',
      errorClass: 'no_worker',
      latencyMs: 3210,
      requestId: 'req-1',
    })
  })
})
