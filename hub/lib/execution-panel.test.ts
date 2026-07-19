import { describe, it, expect } from 'vitest'
import {
  normalizeComments,
  wireStatusForState,
  availableAgentActions,
  ISSUE_STATE_OPTIONS,
} from '@/lib/execution-panel'

describe('normalizeComments', () => {
  it('handles bare arrays and wrapped { comments } responses', () => {
    const raw = [{ id: 'c1', body: 'hello', authorType: 'agent', authorName: 'CEO', createdAt: 't1' }]
    expect(normalizeComments(raw)).toHaveLength(1)
    expect(normalizeComments({ comments: raw })).toHaveLength(1)
    expect(normalizeComments(raw)[0]).toMatchObject({ id: 'c1', body: 'hello', authorType: 'agent', authorName: 'CEO' })
  })

  it('degrades unknown author metadata to system and tolerates junk', () => {
    const out = normalizeComments([
      { id: 'c1', body: 'ok' },
      { body: 'actor fallback', actorType: 'user', actorId: 'danny@x.com' },
      null,
      'garbage',
      { id: 'empty-body', body: '' },
    ])
    expect(out).toHaveLength(2)
    expect(out[0].authorType).toBe('system')
    expect(out[1]).toMatchObject({ authorType: 'user', authorName: 'danny@x.com' })
  })

  it('returns [] for non-array shapes', () => {
    expect(normalizeComments(null)).toEqual([])
    expect(normalizeComments({ nope: true })).toEqual([])
    expect(normalizeComments('x')).toEqual([])
  })
})

describe('wireStatusForState', () => {
  it('maps Hub state names to wire statuses exactly', () => {
    expect(wireStatusForState({ group: 'started', name: 'In Review' })).toBe('in_review')
    expect(wireStatusForState({ group: 'started', name: 'Blocked' })).toBe('blocked')
    expect(wireStatusForState({ group: 'completed', name: 'Done' })).toBe('done')
  })

  it('falls back to the group when the name is unrecognized', () => {
    expect(wireStatusForState({ group: 'backlog', name: 'Weird' })).toBe('backlog')
    expect(wireStatusForState({ group: 'unstarted', name: 'Weird' })).toBe('todo')
    expect(wireStatusForState({ group: 'started', name: 'Weird' })).toBe('in_progress')
    expect(wireStatusForState({ group: 'cancelled', name: 'Weird' })).toBe('cancelled')
    expect(wireStatusForState({ group: '???', name: '???' })).toBe('todo')
  })

  it('every offered option round-trips to itself', () => {
    for (const opt of ISSUE_STATE_OPTIONS) {
      expect(wireStatusForState({ group: 'x', name: opt.label })).toBe(opt.status)
    }
  })
})

describe('availableAgentActions', () => {
  it('offers nothing for terminated or pending agents', () => {
    expect(availableAgentActions({ status: 'inactive', rawStatus: 'terminated' })).toEqual([])
    expect(availableAgentActions({ status: 'inactive', rawStatus: 'pending_approval' })).toEqual([])
  })

  it('leads with clear-error for errored agents', () => {
    expect(availableAgentActions({ status: 'error', rawStatus: 'error' })).toEqual(['clear-error', 'wakeup'])
    // Hub-status error wins even if rawStatus is missing
    expect(availableAgentActions({ status: 'error' })).toEqual(['clear-error', 'wakeup'])
  })

  it('paused agents can only resume; running agents can only pause', () => {
    expect(availableAgentActions({ status: 'inactive', rawStatus: 'paused' })).toEqual(['resume'])
    expect(availableAgentActions({ status: 'active', rawStatus: 'running' })).toEqual(['pause'])
  })

  it('idle/active agents can wake or pause', () => {
    expect(availableAgentActions({ status: 'inactive', rawStatus: 'idle' })).toEqual(['wakeup', 'pause'])
    expect(availableAgentActions({ status: 'active', rawStatus: 'active' })).toEqual(['wakeup', 'pause'])
    expect(availableAgentActions({ status: 'active' })).toEqual(['wakeup', 'pause'])
  })
})
