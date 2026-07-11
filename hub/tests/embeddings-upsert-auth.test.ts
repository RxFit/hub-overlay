import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { NextRequest } from 'next/server'

/* ════════════════════════════════════════════════════════════════════════════
   POST /api/embeddings/upsert — service-auth hardening (P2).

   The bearer compare is now constant-time (timingSafeEqual + length guard) and
   fails closed when PAPERCLIP_API_KEY is unset. The body tenantId is validated
   against the known `tenants` set instead of being trusted blindly. The DB and
   vector-store are mocked so this runs without a real Postgres.
   ════════════════════════════════════════════════════════════════════════════ */

const { state } = vi.hoisted(() => ({
  state: {
    tenantRows: [] as { id: string }[],
    upsertCalls: 0,
  },
}))

vi.mock('@/lib/vector-store', () => ({
  upsertDocumentChunk: vi.fn(async () => {
    state.upsertCalls++
    return { id: 'chunk-1' }
  }),
  deleteDocumentChunks: vi.fn(async () => {}),
}))

vi.mock('@/lib/db', () => ({
  db: {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => state.tenantRows,
        }),
      }),
    }),
  },
}))

import { POST } from '@/app/api/embeddings/upsert/route'

function req(authHeader: string | null, body: Record<string, unknown>) {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (authHeader !== null) headers.authorization = authHeader
  return new NextRequest('http://localhost/api/embeddings/upsert', {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  })
}

const VALID_BODY = { tenantId: 'rxfit', sourceUrl: 'https://x/doc', content: 'hello world' }

beforeEach(() => {
  state.tenantRows = [{ id: 'rxfit' }]
  state.upsertCalls = 0
  process.env.PAPERCLIP_API_KEY = 'super-secret-key'
})

afterEach(() => {
  vi.clearAllMocks()
})

describe('POST /api/embeddings/upsert — auth', () => {
  it('accepts the correct bearer key and upserts', async () => {
    const res = await POST(req('Bearer super-secret-key', VALID_BODY))
    expect(res.status).toBe(200)
    expect(state.upsertCalls).toBe(1)
  })

  it('rejects a wrong key of the same length (401) without upserting', async () => {
    const res = await POST(req('Bearer super-secret-XXX', VALID_BODY))
    expect(res.status).toBe(401)
    expect(state.upsertCalls).toBe(0)
  })

  it('rejects a wrong key of a different length (401)', async () => {
    const res = await POST(req('Bearer nope', VALID_BODY))
    expect(res.status).toBe(401)
    expect(state.upsertCalls).toBe(0)
  })

  it('rejects a missing Authorization header (401)', async () => {
    const res = await POST(req(null, VALID_BODY))
    expect(res.status).toBe(401)
  })

  it('fails closed when PAPERCLIP_API_KEY is unset (401 even for "Bearer ")', async () => {
    delete process.env.PAPERCLIP_API_KEY
    const res = await POST(req('Bearer ', VALID_BODY))
    expect(res.status).toBe(401)
    expect(state.upsertCalls).toBe(0)
  })

  it('rejects an unknown body tenantId (403) even with a valid key', async () => {
    state.tenantRows = []
    const res = await POST(req('Bearer super-secret-key', { ...VALID_BODY, tenantId: 'attacker' }))
    expect(res.status).toBe(403)
    expect(state.upsertCalls).toBe(0)
  })

  it('returns 400 when required fields are missing (after auth passes)', async () => {
    const res = await POST(req('Bearer super-secret-key', { tenantId: 'rxfit' }))
    expect(res.status).toBe(400)
  })
})
