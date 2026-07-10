import { describe, it, expect, vi, beforeEach } from 'vitest'

/* ════════════════════════════════════════════════════════════════════════════
   GET /api/healthz — unauthenticated readiness/health probe (P0-2).

   The route is the gating assertion for the Cloud Run startupProbe and the
   deploy smoke test, so its 200/503 contract is exercised directly here with
   the DB client and the #79 provider probes mocked (no DB harness needed):

     200 — DB answers SELECT 1 AND ≥1 AI provider key is present.
     503 — BOTH AI providers missing, OR the DB check fails.

   Also asserts the body leaks no key material and that middleware.ts's matcher
   excludes /api/healthz (so the probe is reachable without a session).
   ════════════════════════════════════════════════════════════════════════════ */

const { state } = vi.hoisted(() => ({
  state: {
    gemini: true,
    anthropic: true,
    dbOk: true, // when false, db.execute rejects (simulates DB down)
  },
}))

vi.mock('@/lib/gemini', () => ({ isGeminiConfigured: vi.fn(() => state.gemini) }))
vi.mock('@/lib/claude', () => ({ isClaudeConfigured: vi.fn(() => state.anthropic) }))
vi.mock('@/lib/db', () => ({
  db: {
    execute: vi.fn(async () => {
      if (!state.dbOk) throw new Error('ECONNREFUSED') // never surfaced in body
      return [{ '?column?': 1 }]
    }),
  },
}))
// Not called (we never invoke middleware()), but keeps the config import cheap.
vi.mock('next-auth/jwt', () => ({ getToken: vi.fn() }))

import { GET } from '@/app/api/healthz/route'
import { config } from '@/middleware'

beforeEach(() => {
  state.gemini = true
  state.anthropic = true
  state.dbOk = true
})

describe('GET /api/healthz — health contract', () => {
  it('200 {status:ok, db:true} when both providers present and DB ok', async () => {
    const res = await GET()
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toEqual({
      status: 'ok',
      providers: { gemini: true, anthropic: true },
      db: true,
    })
  })

  it('200 when only Gemini is present (cross-provider fallback → either is enough)', async () => {
    state.anthropic = false
    const res = await GET()
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.status).toBe('ok')
    expect(body.providers).toEqual({ gemini: true, anthropic: false })
  })

  it('200 when only Claude is present', async () => {
    state.gemini = false
    const res = await GET()
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.providers).toEqual({ gemini: false, anthropic: true })
  })

  it('503 when BOTH AI providers are missing (DB still ok)', async () => {
    state.gemini = false
    state.anthropic = false
    const res = await GET()
    expect(res.status).toBe(503)
    const body = await res.json()
    expect(body).toEqual({
      status: 'unhealthy',
      providers: { gemini: false, anthropic: false },
      db: true,
    })
  })

  it('503 when the DB SELECT 1 throws (providers present)', async () => {
    state.dbOk = false
    const res = await GET()
    expect(res.status).toBe(503)
    const body = await res.json()
    expect(body.status).toBe('unhealthy')
    expect(body.db).toBe(false)
    expect(body.providers).toEqual({ gemini: true, anthropic: true })
  })

  it('503 when both providers missing AND the DB is down', async () => {
    state.gemini = false
    state.anthropic = false
    state.dbOk = false
    const res = await GET()
    expect(res.status).toBe(503)
    const body = await res.json()
    expect(body).toEqual({
      status: 'unhealthy',
      providers: { gemini: false, anthropic: false },
      db: false,
    })
  })

  it('never leaks key material — body is booleans + a status string only', async () => {
    const res = await GET()
    const body = await res.json()
    // Exact shape: no extra fields (no key values/lengths/prefixes, no DB creds).
    expect(Object.keys(body).sort()).toEqual(['db', 'providers', 'status'])
    expect(typeof body.providers.gemini).toBe('boolean')
    expect(typeof body.providers.anthropic).toBe('boolean')
    expect(typeof body.db).toBe('boolean')
    const serialized = JSON.stringify(body)
    // Guard against accidentally serializing a real key prefix.
    expect(serialized).not.toMatch(/sk-ant-|AIza/)
  })
})

describe('middleware matcher — /api/healthz is excluded (unauthenticated)', () => {
  const matcher = (config.matcher as string[])[0]
  const re = new RegExp('^' + matcher + '$')

  it('does NOT match /api/healthz → middleware skips → no 401/redirect', () => {
    expect(re.test('/api/healthz')).toBe(false)
  })

  it('still matches a normal protected path (middleware runs)', () => {
    expect(re.test('/dashboard')).toBe(true)
  })

  it('preserves the pre-existing exclusions (e.g. /api/webhooks)', () => {
    expect(re.test('/api/webhooks')).toBe(false)
  })
})
