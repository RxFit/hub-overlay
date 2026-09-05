import { describe, it, expect } from 'vitest'
import { feedItemToAttachment, buildFeedInjectMessage } from './feed-attachment'
import { runToFeedItem } from './run-feed'
import { aiActionToFeedItem } from './ai-action-feed'
import type { AiRunRecord } from './runs'
import type { AiActionRecord } from './ai-audit'

/**
 * A right-panel card tap must carry the ledger row BY REFERENCE (Phase 4
 * PR 1). Locks the mapping from each feed source to its record kind, and
 * that the reference is built from the SAME metadata the feed mappers emit
 * — so a mapper renaming its id key breaks here, not silently in production.
 */

const run: AiRunRecord = {
  id: '89378f4f-1111-4000-8000-000000000001',
  createdAt: '2026-09-05T14:00:00.000Z',
  engine: 'agy', model: null, source: 'chat', status: 'ok', errorClass: null, error: null,
  latencyMs: 25_600, inputTokens: null, outputTokens: null, cacheReadTokens: null, totalTokens: 22_271,
  promptChars: null, promptSha256: null, requestId: null, userEmail: null, meta: null,
}

const action: AiActionRecord = {
  id: 'act-1', createdAt: '2026-09-05T14:00:00.000Z', userEmail: 'd@x', actor: 'ai',
  actionType: 'gmail_focus', target: null, intent: 'Prioritized inbox focus queue',
  gateTokenId: null, requestId: null, status: 'success', error: null,
}

describe('feedItemToAttachment', () => {
  it('turns a run card into an ai_run record reference', () => {
    const att = feedItemToAttachment(runToFeedItem(run))
    expect(att).toEqual({
      id: 'record-run-89378f4f-1111-4000-8000-000000000001',
      type: 'record',
      label: 'Run 89378f4f — agy chat served',
      recordKind: 'ai_run',
      recordId: run.id,
    })
  })

  it('turns an AI-action card into an ai_action record reference', () => {
    const att = feedItemToAttachment(aiActionToFeedItem(action))
    expect(att).toMatchObject({ type: 'record', recordKind: 'ai_action', recordId: 'act-1', label: 'AI performed an action' })
  })

  it('returns null for a card with no ledger row behind it', () => {
    expect(feedItemToAttachment({ id: 'x', source: 'system', type: 'info', title: 'note' })).toBeNull()
    expect(feedItemToAttachment({ id: 'x', source: 'run', type: 'info', title: 'note', metadata: {} })).toBeNull()
  })
})

describe('buildFeedInjectMessage', () => {
  it('keeps the read-style "Tell me more about:" form and asks for a failure post-mortem when needed', () => {
    const okMsg = buildFeedInjectMessage(runToFeedItem(run))
    expect(okMsg.startsWith('Tell me more about: Run 89378f4f — agy chat served')).toBe(true)
    expect(okMsg).toContain('follow up')
    const failMsg = buildFeedInjectMessage(runToFeedItem({ ...run, status: 'error', errorClass: 'timeout' }))
    expect(failMsg).toContain('why did it fail')
  })
})
