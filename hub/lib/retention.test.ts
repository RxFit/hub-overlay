import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

/**
 * lib/retention.ts — the hourly-tick retention entry point.
 *
 * Locks:
 *  1. pruneOldAiRuns issues exactly three deletes (ai_runs, ai_action_log,
 *     tool_runs) with a cutoff of now − 90d and returns the per-table counts.
 *  2. A failing delete does not stop the ones after it, and the single error
 *     surfaced afterwards names the failed table.
 *  3. runRetention reports ONE degraded fault per failing prune (module
 *     'retention', context names the prune) and resolves anyway — a silently
 *     failing prune is the immortal-rows problem the spec names, and a tick
 *     that rejects takes the alert path down with it.
 *  4. A fully successful run reports nothing.
 */

const { deleteMock, whereMock, reportFaultMock, pruneExpiredMock, pruneEventLogsMock } = vi.hoisted(() => ({
  deleteMock: vi.fn(),
  whereMock: vi.fn(),
  reportFaultMock: vi.fn(),
  pruneExpiredMock: vi.fn(),
  pruneEventLogsMock: vi.fn(),
}))

vi.mock('@/lib/db', () => ({ db: { delete: deleteMock } }))
vi.mock('@/lib/agent-memory', () => ({
  pruneExpiredMemories: pruneExpiredMock,
  pruneOldEventLogs: pruneEventLogsMock,
}))
vi.mock('@/lib/tenant-context', () => ({ getTenantId: () => 'rxfit' }))
vi.mock('@/lib/fault-report', () => ({ reportFault: reportFaultMock }))
vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() }),
}))

import { pruneOldAiRuns, runRetention } from './retention'
import { aiActionLog, aiRuns, toolRuns } from './schema'
import type { FaultDraft } from './fault'

const DAY_MS = 24 * 60 * 60 * 1000
const NOW = new Date('2026-09-03T12:00:00Z')

/** Walk a drizzle SQL object's query chunks for the bound Date param. */
function boundDates(node: unknown, out: Date[] = []): Date[] {
  if (node instanceof Date) out.push(node)
  else if (Array.isArray(node)) node.forEach((n) => boundDates(n, out))
  else if (node && typeof node === 'object') {
    const o = node as { queryChunks?: unknown[]; value?: unknown }
    if (o.queryChunks) boundDates(o.queryChunks, out)
    if ('value' in o) boundDates(o.value, out)
  }
  return out
}

/** Order-preserving list of (table, cutoff) for every delete issued. */
function deletesIssued(): Array<{ table: unknown; cutoff: Date | undefined }> {
  return deleteMock.mock.calls.map((c, i) => ({
    table: c[0],
    cutoff: boundDates(whereMock.mock.calls[i]?.[0])[0],
  }))
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(NOW)
  deleteMock.mockReset().mockReturnValue({ where: whereMock })
  whereMock.mockReset().mockResolvedValue({ count: 0 })
  reportFaultMock.mockReset()
  pruneExpiredMock.mockReset().mockResolvedValue(undefined)
  pruneEventLogsMock.mockReset().mockResolvedValue(7)
})

afterEach(() => {
  vi.useRealTimers()
})

describe('pruneOldAiRuns', () => {
  it('issues three deletes — ai_runs, ai_action_log, tool_runs — with a cutoff of now − 90d, and returns the counts', async () => {
    whereMock
      .mockResolvedValueOnce({ count: 3 })
      .mockResolvedValueOnce({ count: 5 })
      .mockResolvedValueOnce({ count: 11 })

    const counts = await pruneOldAiRuns()

    expect(counts).toEqual({ aiRuns: 3, aiActionLog: 5, toolRuns: 11 })
    const issued = deletesIssued()
    expect(issued.map((d) => d.table)).toEqual([aiRuns, aiActionLog, toolRuns])
    for (const d of issued) {
      expect(d.cutoff).toBeInstanceOf(Date)
      expect(Math.abs(d.cutoff!.getTime() - (NOW.getTime() - 90 * DAY_MS))).toBeLessThan(1000)
    }
  })

  it('honours an explicit window', async () => {
    await pruneOldAiRuns(30)
    const [first] = deletesIssued()
    expect(first.cutoff!.getTime()).toBe(NOW.getTime() - 30 * DAY_MS)
  })

  it('a rejecting second delete still runs the third; the surfaced error names the failed table', async () => {
    whereMock
      .mockResolvedValueOnce({ count: 1 })
      .mockRejectedValueOnce(new Error('relation "ai_action_log" does not exist'))
      .mockResolvedValueOnce({ count: 2 })

    const err = await pruneOldAiRuns().catch((e: unknown) => e)

    expect(deleteMock).toHaveBeenCalledTimes(3)
    expect(deletesIssued().map((d) => d.table)).toEqual([aiRuns, aiActionLog, toolRuns])
    expect(err).toBeInstanceOf(Error)
    const e = err as Error & { tables: string[]; errors: unknown[]; cause?: unknown }
    expect(e.name).toBe('RetentionError')
    expect(e.message).toContain('ai_action_log')
    expect(e.message).not.toContain('ai_runs,')
    expect(e.message).not.toContain('tool_runs')
    expect(e.tables).toEqual(['ai_action_log'])
    expect(e.errors).toHaveLength(1)
    expect((e.cause as Error).message).toContain('does not exist')
  })

  it('rethrows once after every table was attempted, even when all three fail', async () => {
    whereMock.mockRejectedValue(new Error('connection refused'))
    const err = (await pruneOldAiRuns().catch((e: unknown) => e)) as Error & { tables: string[] }
    expect(deleteMock).toHaveBeenCalledTimes(3)
    expect(err.tables).toEqual(['ai_runs', 'ai_action_log', 'tool_runs'])
    expect(err.message).toContain('3 of 3')
  })
})

