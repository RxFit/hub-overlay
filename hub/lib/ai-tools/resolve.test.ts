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
  /** Overrides planCalls when set — lets a test make planning THROW. */
  planBehavior: null as null | (() => never),
  prefsBehavior: null as null | (() => Promise<{ prefs: Record<string, unknown>; storeReadFailed: boolean }>),
  executeOutcomes: [] as unknown[],
}))

vi.mock('./plan', () => ({
  planToolCalls: async () => {
    if (hoisted.planBehavior) hoisted.planBehavior()
    return hoisted.planCalls
  },
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
  hoisted.planBehavior = null
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

  /* T-70: the four states where the manifest used to vanish are exactly the
     states where the model is most likely to deny the capability. Each one now
     ships the manifest WITH the reason nothing ran. */

  it('still ships the manifest without a Google session, naming the reason', async () => {
    const result = await resolveReadTools('traffic?', 'staff', undefined)
    expect(result.ran).toEqual([])
    expect(result.context).toBeUndefined()
    expect(result.manifest).toContain('ga4_run_report')
    expect(result.manifest).toContain("Google session could not be resolved")
    expect(result.manifest).toContain('Do NOT say the capability does not exist')
  })

  it('still ships the manifest for a role with no eligible tool (the onboarding default)', async () => {
    const result = await resolveReadTools('traffic?', 'onboarding', 'tok')
    expect(result.ran).toEqual([])
    // Listed with the role bar, not hidden: "it can, your role can't yet".
    expect(result.manifest).toContain('ga4_run_report')
    expect(result.manifest).toContain('[requires staff access]')
    expect(result.manifest).toContain('NEVER tell the user the Hub cannot do these things')
  })

  it('still ships the manifest when resolution itself throws', async () => {
    hoisted.planBehavior = () => {
      throw new Error('planner exploded')
    }
    const result = await resolveReadTools('traffic?', 'staff', 'tok')
    expect(result.ran).toEqual([])
    expect(result.manifest).toContain('ga4_run_report')
    expect(result.manifest).toContain('the retrieval step itself failed')
    expect(result.manifest).toContain('Do NOT deny the capability')
  })

  it('does not tell the user to rephrase when nothing could have run', async () => {
    // The rephrase hint is good advice on a turn where a lookup was possible
    // and none triggered. On a no-session turn it loops the user against a
    // lookup that is off for an unrelated reason.
    const result = await resolveReadTools('traffic?', 'staff', undefined)
    expect(result.manifest).not.toContain('restate the question with a concrete metric')
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
