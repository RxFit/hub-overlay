import { describe, it, expect, vi } from 'vitest'
import {
  clearlyDiffers,
  crossReferenceLive,
  describeLiveEvidenceForLog,
  filterLiveHits,
  liveLaneWarning,
  possibleConflictWarning,
  resolveLiveLane,
  runLiveLane,
  TENANT_MISMATCH_DETAIL,
  type LiveEvidence,
} from './live-evidence'
import { createScopeMatcher } from './config'
import { VaultUnavailableError } from './errors'
import type { VaultSearchHit } from './search'
import type { LiveVaultHit, SmartConnectionsClient } from './smart-connections'
import { FAKE_MCP_KEY, FAKE_MCP_URL } from '../../test/vault-fake-mcp'

/* ════════════════════════════════════════════════════════════════════════════
   Lane 2 orchestration — status mapping, the two deadlines, scope + prefix
   filtering, tenant binding, and the cross-reference warnings. Canonical hits
   are read and never written. No fetch anywhere: the client is a stub.
   ════════════════════════════════════════════════════════════════════════════ */

const scope = createScopeMatcher({ include: ['Projects/**', 'Daily/**'], exclude: ['Private/**'] })

function liveHit(vaultPath: string, excerpt = '', extra: Partial<LiveVaultHit> = {}): LiveVaultHit {
  return {
    vaultPath,
    noteTitle: vaultPath.split('/').pop()!.replace(/\.md$/, ''),
    headingPath: null,
    charStart: null,
    charEnd: null,
    excerpt,
    similarity: null,
    contentSha: null,
    indexedCommitSha: null,
    sourceModifiedAt: null,
    indexedAt: null,
    source: 'smart_connections_live',
    live: true,
    ...extra,
  }
}

function canonicalHit(vaultPath: string, excerpt: string): VaultSearchHit {
  return { vaultPath, noteTitle: vaultPath, headingPath: 'H', charStart: 0, charEnd: excerpt.length, excerpt, similarity: 0.9, contentSha: 'sha', indexedCommitSha: 'commit-1', sourceModifiedAt: null, indexedAt: '2026-09-22T00:00:00.000Z' }
}

function stubClient(search: SmartConnectionsClient['search'], timeoutMs = 4_000): SmartConnectionsClient {
  return { host: 'desktop.example.test', timeoutMs, configuredTool: 'search_notes', search, probe: async () => ({ reachable: true, latencyMs: 1, detail: 'stub' }) }
}

const okClient = (hits: LiveVaultHit[], unmapped = 0) => stubClient(async () => ({ hits, tool: 'search_notes', unmapped }))

/** A search that honours its signal but never answers on its own (desktop asleep). */
const hangingClient = (timeoutMs: number, seen: AbortSignal[]) =>
  stubClient((_q, opts) => new Promise((_, reject) => {
    if (opts.signal) seen.push(opts.signal)
    opts.signal?.addEventListener('abort', () => reject(new VaultUnavailableError('smart_connections', 'timeout', 'aborted by the caller')), { once: true })
  }), timeoutMs)

const far = () => Date.now() + 60_000