describe('runRetention', () => {
  const drafts = () => reportFaultMock.mock.calls.map((c) => c[0] as FaultDraft)

  it('a fully successful run reports nothing and returns the counts', async () => {
    whereMock
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 2 })
      .mockResolvedValueOnce({ count: 3 })

    const summary = await runRetention()

    expect(pruneExpiredMock).toHaveBeenCalledWith('rxfit')
    expect(pruneEventLogsMock).toHaveBeenCalledWith()
    expect(summary).toEqual({
      expiredMemories: true,
      eventLog: 7,
      aiRuns: { aiRuns: 1, aiActionLog: 2, toolRuns: 3 },
      failed: [],
    })
    expect(reportFaultMock).not.toHaveBeenCalled()
  })

  it('reports ONE degraded fault for a failing prune, names the op, and still runs the rest', async () => {
    pruneEventLogsMock.mockRejectedValue(new Error('deadlock detected'))

    const summary = await runRetention()

    expect(reportFaultMock).toHaveBeenCalledTimes(1)
    const [draft] = drafts()
    expect(draft.module).toBe('retention')
    expect(draft.severity).toBe('degraded')
    expect(draft.layer).toBe('cron')
    // scrubContext keeps only allowlisted keys, and `op` is one of them (added
    // in lib/fault.ts for exactly this attribution) — the record says WHICH
    // prune failed, not merely that one did.
    expect(draft.context).toMatchObject({ op: 'pruneOldEventLogs' })
    expect(draft.context).not.toHaveProperty('kind')
    // The prunes after the failing one still ran.
    expect(deleteMock).toHaveBeenCalledTimes(3)
    expect(summary.failed).toEqual(['pruneOldEventLogs'])
    expect(summary.eventLog).toBeNull()
    expect(summary.aiRuns).toEqual({ aiRuns: 0, aiActionLog: 0, toolRuns: 0 })
  })

  it('reports one fault PER failing prune and never rejects, even when every prune fails', async () => {
    pruneExpiredMock.mockRejectedValue(new Error('memories: boom'))
    pruneEventLogsMock.mockRejectedValue(new Error('event_log: boom'))
    whereMock.mockRejectedValue(new Error('ledgers: boom'))

    await expect(runRetention()).resolves.toMatchObject({
      expiredMemories: false,
      eventLog: null,
      aiRuns: null,
      failed: ['pruneExpiredMemories', 'pruneOldEventLogs', 'pruneOldAiRuns'],
    })

    expect(reportFaultMock).toHaveBeenCalledTimes(3)
    expect(drafts().map((d) => d.context?.op)).toEqual(['pruneExpiredMemories', 'pruneOldEventLogs', 'pruneOldAiRuns'])
    for (const d of drafts()) {
      expect(d.module).toBe('retention')
      expect(d.severity).toBe('degraded')
      expect(d.layer).toBe('cron')
    }
    // The ai-ledger fault carries which table failed, so the digest says
    // which ledger is regrowing.
    expect(drafts()[2].message).toContain('ai_runs')
  })

  it('a reporter that throws cannot make the tick reject', async () => {
    pruneEventLogsMock.mockRejectedValue(new Error('boom'))
    reportFaultMock.mockImplementation(() => {
      throw new Error('reporter broken')
    })
    // reportFault's contract is "never throws"; the tick guards against the
    // worst case regardless — the log line already carries the failure.
    await expect(runRetention()).resolves.toMatchObject({ failed: ['pruneOldEventLogs'] })
  })
})
