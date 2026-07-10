import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

/**
 * P1-4 — strict validation on Paperclip *list* endpoints.
 *
 * A well-formed list parses; a wrong-SHAPE payload throws the typed
 * PaperclipSchemaError (so a parse failure is observable, not a silent empty
 * list); unknown EXTRA fields still pass via `.passthrough()` (forward-compat).
 * Callers that must degrade in the UI catch the throw → [] at the call site.
 *
 * The fetch/auth/breaker/retry machinery around paperclipFetch is stubbed so
 * the test exercises only the schema-validation boundary deterministically.
 */

vi.mock('@/lib/paperclipSession', () => ({
  getPaperclipAuthHeaders: vi.fn(async () => ({})),
  clearPaperclipSession: vi.fn(),
}))
vi.mock('@/lib/circuit-breaker', () => ({
  breaker: { execute: (_key: string, fn: () => unknown) => fn() },
}))
vi.mock('@/lib/retry', () => ({
  withRetry: (fn: () => unknown) => fn(),
}))
vi.mock('@/lib/loop-detector', () => ({
  loopDetector: { detectAndRecord: vi.fn() },
}))
vi.mock('@/lib/tenant-context', () => ({ getTenantId: () => 'test' }))
vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}))

import {
  getCompanies,
  getIssues,
  getAgents,
  getRuns,
  deleteCompany,
  PaperclipSchemaError,
  isAgentMemberOfCompany,
} from '@/lib/paperclip'
import type { Agent, Issue } from '@/types'