describe('runLiveLane — always resolves', () => {
  it('disabled when there is no client, with the reason the resolver gave, and no latency spent', async () => {
    const e = await runLiveLane({ query: 'q', topK: 5, deadlineAt: far() }, { client: null, disabledDetail: 'SMART_CONNECTIONS_URL is not set', scope })
    expect(e).toEqual({ status: 'disabled', latencyMs: 0, hits: [], reason: 'unconfigured', detail: 'SMART_CONNECTIONS_URL is not set', dropped: 0 })
  })

  it('ok: hits pass through the canonical scope, the pathPrefix and topK; everything else is dropped and counted', async () => {
    const hits = [
      liveHit('Projects/A.md', 'a'),
      liveHit('Private/Secrets.md', 'never'),
      liveHit('Daily/2026-09-22.md', 'd'),
      liveHit('Projects/B.md', 'b'),
      liveHit('Projects/diagram.png', 'not a note'),
      liveHit('Projects/C.md', 'c'),
    ]
    const e = await runLiveLane({ query: 'q', topK: 2, pathPrefix: 'Projects/', deadlineAt: far() }, { client: okClient(hits, 3), scope })
    expect(e.status).toBe('ok')
    expect(e.reason).toBeNull()
    expect(e.detail).toBeNull()
    expect(e.hits.map((h) => h.vaultPath)).toEqual(['Projects/A.md', 'Projects/B.md'])
    // Private (scope), Daily (prefix), png (not a note), C (beyond topK) + 3 unmapped by the client.
    expect(e.dropped).toBe(4 + 3)
    expect(e.latencyMs).toBeGreaterThanOrEqual(0)
    expect(filterLiveHits(hits, scope, undefined, 20)).toMatchObject({ dropped: 2 })
  })

  it('timeout by the lane’s own budget when the request deadline is far away: the call is aborted', async () => {
    const seen: AbortSignal[] = []
    const e = await runLiveLane({ query: 'q', topK: 5, deadlineAt: far() }, { client: hangingClient(40, seen), scope })
    expect(e.status).toBe('timeout')
    expect(e.reason).toBe('timeout')
    expect(e.detail).toContain('live timeout (40ms) expired')
    expect(e.hits).toEqual([])
    expect(seen[0].aborted).toBe(true)
  })

  it('timeout by the request deadline when maxLatencyMs is tighter than the lane budget', async () => {
    const seen: AbortSignal[] = []
    const t0 = Date.now()
    const e = await runLiveLane({ query: 'q', topK: 5, deadlineAt: Date.now() + 30 }, { client: hangingClient(4_000, seen), scope })
    expect(e.status).toBe('timeout')
    expect(e.detail).toMatch(/request maxLatencyMs deadline \(\d+ms remaining\) expired/)
    expect(Date.now() - t0).toBeLessThan(2_000)
    expect(seen[0].aborted).toBe(true)
  })

  it('an already-expired deadline is a timeout without calling the client', async () => {
    const search = vi.fn()
    const e = await runLiveLane({ query: 'q', topK: 5, deadlineAt: Date.now() - 1 }, { client: stubClient(search as unknown as SmartConnectionsClient['search']), scope })
    expect(e).toMatchObject({ status: 'timeout', reason: 'timeout', detail: expect.stringContaining('already expired') })
    expect(search).not.toHaveBeenCalled()
  })

  it('maps client failures: auth/network/http/protocol/breaker_open → unavailable; timeout → timeout; unconfigured → disabled; anything else → internal', async () => {
    const reasons = ['auth', 'network', 'http', 'protocol', 'breaker_open'] as const
    for (const reason of reasons) {
      const e = await runLiveLane({ query: 'q', topK: 5, deadlineAt: far() }, { client: stubClient(async () => { throw new VaultUnavailableError('smart_connections', reason, `simulated ${reason}`) }), scope })
      expect(e).toMatchObject({ status: 'unavailable', reason, detail: `simulated ${reason}`, hits: [] })
    }
    const t = await runLiveLane({ query: 'q', topK: 5, deadlineAt: far() }, { client: stubClient(async () => { throw new VaultUnavailableError('smart_connections', 'timeout', 'slow') }), scope })
    expect(t).toMatchObject({ status: 'timeout', reason: 'timeout', detail: 'live call abandoned: live timeout (4000ms) expired' })
    const u = await runLiveLane({ query: 'q', topK: 5, deadlineAt: far() }, { client: stubClient(async () => { throw new VaultUnavailableError('smart_connections', 'unconfigured', 'nope') }), scope })
    expect(u).toMatchObject({ status: 'disabled', reason: 'unconfigured' })
    const x = await runLiveLane({ query: 'q', topK: 5, deadlineAt: far() }, { client: stubClient(async () => { throw new Error('kaboom') }), scope })
    expect(x).toMatchObject({ status: 'unavailable', reason: 'internal', detail: 'live search failed: kaboom' })
  })

  it('warnings name the outcome and always say the canonical hits are unaffected', () => {
    const base: LiveEvidence = { status: 'ok', latencyMs: 1, hits: [], reason: null, detail: null, dropped: 0 }
    expect(liveLaneWarning(base)).toBeNull()
    expect(liveLaneWarning({ ...base, status: 'disabled', reason: 'unconfigured', detail: 'SMART_CONNECTIONS_URL is not set' })).toBe('live evidence disabled: SMART_CONNECTIONS_URL is not set; canonical snapshot hits are unaffected')
    expect(liveLaneWarning({ ...base, status: 'timeout', reason: 'timeout', detail: 'live call abandoned: live timeout (4000ms) expired' })).toContain('live evidence timed out: live call abandoned')
    expect(liveLaneWarning({ ...base, status: 'unavailable', reason: 'auth', detail: 'HTTP 401' })).toBe('live evidence unavailable (auth): HTTP 401; canonical snapshot hits are unaffected')
  })
})

describe('resolveLiveLane — configured AND the Hub’s own tenant', () => {
  const env = { SMART_CONNECTIONS_URL: FAKE_MCP_URL, SMART_CONNECTIONS_API_KEY: FAKE_MCP_KEY }

  it('is disabled when unconfigured, disabled for a foreign tenant, and a client for the Hub tenant', () => {
    expect(resolveLiveLane({ env: {}, principalTenantId: 'rxfit', serverTenantId: 'rxfit' })).toEqual({ client: null, disabledDetail: 'SMART_CONNECTIONS_URL and SMART_CONNECTIONS_API_KEY are not set' })
    expect(resolveLiveLane({ env, principalTenantId: 'other-tenant', serverTenantId: 'rxfit' })).toEqual({ client: null, disabledDetail: TENANT_MISMATCH_DETAIL })
    const lane = resolveLiveLane({ env, principalTenantId: 'rxfit', serverTenantId: 'rxfit' })
    expect(lane.client?.host).toBe('desktop.example.test')
    expect(lane.disabledDetail).toBeUndefined()
  })
})

