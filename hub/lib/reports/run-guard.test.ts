import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * The window-claim guard's CONTRACT, with the database stubbed.
 *
 * What matters here is the shape of the call, because the correctness argument
 * rests on it: the claim must be a single INSERT … ON CONFLICT DO NOTHING
 * targeting (tenant_id, report_id, window_start) and must decide from what the
 * insert RETURNS. A read-then-write implementation would pass a naive test and
 * still let two concurrent ticks both generate. The companion suite
 * (tests/report-runs-db.test.ts) proves the same behavior against real
 * Postgres; this one pins the mechanism so a refactor cannot quietly swap it.
 */

const { insertMock, deleteMock, updateMock, selectMock, state } = vi.hoisted(() => {
  const state = {
    selectRows: [] as Array<{ reportId: string; windowStart: string }>,
    returned: [{ id: 'row-1' }] as Array<{ id: string }>,
    onConflictTarget: null as unknown,
    inserted: null as unknown,
    deleteWhereCalled: false,
    updateSet: null as unknown,
    throwOnInsert: false,
  }
  return {
    state,
    insertMock: vi.fn(() => ({
      values: (v: unknown) => {
        state.inserted = v
        return {
          onConflictDoNothing: (args: unknown) => {
            state.onConflictTarget = args
            return {
              returning: async () => {
                if (state.throwOnInsert) throw new Error('db down')
                return state.returned
              },
            }
          },
        }
      },
    })),
    deleteMock: vi.fn(() => ({
      where: async () => {
        state.deleteWhereCalled = true
      },
    })),
    updateMock: vi.fn(() => ({
      set: (v: unknown) => {
        state.updateSet = v
        return { where: async () => {} }
      },
    })),
    selectMock: vi.fn(() => ({
      from: () => ({ where: async () => state.selectRows }),
    })),
  }
})

vi.mock('../db', () => ({
  db: { insert: insertMock, delete: deleteMock, update: updateMock, select: selectMock },
}))

import {
  claimReportWindow,
  releaseReportWindow,
  completeReportWindow,
  findClaimedWindows,
  windowKey,
} from './run-guard'

const claim = {
  tenantId: 'rxfit',
  reportId: 'weekly-digest',
  windowStart: '2026-08-17',
  windowEnd: '2026-08-23',
}

beforeEach(() => {
  state.returned = [{ id: 'row-1' }]
  state.onConflictTarget = null
  state.inserted = null
  state.deleteWhereCalled = false
  state.updateSet = null
  state.throwOnInsert = false
  state.selectRows = []
  selectMock.mockClear()
  insertMock.mockClear()
  deleteMock.mockClear()
  updateMock.mockClear()
})

describe('claimReportWindow', () => {
  it('claims via INSERT … ON CONFLICT DO NOTHING and reports the win', async () => {
    expect(await claimReportWindow(claim)).toBe(true)
    expect(insertMock).toHaveBeenCalledOnce()
    expect(state.inserted).toMatchObject({
      tenantId: 'rxfit',
      reportId: 'weekly-digest',
      windowStart: '2026-08-17',
      windowEnd: '2026-08-23',
    })
    // The conflict target IS the correctness argument — it must be the unique
    // (tenant, report, window) index, not a bare DO NOTHING.
    expect(state.onConflictTarget).toBeTruthy()
    expect((state.onConflictTarget as { target?: unknown[] }).target).toHaveLength(3)
  })

  it('an already-claimed window returns no row, so the caller must not generate', async () => {
    state.returned = []
    expect(await claimReportWindow(claim)).toBe(false)
  })

  it('propagates a database failure rather than reporting a false claim', async () => {
    // The route fails CLOSED on a throw (never generates unclaimed) but records
    // it as FAILED, not skipped — a claim error means the database is down and
    // no report was produced, which must reach the workflow's failure alert.
    state.throwOnInsert = true
    await expect(claimReportWindow(claim)).rejects.toThrow('db down')
  })

  it('a missing windowEnd stores null rather than undefined', async () => {
    await claimReportWindow({ ...claim, windowEnd: undefined })
    expect((state.inserted as { windowEnd: unknown }).windowEnd).toBeNull()
  })
})

describe('releaseReportWindow', () => {
  it('deletes the claim so a later tick can retry the window', async () => {
    await releaseReportWindow(claim)
    expect(deleteMock).toHaveBeenCalledOnce()
    expect(state.deleteWhereCalled).toBe(true)
  })

  it('never throws — a release failure must not mask the generation error', async () => {
    deleteMock.mockImplementationOnce(() => {
      throw new Error('db down')
    })
    await expect(releaseReportWindow(claim)).resolves.toBeUndefined()
  })
})

describe('completeReportWindow', () => {
  it('records the artifact id on the claim row', async () => {
    await completeReportWindow(claim, 'doc-123')
    expect(updateMock).toHaveBeenCalledOnce()
    expect(state.updateSet).toEqual({ documentId: 'doc-123' })
  })

  it('never throws — the report exists in Drive either way', async () => {
    updateMock.mockImplementationOnce(() => {
      throw new Error('db down')
    })
    await expect(completeReportWindow(claim, 'doc-123')).resolves.toBeUndefined()
  })
})

describe('findClaimedWindows', () => {
  it('returns the pairs that are already claimed', async () => {
    state.selectRows = [{ reportId: 'weekly-digest', windowStart: '2026-08-17' }]
    const claimed = await findClaimedWindows('rxfit', [
      { reportId: 'weekly-digest', windowStart: '2026-08-17' },
      { reportId: 'monthly-review', windowStart: '2026-08-01' },
    ])
    expect(claimed.has(windowKey('weekly-digest', '2026-08-17'))).toBe(true)
    expect(claimed.has(windowKey('monthly-review', '2026-08-01'))).toBe(false)
  })

  it('does not query at all for an empty candidate list', async () => {
    expect((await findClaimedWindows('rxfit', [])).size).toBe(0)
    expect(selectMock).not.toHaveBeenCalled()
  })

  it('ignores a CROSS-MATCHED row the two IN lists can return', async () => {
    // The query filters report_id IN (…) AND window_start IN (…), so it can
    // return report A paired with report B's window. Treating that as claimed
    // would silently skip a report that was never generated.
    state.selectRows = [{ reportId: 'weekly-digest', windowStart: '2026-08-01' }]
    const claimed = await findClaimedWindows('rxfit', [
      { reportId: 'weekly-digest', windowStart: '2026-08-17' },
      { reportId: 'monthly-review', windowStart: '2026-08-01' },
    ])
    expect(claimed.size).toBe(0)
  })
})
