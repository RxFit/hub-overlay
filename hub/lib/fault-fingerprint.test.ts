import { describe, it, expect } from 'vitest'
import { fingerprintFault, normalizeMessage, inAppFrames } from './fault-fingerprint'
import { matchFingerprintRule, type FingerprintRule } from './fault-fingerprint-rules'

/* ════════════════════════════════════════════════════════════════════════════
   Fingerprinting (ERROR_REPORTING_2026-08-24.md §5) — the stability
   properties that decide whether grouping means anything: line-number churn
   invariance, release invariance, ordered normalization, discriminator
   preservation, route splitting, and the per-rung strategy report.
   ════════════════════════════════════════════════════════════════════════════ */

const BASE = { code: 'internal', layer: 'route', route: '/api/probe', errName: 'TypeError' }

const STACK_A = [
  'TypeError: x is not a function',
  '    at doWork (/app/hub/lib/kpi-engine.ts:47:11)',
  '    at handler (/app/hub/app/api/kpis/route.ts:12:3)',
  '    at process.processTicksAndRejections (node:internal/process/task_queues:95:5)',
].join('\n')

// The same bug after an unrelated edit above it — every line number shifted.
const STACK_B = STACK_A.replace(':47:11', ':52:11').replace(':12:3', ':17:3')

describe('stability properties', () => {
  it('line-number churn does NOT change the fingerprint', () => {
    const a = fingerprintFault({ ...BASE, message: 'x is not a function', stack: STACK_A })
    const b = fingerprintFault({ ...BASE, message: 'x is not a function', stack: STACK_B })
    expect(a.strategy).toBe('frames')
    expect(a.fingerprint).toBe(b.fingerprint)
  })

  it('release is not an input: nothing about the key derives from GIT_SHA', () => {
    // fingerprintFault takes no release field at all — the property is
    // structural. Two identical inputs at "different releases" are literally
    // the same call.
    const a = fingerprintFault({ ...BASE, message: 'boom', stack: STACK_A })
    const b = fingerprintFault({ ...BASE, message: 'boom', stack: STACK_A })
    expect(a.fingerprint).toBe(b.fingerprint)
  })

  it('two identical failures on DIFFERENT routes do not group', () => {
    const a = fingerprintFault({ ...BASE, route: '/api/kpis', message: 'timed out' })
    const b = fingerprintFault({ ...BASE, route: '/api/google/gmail', message: 'timed out' })
    expect(a.fingerprint).not.toBe(b.fingerprint)
  })

  it('the deploy-root and vendor filters leave repo-relative in-app frames', () => {
    const frames = inAppFrames(STACK_A, 3)
    expect(frames).toEqual(['doWork@lib/kpi-engine.ts', 'handler@app/api/kpis/route.ts'])
  })

  it('the container .next filter EXEMPTS compiled app code (the P0-6 correction)', () => {
    const compiled = [
      'Error: boom',
      '    at handler (/app/.next/server/app/api/kpis/route.js:1:4711)',
      '    at run (/app/node_modules/next/dist/server/lib/thing.js:9:9)',
    ].join('\n')
    const frames = inAppFrames(compiled, 3)
    expect(frames).toHaveLength(1)
    expect(frames[0]).toContain('.next/server/app/api/kpis/route.js')
  })
})

describe('normalizeMessage — ordered normalization', () => {
  it('tokenizes uuid/timestamp/email/url/ip/hex WITHOUT shredding their digits first', () => {
    const raw =
      'job 3f2a9c1e-1111-2222-3333-abcdefabcdef failed at 2026-08-25T02:06:27Z for danny@rxfitatx.com ' +
      'via https://hub.casatrejo.com/api/x from 10.0.0.7: pool exhausted after 30000ms'
    const out = normalizeMessage(raw)
    expect(out).toContain('<uuid>')
    expect(out).toContain('<ts>')
    expect(out).toContain('<email>')
    expect(out).toContain('<url>')
    expect(out).toContain('<ip>')
    expect(out).toContain('pool exhausted after <n>ms')
    expect(out).not.toContain('30000')
  })

  it('preserves the discriminators: HTTP statuses and SQLSTATEs survive; epoch millis do not', () => {
    const out = normalizeMessage('upstream said 503; sqlstate 23505; at 1699882342')
    expect(out).toContain('503')
    expect(out).toContain('23505')
    expect(out).not.toContain('1699882342')
  })

  it('two occurrences of the same error with different ids collapse to one skeleton', () => {
    const a = normalizeMessage("no row for id 'a1b2c3d4e5f6a7b8'")
    const b = normalizeMessage("no row for id 'ffffeeeeddddcccc'")
    expect(a).toBe(b)
  })
})

describe('the cascade and its strategies', () => {
  it('explicit > frames > message, each reporting its rung', () => {
    const explicit = fingerprintFault({ ...BASE, message: 'm', stack: STACK_A, explicit: 'my-key' })
    expect(explicit.strategy).toBe('explicit')

    const frames = fingerprintFault({ ...BASE, message: 'm', stack: STACK_A })
    expect(frames.strategy).toBe('frames')

    const message = fingerprintFault({ ...BASE, message: 'm', stack: null })
    expect(message.strategy).toBe('message')

    const keys = new Set([explicit.fingerprint, frames.fingerprint, message.fingerprint])
    expect(keys.size).toBe(3)
  })

  it('a vendor-only stack falls through to the message rung', () => {
    const vendorOnly = 'Error: x\n    at f (/app/node_modules/pg/lib/client.js:1:1)'
    expect(fingerprintFault({ ...BASE, message: 'm', stack: vendorOnly }).strategy).toBe('message')
  })
})

describe('the rule table — the over-splitting escape hatch', () => {
  const rules: FingerprintRule[] = [
    { code: 'timeout_idle', routeGlob: '/api/google/*', key: 'google-idle-timeouts' },
  ]

  it('a matching rule collapses many routes into one explicit key', () => {
    expect(matchFingerprintRule('timeout_idle', '/api/google/gmail', rules)).toBe('google-idle-timeouts')
    expect(matchFingerprintRule('timeout_idle', '/api/google/calendar', rules)).toBe('google-idle-timeouts')
    expect(matchFingerprintRule('timeout_idle', '/api/kpis', rules)).toBeNull()
    expect(matchFingerprintRule('internal', '/api/google/gmail', rules)).toBeNull()
  })

  it('two google routes fingerprint identically once the rule feeds the explicit rung', () => {
    const key = matchFingerprintRule('timeout_idle', '/api/google/gmail', rules)
    const a = fingerprintFault({ code: 'timeout_idle', layer: 'route', route: null, message: 'idle', explicit: key })
    const b = fingerprintFault({ code: 'timeout_idle', layer: 'route', route: null, message: 'other idle', explicit: key })
    expect(a.fingerprint).toBe(b.fingerprint)
  })

  it('the live table ships empty — rules are added as noise is observed', async () => {
    const { FINGERPRINT_RULES } = await import('./fault-fingerprint-rules')
    expect(FINGERPRINT_RULES).toEqual([])
  })
})