describe('crossReferenceLive — warnings only, canonical never touched', () => {
  const canonical = [
    canonicalHit('Projects/Hub Overlay.md', 'The deploy pipeline is gated by typecheck, unit tests and Playwright before Cloud Run.'),
    canonicalHit('Projects/Roadmap.md', 'Q4 roadmap: vault search lanes, then the assistant panel.'),
  ]

  it('no shared paths → no warnings; shared path with the same text → live_confirms only', () => {
    expect(crossReferenceLive(canonical, [liveHit('Daily/2026-09-22.md', 'standup')])).toEqual([])
    expect(crossReferenceLive(canonical, [liveHit('Projects/Hub Overlay.md', 'The deploy pipeline is gated by typecheck, unit tests and Playwright before Cloud Run.')])).toEqual(['live_confirms:Projects/Hub Overlay.md'])
    // A live block that is a sub-span of the indexed chunk (or vice versa) agrees.
    expect(crossReferenceLive(canonical, [liveHit('Projects/Hub Overlay.md', 'gated by typecheck, unit tests and Playwright')])).toEqual(['live_confirms:Projects/Hub Overlay.md'])
    expect(crossReferenceLive(canonical, [liveHit('Projects/Roadmap.md', '')])).toEqual(['live_confirms:Projects/Roadmap.md'])
  })

  it('shared path with clearly different text → live_confirms AND possible_conflict pointing at the snapshot', () => {
    const warnings = crossReferenceLive(canonical, [liveHit('Projects/Hub Overlay.md', 'Deploys now go through Cloudflare Workers with a manual approval step and canary traffic.')])
    expect(warnings).toEqual(['live_confirms:Projects/Hub Overlay.md', possibleConflictWarning('Projects/Hub Overlay.md')])
    expect(warnings[1]).toContain('possible_conflict:Projects/Hub Overlay.md')
    expect(warnings[1]).toContain('canonical snapshot remains authoritative until the next sync')
  })

  it('is ordered by the canonical hits, one confirm per path even with several live blocks, and mutates nothing', () => {
    const live = [
      liveHit('Projects/Roadmap.md', 'Q4 roadmap: vault search lanes, then the assistant panel.'),
      liveHit('Projects/Hub Overlay.md', 'gated by typecheck'),
      liveHit('Projects/Hub Overlay.md', 'A completely different paragraph about kitchen renovations and paint colours for the living room.'),
    ]
    const canonicalBefore = JSON.stringify(canonical)
    const liveBefore = JSON.stringify(live)
    expect(crossReferenceLive(canonical, live)).toEqual([
      'live_confirms:Projects/Hub Overlay.md',
      possibleConflictWarning('Projects/Hub Overlay.md'),
      'live_confirms:Projects/Roadmap.md',
    ])
    expect(JSON.stringify(canonical)).toBe(canonicalBefore)
    expect(JSON.stringify(live)).toBe(liveBefore)
    expect(crossReferenceLive([], live)).toEqual([])
    expect(crossReferenceLive(canonical, [])).toEqual([])
  })

  it('clearlyDiffers: cannot judge empties or tiny texts; containment agrees; low token overlap differs', () => {
    expect(clearlyDiffers('', ['anything'])).toBe(false)
    expect(clearlyDiffers('anything', [''])).toBe(false)
    expect(clearlyDiffers('short new text', ['long indexed text about something else entirely'])).toBe(false) // < 6 tokens
    expect(clearlyDiffers('Deploy   pipeline', ['the DEPLOY pipeline is gated'])).toBe(false)
    expect(clearlyDiffers('alpha beta gamma delta epsilon zeta eta', ['alpha beta gamma delta epsilon zeta theta'])).toBe(false) // 6/7 shared
    expect(clearlyDiffers('kitchen renovation paint colours living room budget', ['deploy pipeline gated typecheck playwright cloud run'])).toBe(true)
  })

  it('the log summary carries counts and classes only', () => {
    const e: LiveEvidence = { status: 'ok', latencyMs: 12, hits: [liveHit('Projects/A.md', 'SECRET NOTE TEXT')], reason: null, detail: null, dropped: 2 }
    const line = describeLiveEvidenceForLog(e, 'desktop.example.test')
    expect(line).toEqual({ status: 'ok', reason: null, latencyMs: 12, hits: 1, dropped: 2, host: 'desktop.example.test' })
    expect(JSON.stringify(line)).not.toContain('SECRET')
    expect(JSON.stringify(line)).not.toContain('Projects/A.md')
  })
})
