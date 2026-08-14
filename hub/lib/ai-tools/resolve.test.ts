import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

/* ── resolveReadTools — the manifest plumbing and the bounded-DB contract ──
   Audit findings pinned here:
   - the capability manifest is built even when the planner proposes NO calls
     (those are exactly the turns where the model used to deny the capability);
   - a hanging DB read resolves at the PREFS_TIMEOUT_MS bound with
     prefsKnown:false instead of stalling the turn;
   - a FAILED store read renders as "config state unknown", never as
     "NOT configured" (getEffectivePrefsDetailed.storeReadFailed drives it). */

const hoisted = vi.hoisted(() => ({
  planCalls: [] as { name: string; args: unknown }[],
  prefsBehavior: null as null | (() => Promise<{ prefs: Record<string, unknown>; storeReadFailed: boolean }>),
  executeOutcomes: [] as unknown[],
}))

vi.mock('./plan', () => ({
  planToolCalls: async () => hoisted.planCalls,
}))
vi.mock('./execute', async importOriginal => ({
  ...(await importOriginal<typeof import('./execute')>()),
  executeToolCalls: async () => hoisted.executeOutcomes,
}))
vi.mock('../google/prefs-db', () => ({
  getEffectivePrefsDetailed: () => {
    if (!hoisted.prefsBehavior) throw new Error('prefsBehavior not set')
    return hoisted.prefsBehavior()
  },
}))
vi.mock('next-auth', () => ({ getServerSession: async () => ({ user: { email: 'staff@x.test' } }) }))
vi.mock('../auth', () => ({ authOptions: {} }))
vi.mock('../chat-space-preferences-db', () => ({
  getChatSpacePreferences: async () => ({ hiddenSpaces: [], pinnedSpaces: [] }),
}))

import { resolveReadTools, PREFS_TIMEOUT_MS } from './resolve'

beforeEach(() => {
  hoisted.planCalls = []
  hoisted.prefsBehavior = () =>
    Promise.resolve({ prefs: { ga4PropertyId: '555' }, storeReadFailed: false })
  hoisted.executeOutcomes = []
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})
afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('resolveReadTools — capability manifest', () => {
  it('returns the manifest even when the planner proposes no calls', async () => {
    const result = await resolveReadTools('what can you tell me about traffic?', 'staff', 'tok')
    expect(result.ran).toEqual([])
    expect(result.context).toBeUndefined()
    expect(result.manifest).toContain('ga4_run_report')
    expect(result.manifest).toContain('CONFIGURED — GA4 property 555')
  })

  it('renders config state as unknown when the store read failed — never "NOT configured"', async () => {
    hoisted.prefsBehavior = () => Promise.resolve({ prefs: {}, storeReadFailed: true })
    const result = await resolveReadTools('traffic?', 'staff', 'tok')
    expect(result.manifest).toBeDefined()
    expect(result.manifest).not.toContain('[CONFIGURED')
    expect(result.manifest).not.toContain('[NOT configured')
  })

  it('carries both context and manifest when calls execute', async () => {
    hoisted.planCalls = [{ name: 'ga4_run_report', args: {} }]
    hoisted.executeOutcomes = [
      { name: 'ga4_run_report', ok: true, result: { summary: 's', fenced: 'payload' } },
    ]
    const result = await resolveReadTools('sessions last week?', 'staff', 'tok')
    expect(result.context).toContain('LIVE DATA RETRIEVED THIS TURN')
    expect(result.manifest).toContain('ga4_run_report')
    expect(result.ran).toEqual(['ga4_run_report'])
  })

  it('returns nothing without a Google session (no manifest to wrongly promise)', async () => {
    const result = await resolveReadTools('traffic?', 'staff', undefined)
    expect(result).toEqual({ ran: [] })
  })
})

describe('resolveReadTools — bounded DB reads (a hang degrades, never stalls)', () => {
  it('resolves at the PREFS_TIMEOUT_MS bound with prefsKnown:false when the prefs read hangs', async () => {
    vi.useFakeTimers()
    // A saturated pool / hanging connection: the promise never settles.
    hoisted.prefsBehavior = () => new Promise(() => {})

    const pending = resolveReadTools('how did traffic do?', 'staff', 'tok')
    await vi.advanceTimersByTimeAsync(PREFS_TIMEOUT_MS + 100)
    const result = await pending

    // The turn completed, with the manifest present but claiming no config state.
    expect(result.manifest).toContain('ga4_run_report')
    expect(result.manifest).not.toContain('[CONFIGURED')
    expect(result.manifest).not.toContain('[NOT configured')
  })
})
