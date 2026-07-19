import { describe, it, expect } from 'vitest'
import {
  normalizeComments,
  normalizeRoutineRuns,
  buildGoalTree,
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

describe('normalizeRoutineRuns', () => {
  it('handles bare arrays and wrapped { runs } with defaults', () => {
    const raw = [{ id: 'r1', status: 'dispatched', source: 'schedule', linkedIssueId: 'i1', createdAt: 't1', completedAt: 't2' }]
    expect(normalizeRoutineRuns(raw)[0]).toMatchObject({ id: 'r1', status: 'dispatched', linkedIssueId: 'i1' })
    expect(normalizeRoutineRuns({ runs: raw })).toHaveLength(1)
    const bare = normalizeRoutineRuns([{}])[0]
    expect(bare.status).toBe('unknown')
    expect(bare.linkedIssueId).toBeNull()
    expect(normalizeRoutineRuns(null)).toEqual([])
  })
})

describe('buildGoalTree', () => {
  const g = (id: string, parentId: string | null, level: string, title = id) => ({ id, parentId, level, title })

  it('orders parents before children with correct depths', () => {
    const tree = buildGoalTree([
      g('t1', 'c1', 'team'),
      g('c1', null, 'company'),
      g('a1', 't1', 'agent'),
    ])
    expect(tree.map((n) => [n.goal.id, n.depth])).toEqual([['c1', 0], ['t1', 1], ['a1', 2]])
  })

  it('treats orphaned parentIds as roots so nothing disappears', () => {
    const tree = buildGoalTree([g('x', 'missing-parent', 'team')])
    expect(tree).toEqual([{ goal: expect.objectContaining({ id: 'x' }), depth: 0 }])
  })

  it('sorts siblings by level order (company→team→agent→task) then title', () => {
    const tree = buildGoalTree([
      g('b-task', null, 'task', 'B'),
      g('a-team', null, 'team', 'A'),
      g('z-team', null, 'team', 'Z'),
    ])
    expect(tree.map((n) => n.goal.id)).toEqual(['a-team', 'z-team', 'b-task'])
  })

  it('breaks parentId cycles instead of hanging', () => {
    const tree = buildGoalTree([g('a', 'b', 'team'), g('b', 'a', 'team')])
    expect(tree).toHaveLength(2)
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
