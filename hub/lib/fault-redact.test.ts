import { describe, it, expect } from 'vitest'
import { scrubFreeText, scrubContext, toFault } from './fault'

/* ════════════════════════════════════════════════════════════════════════════
   The free-text redaction pass (ERROR_REPORTING_2026-08-24.md §7) — the
   property the whole record depends on: no code path can construct a
   FaultRecord with unscrubbed text, verified over REAL error shapes rather
   than hand-written fixtures (the spec's §7.1 requirement — a fixture test
   passes while production leaks).
   ════════════════════════════════════════════════════════════════════════════ */

const CTX = { layer: 'route' as const, route: '/api/google/gmail', method: 'POST' }

describe('scrubFreeText — the spec §7.1 property cases', () => {
  it('a google-session style delegation error loses the raw email', () => {
    const out = scrubFreeText('Delegation denied for danny@rxfitatx.com')
    expect(out).not.toContain('@')
    expect(out).not.toContain('danny')
    expect(out).not.toContain('rxfitatx')
  })

  it('a Postgres connection string loses its credentials AND its @', () => {
    const out = scrubFreeText('connect failed: postgres://hubuser:hunter2@db.internal:5432/hub')
    expect(out).not.toContain('hunter2')
    expect(out).not.toContain('@')
    expect(out).toContain('<credentials>')
  })

  it('bearer / JWT / provider-key shapes all tokenize', () => {
    const out = scrubFreeText(
      'Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjMifQ.abc ' +
        'key sk-proj-AbCdEf12345678 gkey AIzaSyD4Xyz1234567890',
    )
    expect(out).not.toContain('eyJ')
    expect(out).not.toContain('sk-proj')
    expect(out).not.toContain('AIzaSy')
    expect(out).toContain('<token>')
  })

  it('a stack frame with a query-string token loses the query string', () => {
    const out = scrubFreeText('at load (/app/.next/static/chunk.js?token=abc123def456)')
    expect(out).not.toContain('token=abc123def456')
    expect(out).toContain('chunk.js')
  })

  it('IPs tokenize; idempotent on already-scrubbed text', () => {
    const once = scrubFreeText('refused from 10.128.0.7')
    expect(once).toContain('<ip>')
    expect(scrubFreeText(once)).toBe(once)
  })
})

describe('the record itself is scrubbed end-to-end (no path around the pass)', () => {
  it('message, stack and causeChain of a hostile error come out clean', () => {
    const root = Object.assign(
      new Error('auth header was: Bearer eyJhbGciOiJIUzI1NiJ9.payload.sig'),
      { code: 'ECONNRESET' },
    )
    const err = new Error(
      'Delegation denied for danny@rxfitatx.com via postgres://u:pw@10.0.0.5/hub',
      { cause: root },
    )
    err.stack = [
      'Error: Delegation denied for danny@rxfitatx.com',
      '    at sendMail (/app/hub/lib/google/gmail.ts:311:9)',
      '    at handler (/app/hub/app/api/google/gmail/route.ts:42:5)',
    ].join('\n')

    const fault = toFault(err, CTX)
    const serialized = JSON.stringify(fault)
    // No EMAIL-shaped '@' anywhere (frames legitimately carry fn@file — the
    // spec's own frame format — so a blanket no-'@' assertion would be wrong).
    expect(serialized).not.toMatch(/[\w.+-]+@[\w-]+\.[\w.-]+/)
    expect(serialized).not.toContain('danny')
    expect(serialized).not.toContain('rxfitatx')
    expect(serialized).not.toContain('eyJ')
    expect(serialized).not.toContain('Bearer ')
    expect(serialized).not.toContain(':pw')
    // and the useful shape survives redaction
    expect(fault.stack).toContain('sendMail@')
    expect(fault.stack).toContain('lib/google/gmail.ts')
    expect(fault.stack).not.toMatch(/:\d+:\d+/) // line numbers stripped from the record's stack
    expect(fault.causeChain[0].name).toBe('Error')
  })
})

describe('scrubContext — allowlist-first, deny-by-default', () => {
  it('keeps only allowlisted scalar keys and drops everything else silently', () => {
    const out = scrubContext({
      provider: 'gmail',
      attempt: 3,
      ok: true, // not allowlisted
      password: 'hunter2', // dropped by allowlist, not by name-matching
      body: { secret: 'x' }, // non-scalar AND not allowlisted
      model: 'gemini-2.5-flash',
    })
    expect(out).toEqual({ provider: 'gmail', attempt: 3, model: 'gemini-2.5-flash' })
  })

  it('caps at 10 keys and 200 chars per value, and scrubs string values', () => {
    const out = scrubContext({ provider: `x`.repeat(500), model: 'a@b.co' })
    expect((out?.provider as string).length).toBeLessThanOrEqual(200)
    expect(JSON.stringify(out)).not.toContain('@')
  })

  it('returns null when nothing survives', () => {
    expect(scrubContext({ nope: 'x' })).toBeNull()
    expect(scrubContext(null)).toBeNull()
  })
})