function res(body: unknown) {
  return {
    ok: true,
    status: 200,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response
}

const validCompany = {
  id: 'c1',
  name: 'RxFit',
  identifier: 'RXF',
  description: null,
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
}

const validIssue = {
  id: 'i1',
  title: 'Ship it',
  companyId: 'co-1',
  status: 'todo',
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
}

const fetchMock = vi.fn()

beforeEach(() => {
  fetchMock.mockReset()
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('P1-4: list-endpoint schema validation', () => {
  it('parses a well-formed list', async () => {
    fetchMock.mockResolvedValueOnce(res([validCompany]))
    const out = await getCompanies()
    expect(out).toHaveLength(1)
    expect(out[0].id).toBe('c1')
  })

  it('tolerates unknown EXTRA fields (passthrough / forward-compat)', async () => {
    fetchMock.mockResolvedValueOnce(
      res([{ ...validCompany, futureField: 'x', nested: { a: 1 } }]),
    )
    const out = await getCompanies()
    expect(out).toHaveLength(1)
    expect((out[0] as unknown as Record<string, unknown>).futureField).toBe('x')
  })

  it('throws PaperclipSchemaError on a wrong-shape payload (object, not a list)', async () => {
    fetchMock.mockResolvedValueOnce(res({ unexpected: 'shape' }))
    await expect(getCompanies()).rejects.toBeInstanceOf(PaperclipSchemaError)
  })

  it('throws PaperclipSchemaError when a required field is missing', async () => {
    fetchMock.mockResolvedValueOnce(res([{ id: 'c1', name: 'Missing the rest' }]))
    await expect(getCompanies()).rejects.toBeInstanceOf(PaperclipSchemaError)
  })

  it('lets a caller degrade to [] on the typed error while a real list returns data', async () => {
    // Wrong shape → caller catches the throw and degrades to [].
    fetchMock.mockResolvedValueOnce(res({ not: 'an array' }))
    const degraded = await getIssues('co-1').catch(() => [])
    expect(degraded).toEqual([])

    // Genuine list → data flows through unchanged.
    fetchMock.mockResolvedValueOnce(res([validIssue]))
    const real = await getIssues('co-1').catch(() => [])
    expect(real).toHaveLength(1)
    expect(real[0].id).toBe('i1')
  })
})

describe('P1-perf: getRuns pre-fetched issues/agents reuse (call-reduction)', () => {
  const rawIssues = [
    { id: 'i1', identifier: 'RXF-1', title: 'One', companyId: 'c1', status: 'todo', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-03T00:00:00Z' },
    { id: 'i2', identifier: 'RXF-2', title: 'Two', companyId: 'c1', status: 'todo', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-02T00:00:00Z' },
  ]
  const rawAgents = [
    { id: 'a1', name: 'CEO', status: 'active', companyId: 'c1', createdAt: '2026-01-01T00:00:00Z' },
  ]
  const runsByIssue: Record<string, unknown[]> = {
    i1: [{ id: 'r1', status: 'completed', agentId: 'a1', startedAt: '2026-01-03T00:00:00Z', completedAt: '2026-01-03T00:00:05Z', durationMs: 5000 }],
    i2: [{ id: 'r2', status: 'failed', agentId: 'a1', startedAt: '2026-01-02T00:00:00Z', completedAt: '2026-01-02T00:00:01Z', durationMs: 1000 }],
  }

  function routeFetch(url: string) {
    const runsMatch = url.match(/\/api\/issues\/([^/]+)\/runs/)
    if (runsMatch) return Promise.resolve(res({ runs: runsByIssue[runsMatch[1]] ?? [] }))
    if (/\/api\/companies\/[^/]+\/issues/.test(url)) return Promise.resolve(res({ issues: rawIssues }))
    if (/\/api\/companies\/[^/]+\/agents/.test(url)) return Promise.resolve(res({ agents: rawAgents }))
    return Promise.resolve(res({}))
  }

  it('does NOT re-fetch issues/agents when the caller passes them in', async () => {
    fetchMock.mockImplementation((url: string) => routeFetch(url))

    const preIssues = [
      { id: 'i1', identifier: 'RXF-1' },
      { id: 'i2', identifier: 'RXF-2' },
    ] as unknown as Issue[]
    const preAgents = [{ id: 'a1', name: 'CEO' }] as unknown as Agent[]

    const runs = await getRuns('c1', { limit: 50, issues: preIssues, agents: preAgents })

    const urls = fetchMock.mock.calls.map(c => c[0] as string)
    // No issues/agents list fetch — only the per-issue /runs calls remain.
    expect(urls.some(u => /\/api\/companies\/[^/]+\/issues/.test(u))).toBe(false)
    expect(urls.some(u => /\/api\/companies\/[^/]+\/agents/.test(u))).toBe(false)
    expect(urls.filter(u => /\/runs/.test(u))).toHaveLength(2) // one per passed issue
    expect(runs).toHaveLength(2)
  })

  it('fetches issues/agents itself when they are omitted (backward-compatible)', async () => {
    fetchMock.mockImplementation((url: string) => routeFetch(url))

    await getRuns('c1', { limit: 50 })

    const urls = fetchMock.mock.calls.map(c => c[0] as string)
    expect(urls.some(u => /\/api\/companies\/[^/]+\/issues/.test(u))).toBe(true)
    expect(urls.some(u => /\/api\/companies\/[^/]+\/agents/.test(u))).toBe(true)
  })

  it('produces IDENTICAL aggregation output with or without pre-fetched issues/agents', async () => {
    fetchMock.mockImplementation((url: string) => routeFetch(url))

    // Fetch exactly what the KPI route would hold, then reuse it.
    const issues = await getIssues('c1', { limit: 100 })
    const agents = await getAgents('c1')

    const withPrefetch = await getRuns('c1', { limit: 50, issues, agents })
    const withoutPrefetch = await getRuns('c1', { limit: 50 })

    // Behavior-neutral: the reuse path is a pure call-reduction refactor.
    expect(withPrefetch).toEqual(withoutPrefetch)
  })
})

describe('P1-6b: isAgentMemberOfCompany', () => {
  const agents = [
    { id: 'a1', name: 'CEO' },
    { id: 'a2', name: 'Engineer' },
  ] as unknown as Agent[]

  it('returns true when the assignee is a company agent', () => {
    expect(isAgentMemberOfCompany(agents, 'a1')).toBe(true)
  })

  it('returns false for an agent id outside the company', () => {
    expect(isAgentMemberOfCompany(agents, 'a3')).toBe(false)
  })

  it('returns false when the company has no agents', () => {
    expect(isAgentMemberOfCompany([], 'a1')).toBe(false)
  })
})

describe('deleteCompany — protected-workspace guard (defense in depth)', () => {
  const PROTECTED = 'dddddddd-0000-0000-0000-00000000000d'
  const original = process.env.PROTECTED_COMPANY_IDS

  beforeEach(() => {
    process.env.PROTECTED_COMPANY_IDS = PROTECTED
  })
  afterEach(() => {
    if (original === undefined) delete process.env.PROTECTED_COMPANY_IDS
    else process.env.PROTECTED_COMPANY_IDS = original
  })

  it('throws for a protected id and never issues the DELETE', async () => {
    await expect(deleteCompany(PROTECTED)).rejects.toThrow(/protected/i)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('throws for a protected id regardless of UUID case', async () => {
    await expect(deleteCompany(PROTECTED.toUpperCase())).rejects.toThrow(/protected/i)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('proceeds (issues the DELETE) for a non-protected id', async () => {
    fetchMock.mockResolvedValueOnce(res({}))
    await deleteCompany('eeeeeeee-0000-0000-0000-00000000000e')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})
