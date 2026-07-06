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
  PaperclipSchemaError,
  isAgentMemberOfCompany,
} from '@/lib/paperclip'
import type { Agent } from '@/types'

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
