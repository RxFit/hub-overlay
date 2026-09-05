import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * lib/needs-you — the "Needs you" queue (Phase 4 PR 2). Locks:
 *  - the pure builders per source (kind, key, retry affordance, redaction),
 *  - assembly: dedup of a run row that belongs to a listed deep run,
 *    dismissed keys removed + counted, newest first,
 *  - the reader's scoping (admin planes never read for staff) and fail-open.
 */

const { runsMock, actionsMock, toolRunsMock, alertsMock, dismissedMock } = vi.hoisted(() => ({
  runsMock: vi.fn(),
  actionsMock: vi.fn(),
  toolRunsMock: vi.fn(),
  alertsMock: vi.fn(),
  dismissedMock: vi.fn(),
}))

vi.mock('./logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}))
vi.mock('./runs', () => ({ listAiRunsSince: runsMock }))
vi.mock('./ai-audit', () => ({ listAiActions: actionsMock }))
vi.mock('./tool-runs', () => ({ listToolRuns: toolRunsMock, ACTIVE_WINDOW_MS: 60 * 60_000 }))
vi.mock('./dispatch-alerts', () => ({ listDispatchAlerts: alertsMock }))
vi.mock('./queue-dismissals', () => ({ listDismissedKeys: dismissedMock }))
vi.mock('./tenant-context', () => ({ getTenantId: () => 'rxfit' }))

import {
  runToNeedsYou,
  actionToNeedsYou,
  actionRetryPrompt,
  toolRunToNeedsYou,
  alertToNeedsYou,
  assembleQueue,
  readNeedsYou,
} from './needs-you'
import type { AiRunRecord } from './runs'
import type { AiActionRecord } from './ai-audit'
import type { ToolRunRecord } from './tool-runs'

const NOW = Date.parse('2026-09-05T15:00:00Z')
const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString()

function run(over: Partial<AiRunRecord> = {}): AiRunRecord {
  return {
    id: '89378f4f-0000-4000-8000-000000000001', createdAt: iso(60_000), engine: 'agy', model: null,
    source: 'chat', status: 'error', errorClass: 'timeout', error: 'tail: leak', latencyMs: 60_000,
    inputTokens: null, outputTokens: null, cacheReadTokens: null, totalTokens: null, promptChars: null,
    promptSha256: null, requestId: null, userEmail: null, meta: null, ...over,
  }
}
function action(over: Partial<AiActionRecord> = {}): AiActionRecord {
  return {
    id: 'a1', createdAt: iso(120_000), userEmail: 'd@x', actor: 'ai', actionType: 'gmail_send',
    target: { to: 'client@example.com' }, intent: 'send_email', gateTokenId: null, requestId: null,
    status: 'failed', error: 'rate_limited', ...over,
  }
}
function toolRun(over: Partial<ToolRunRecord> = {}): ToolRunRecord {
  return {
    id: 't1', tool: 'deep-research', status: 'failed', brief: 'Why did churn rise in August?', resultMd: null,
    errorClass: 'timeout', error: null, userEmail: 'd@x', chatId: null, jobId: null, attempt: 1, model: null,
    latencyMs: null, usage: null, createdAt: iso(3_600_000), finishedAt: iso(1_800_000), retryOf: null, ...over,
  }
}

beforeEach(() => {
  runsMock.mockReset(); actionsMock.mockReset(); toolRunsMock.mockReset(); alertsMock.mockReset(); dismissedMock.mockReset()
})

describe('builders', () => {
  it('a failed model run is a review with a record and NO retry, carrying the class but never the message', () => {
    const item = runToNeedsYou(run())!
    expect(item).toMatchObject({ key: 'run:89378f4f-0000-4000-8000-000000000001', kind: 'review', source: 'ai_run', retry: null })
    expect(item.title).toBe('Run 89378f4f failed (timeout)')
    expect(item.record).toEqual({ recordKind: 'ai_run', recordId: run().id })
    expect(JSON.stringify(item)).not.toContain('leak')
    expect(runToNeedsYou(run({ status: 'ok' }))).toBeNull()
  })

  it('a failed action is a review worded like its feed card, with a clamped reason and an execute-style retry', () => {
    const item = actionToNeedsYou(action({ error: 'x'.repeat(300) }))!
    expect(item.title).toBe('AI email to client@example.com failed')
    expect(item.description.length).toBeLessThan(200)
    expect(item.retry).toEqual({ mode: 'action', prompt: 'Send an email to client@example.com' })
    expect(actionToNeedsYou(action({ status: 'success' }))).toBeNull()
  })

  it('retry prompts name the target the audit row kept, and unknown action types get no retry', () => {
    expect(actionRetryPrompt(action({ actionType: 'chat_post', target: { space: 'spaces/ops' } }))).toBe('Post a message in spaces/ops')
    expect(actionRetryPrompt(action({ actionType: 'task_create', target: { title: 'Call Maria' } }))).toBe('Create a task: Call Maria')
    expect(actionRetryPrompt(action({ actionType: 'gmail_send', target: null }))).toBe('Send an email')
    expect(actionRetryPrompt(action({ actionType: 'gmail_focus' }))).toBeNull()
    expect(actionToNeedsYou(action({ actionType: 'gmail_focus' }))!.retry).toBeNull()
  })

  it('a failed deep run is a review with a deep_run retry; an orphaned queued one is a question; a live one is nothing', () => {
    const failed = toolRunToNeedsYou(toolRun(), NOW)!
    expect(failed).toMatchObject({ key: 'deep:t1', kind: 'review', retry: { mode: 'deep_run', runId: 't1', tool: 'deep-research' } })
    expect(failed.title).toBe('Deep Research failed (timeout)')
    expect(failed.createdAt).toBe(iso(1_800_000)) // finishedAt wins for ordering

    const orphan = toolRunToNeedsYou(toolRun({ status: 'queued', errorClass: null, finishedAt: null, createdAt: iso(3 * 3_600_000) }), NOW)!
    expect(orphan.kind).toBe('question')
    expect(orphan.title).toBe('Deep Research looks stuck (queued 3h)')

    expect(toolRunToNeedsYou(toolRun({ status: 'queued', createdAt: iso(60_000), finishedAt: null }), NOW)).toBeNull()
    expect(toolRunToNeedsYou(toolRun({ status: 'succeeded' }), NOW)).toBeNull()
  })

  it('a delivered dispatch alert is an FYI with plain-English kinds; a recovery row is skipped', () => {
    const item = alertToNeedsYou({ id: 'e1', createdAt: new Date(NOW), kinds: ['worker_stale', 'agy_error_streak'], channel: 'chat' })!
    expect(item).toMatchObject({ key: 'alert:e1', kind: 'notify', record: { recordKind: 'dispatch_alert', recordId: 'e1' }, retry: null })
    expect(item.title).toBe('Dispatch alert: desktop worker offline, agy failing repeatedly')
    expect(item.description).toBe('delivered via chat')
    expect(alertToNeedsYou({ id: 'e2', createdAt: new Date(NOW), kinds: [], channel: 'chat' })).toBeNull()
  })
})

describe('assembleQueue', () => {
  it('drops the ai_run row that belongs to a listed deep run, hides dismissed keys, and orders newest first', () => {
    const linkedRun = run({ id: 'rr', source: 'tool', meta: { toolRunId: 't1' }, createdAt: iso(10_000) })
    const { items, dismissedCount } = assembleQueue(
      {
        runs: [run(), linkedRun],
        actions: [action(), action({ id: 'a2', createdAt: iso(5_000) })],
        toolRuns: [toolRun()],
        alerts: [{ id: 'e1', createdAt: new Date(NOW - 30_000), kinds: ['worker_stale'], channel: 'chat' }],
      },
      new Set(['action:a1']),
      NOW,
    )
    expect(items.map((i) => i.key)).toEqual(['action:a2', 'alert:e1', 'run:89378f4f-0000-4000-8000-000000000001', 'deep:t1'])
    expect(items.map((i) => i.key)).not.toContain('run:rr')
    expect(dismissedCount).toBe(1)
  })
})

describe('readNeedsYou', () => {
  it('reads every source for an admin and filters dismissed keys', async () => {
    runsMock.mockResolvedValue([run()])
    actionsMock.mockResolvedValue([action()])
    toolRunsMock.mockResolvedValue([toolRun()])
    alertsMock.mockResolvedValue([])
    dismissedMock.mockResolvedValue(new Set(['deep:t1']))
    const q = await readNeedsYou({ userEmail: 'danny@rxfitatx.com', isAdmin: true, now: NOW })
    expect(q.items.map((i) => i.key)).toEqual(['run:89378f4f-0000-4000-8000-000000000001', 'action:a1'])
    expect(q.dismissedCount).toBe(1)
    expect(q.notices).toEqual([])
    expect(runsMock).toHaveBeenCalledWith(new Date(NOW - 24 * 3_600_000), 2_000)
    expect(alertsMock).toHaveBeenCalledWith('rxfit', new Date(NOW - 24 * 3_600_000), 10)
  })

  it('never reads the admin planes for staff', async () => {
    actionsMock.mockResolvedValue([])
    toolRunsMock.mockResolvedValue([])
    dismissedMock.mockResolvedValue(new Set())
    const q = await readNeedsYou({ userEmail: 'staff@rxfitatx.com', isAdmin: false, now: NOW })
    expect(q.items).toEqual([])
    expect(runsMock).not.toHaveBeenCalled()
    expect(alertsMock).not.toHaveBeenCalled()
  })

  it('fails open per source: a thrown reader becomes a notice, the rest still render', async () => {
    runsMock.mockRejectedValue(new Error('db down'))
    actionsMock.mockResolvedValue([action()])
    toolRunsMock.mockRejectedValue(new Error('nope'))
    alertsMock.mockResolvedValue([])
    dismissedMock.mockRejectedValue(new Error('nope'))
    const q = await readNeedsYou({ userEmail: 'danny@rxfitatx.com', isAdmin: true, now: NOW })
    expect(q.items.map((i) => i.key)).toEqual(['action:a1'])
    expect(q.notices).toEqual(['runs ledger unreadable', 'deep-run ledger unreadable', 'dismissals unreadable'])
  })

  it('ignores deep runs older than a week (a failure from July is not "needs you")', async () => {
    runsMock.mockResolvedValue([]); alertsMock.mockResolvedValue([]); dismissedMock.mockResolvedValue(new Set())
    actionsMock.mockResolvedValue([])
    toolRunsMock.mockResolvedValue([toolRun({ createdAt: iso(10 * 24 * 3_600_000), finishedAt: iso(9 * 24 * 3_600_000) })])
    const q = await readNeedsYou({ userEmail: 'd@x', isAdmin: true, now: NOW })
    expect(q.items).toEqual([])
  })
})
