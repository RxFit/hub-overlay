import { describe, it, expect } from 'vitest'
import { aiActionToFeedItem } from './ai-action-feed'
import type { AiActionRecord } from './ai-audit'

/* ════════════════════════════════════════════════════════════════════════════
   Pure formatter tests (NS-9): every action_type × success/failed, unknown
   types, degenerate target shapes, and the defensive no-leak contract — a
   body-like key smuggled into `target` must never surface in the card.
   ════════════════════════════════════════════════════════════════════════════ */

function record(overrides: Partial<AiActionRecord> = {}): AiActionRecord {
  return {
    id: 'row-1',
    createdAt: '2026-07-08T12:00:00.000Z',
    userEmail: 'danny@rxfitatx.com',
    actor: 'ai',
    actionType: 'gmail_send',
    target: null,
    intent: null,
    gateTokenId: null,
    requestId: 'req-1',
    status: 'success',
    error: null,
    ...overrides,
  }
}

describe('aiActionToFeedItem — common envelope', () => {
  it('sets id/source/timestamp/icon and metadata from the row', () => {
    const item = aiActionToFeedItem(record({ id: 'abc-123', requestId: 'req-9' }))
    expect(item.id).toBe('ai-abc-123')
    expect(item.source).toBe('ai_action')
    expect(item.timestamp).toBe('2026-07-08T12:00:00.000Z')
    expect(item.icon).toBe('sparkles')
    expect(item.metadata).toEqual({
      actionType: 'gmail_send',
      status: 'success',
      requestId: 'req-9',
    })
  })

  it('maps success → completed, failed → needs_you, anything else → info', () => {
    expect(aiActionToFeedItem(record({ status: 'success' })).type).toBe('completed')
    expect(aiActionToFeedItem(record({ status: 'failed' })).type).toBe('needs_you')
    expect(aiActionToFeedItem(record({ status: 'weird' })).type).toBe('info')
  })

  it('includes intent and machine error reason in the description', () => {
    const ok = aiActionToFeedItem(record({ intent: 'send_email' }))
    expect(ok.description).toBe('send_email · Completed successfully')

    const failed = aiActionToFeedItem(
      record({ intent: 'send_email', status: 'failed', error: 'rate_limited' })
    )
    expect(failed.description).toBe('send_email · Failed — rate_limited')

    const bare = aiActionToFeedItem(record({ status: 'failed' }))
    expect(bare.description).toBe('Failed')
  })
})

describe('aiActionToFeedItem — titles per action type', () => {
  it('gmail_send success uses recipient (or to) from target', () => {
    expect(
      aiActionToFeedItem(record({ target: { recipient: 'client@example.com' } })).title
    ).toBe('AI sent an email to client@example.com')
    expect(
      aiActionToFeedItem(record({ target: { to: 'client@example.com' } })).title
    ).toBe('AI sent an email to client@example.com')
  })

  it('gmail_send tolerates a missing recipient', () => {
    expect(aiActionToFeedItem(record({ target: null })).title).toBe(
      'AI sent an email to a recipient'
    )
    expect(aiActionToFeedItem(record({ target: { to: '   ' } })).title).toBe(
      'AI sent an email to a recipient'
    )
  })

  it('gmail_send failed variant', () => {
    const item = aiActionToFeedItem(
      record({ status: 'failed', target: { to: 'client@example.com' }, error: 'rate_limited' })
    )
    expect(item.title).toBe('AI email to client@example.com failed')
    expect(item.type).toBe('needs_you')
  })

  it('chat_post success/failed uses space (or spaceName)', () => {
    expect(
      aiActionToFeedItem(record({ actionType: 'chat_post', target: { space: 'spaces/ops' } })).title
    ).toBe('AI posted in spaces/ops')
    expect(
      aiActionToFeedItem(record({ actionType: 'chat_post', target: { spaceName: 'Ops' } })).title
    ).toBe('AI posted in Ops')
    expect(
      aiActionToFeedItem(record({ actionType: 'chat_post', target: null })).title
    ).toBe('AI posted in a chat space')
    expect(
      aiActionToFeedItem(
        record({ actionType: 'chat_post', status: 'failed', target: { space: 'spaces/ops' } })
      ).title
    ).toBe('AI post in spaces/ops failed')
  })

  it('task_create success/failed with title, taskId, or nothing', () => {
    expect(
      aiActionToFeedItem(record({ actionType: 'task_create', target: { title: 'Call vendor' } })).title
    ).toBe('AI created task "Call vendor"')
    expect(
      aiActionToFeedItem(record({ actionType: 'task_create', target: { taskId: 't-42' } })).title
    ).toBe('AI created task t-42')
    expect(
      aiActionToFeedItem(record({ actionType: 'task_create', target: null })).title
    ).toBe('AI created a task')
    expect(
      aiActionToFeedItem(record({ actionType: 'task_create', status: 'failed' })).title
    ).toBe('AI task creation failed')
  })

  it('unknown action types get the generic titles', () => {
    expect(aiActionToFeedItem(record({ actionType: 'calendar_invite' })).title).toBe(
      'AI performed an action'
    )
    expect(
      aiActionToFeedItem(record({ actionType: 'calendar_invite', status: 'failed' })).title
    ).toBe('AI action failed')
  })
})

describe('aiActionToFeedItem — defensive contract', () => {
  it('never throws on degenerate target shapes', () => {
    const shapes: unknown[] = [
      null,
      undefined,
      'a plain string',
      42,
      true,
      [],
      ['x@y.com'],
      { to: 123 },
      { to: { nested: 'object' } },
      { recipient: null },
    ]
    for (const target of shapes) {
      const item = aiActionToFeedItem(
        record({ target: target as AiActionRecord['target'] })
      )
      expect(item.title).toBe('AI sent an email to a recipient')
    }
  })

  it('never copies body-like target keys into the card', () => {
    const item = aiActionToFeedItem(
      record({
        target: {
          to: 'client@example.com',
          message: 'SECRET BODY',
          body: 'SECRET BODY',
          subject: 'SECRET SUBJECT',
          token: 'SECRET TOKEN',
        },
      })
    )
    const serialized = JSON.stringify(item)
    expect(serialized).not.toContain('SECRET')
    expect(serialized).toContain('client@example.com')
    // metadata is a fixed scalar envelope — nothing from target is copied
    expect(Object.keys(item.metadata ?? {}).sort()).toEqual([
      'actionType',
      'requestId',
      'status',
    ])
  })

  it('falls back to a fresh ISO timestamp when createdAt is not a string', () => {
    const item = aiActionToFeedItem(
      record({ createdAt: undefined as unknown as string })
    )
    expect(Number.isNaN(Date.parse(item.timestamp))).toBe(false)
  })
})
