import { describe, it, expect } from 'vitest'
import { derivePulseChips } from '@/app/components/RightPanelWorkspace'
import type { ExecutionSnapshot } from './execution-context'

/** The Pulse tab's "ask the assistant" chips are derived, not hand-wired —
 *  each one exists only when the snapshot shows something worth asking. */

function snap(over: Partial<ExecutionSnapshot> = {}): ExecutionSnapshot {
  return {
    generatedAt: '2026-09-05T15:00:00Z',
    runs: { windowHours: 24, truncated: false, total: 10, ok: 10, error: 0, byEngine: {}, bySource: {}, allotmentSharePercent: 80, p50LatencyMs: 2000, totalTokens: 1, errorClasses: {}, recentFailures: [] },
    dispatch: { enabled: true, freshMs: 45_000, workers: [{ id: 'w', fresh: true, lastSeenAt: 'x', version: null, agyVersion: null }], queue: {} },
    actions: { total: 3, failed: 0, recent: [] },
    toolRuns: { active: 0, recent: [] },
    notices: [],
    ...over,
  }
}

describe('derivePulseChips', () => {
  it('always ends with the health-summary chip and nothing else when all is well', () => {
    expect(derivePulseChips(snap()).map((c) => c.key)).toEqual(['summary'])
  })

  it('raises an alert chip per failing plane, with counts the model can quote', () => {
    const s = snap({
      runs: { ...snap().runs!, error: 2, errorClasses: { timeout: 1, auth: 1 } },
      dispatch: { enabled: true, freshMs: 45_000, workers: [{ id: 'w', fresh: false, lastSeenAt: 'x', version: null, agyVersion: null }], queue: { queued: 5 } },
      actions: { total: 3, failed: 1, recent: [] },
      toolRuns: { active: 1, recent: [] },
    })
    const chips = derivePulseChips(s)
    expect(chips.map((c) => c.key)).toEqual(['runs_failed', 'worker_offline', 'queue_backlog', 'actions_failed', 'deep_active', 'summary'])
    expect(chips[0].prompt).toContain('2 of the last 10 model runs failed')
    expect(chips[0].prompt).toContain('timeout×1, auth×1')
    expect(chips[2].count).toBe(5)
    expect(chips.filter((c) => c.alert).length).toBe(4)
  })

  it('stays quiet about dispatch when it is disabled and no worker ever registered', () => {
    const s = snap({ dispatch: { enabled: false, freshMs: 45_000, workers: [], queue: {} } })
    expect(derivePulseChips(s).map((c) => c.key)).toEqual(['summary'])
  })

  it('has no admin-plane chips for a non-admin snapshot', () => {
    expect(derivePulseChips(snap({ runs: null, dispatch: null })).map((c) => c.key)).toEqual(['summary'])
  })

  it('raises nothing for planes whose read failed (null), rather than treating them as empty', () => {
    expect(derivePulseChips(snap({ actions: null, toolRuns: null })).map((c) => c.key)).toEqual(['summary'])
  })
})
