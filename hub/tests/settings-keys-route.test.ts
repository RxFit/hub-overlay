import { describe, it, expect, vi, beforeAll, beforeEach, afterAll, afterEach } from 'vitest'
import { NextRequest } from 'next/server'
import { describeDb, migrateTestDb, resetDb, closeDb, getSql } from '../test/db-harness'

/* ════════════════════════════════════════════════════════════════════════════
   /api/settings/keys — Hub-owned encrypted credential storage (Phase 3 PR 1).

   Replaces the Paperclip Secrets API proxy. The properties that matter most
   are the ones a passing happy path would not catch:
     - a secret VALUE never appears in any response body, on any verb
     - the stored column is ciphertext, not the plaintext
     - workspace scoping refuses rather than silently redirects
     - a missing encryption key fails CLOSED instead of storing plaintext
   ════════════════════════════════════════════════════════════════════════════ */

const { state } = vi.hoisted(() => ({ state: { session: null as unknown } }))

vi.mock('next-auth', () => ({
  getServerSession: vi.fn(async () => state.session),
}))
vi.mock('@/lib/auth', () => ({ authOptions: {} }))

import { GET, POST, DELETE } from '@/app/api/settings/keys/route'

const KEY = 'v1:' + Buffer.alloc(32, 9).toString('base64')

function session(role: string, assignedProjects: string[] = ['c1']) {
  return { user: { email: 'admin@rxfitatx.com', role, assignedProjects } }
}
function getReq(qs = '') {
  return new NextRequest(`http://localhost/api/settings/keys${qs}`)
}
function postReq(body: unknown) {
  return new NextRequest('http://localhost/api/settings/keys', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json' },
  })
}
function delReq(qs: string) {
  return new NextRequest(`http://localhost/api/settings/keys${qs}`, { method: 'DELETE' })
}

/* ── Early exits: no DB required ─────────────────────────────────────────── */
describe('/api/settings/keys — auth gates', () => {
  beforeEach(() => { state.session = null })

  it('401s every verb without a session', async () => {
    expect((await GET(getReq())).status).toBe(401)
    expect((await POST(postReq({ name: 'A', value: 'b' }))).status).toBe(401)
    expect((await DELETE(delReq('?id=x'))).status).toBe(401)
  })

  it('blocks onboarding from reading', async () => {
    state.session = session('onboarding')
    expect((await GET(getReq())).status).toBe(403)
  })

  it('blocks staff from writing and deleting but allows listing', async () => {
    state.session = session('staff')
    expect((await POST(postReq({ name: 'A_KEY', value: 'v' }))).status).toBe(403)
    expect((await DELETE(delReq('?id=x'))).status).toBe(403)
  })

  it('refuses a workspace the caller is not assigned', async () => {
    state.session = session('admin', ['c1'])
    const res = await POST(postReq({ name: 'A_KEY', value: 'v', companyId: 'c-other' }))
    expect(res.status).toBe(400)
  })
})

/* ── Full stack against a real database ──────────────────────────────────── */
describeDb('/api/settings/keys — encrypted storage', () => {
  beforeAll(() => { migrateTestDb() })
  beforeEach(async () => {
    await resetDb()
    vi.stubEnv('SECRET_ENCRYPTION_KEY', KEY)
    vi.stubEnv('NEXTAUTH_SECRET', 'unrelated-session-secret')
    state.session = session('admin', ['c1'])
  })
  afterEach(() => { vi.unstubAllEnvs() })
  afterAll(async () => { await closeDb() })

  it('stores a credential and lists it as metadata only', async () => {
    const created = await POST(postReq({ name: 'STRIPE_SECRET_KEY', value: 'sk_live_XYZ', companyId: 'c1' }))
    expect(created.status).toBe(200)
    expect((await created.json()).created).toBe(true)

    const listed = await GET(getReq('?companyId=c1'))
    const body = await listed.json()
    expect(body.secrets).toHaveLength(1)
    expect(body.secrets[0].name).toBe('STRIPE_SECRET_KEY')
    expect(body.configured).toBe(true)
  })

  /* The contract the module header promises, asserted on the raw bytes rather
     than on field names — a future field could reintroduce the value. */
  it('NEVER returns the secret value in any response body', async () => {
    const secret = 'sk_live_NEVER_SHOW_ME'
    const createdRaw = await (await POST(postReq({ name: 'STRIPE_SECRET_KEY', value: secret, companyId: 'c1' }))).text()
    const listedRaw = await (await GET(getReq('?companyId=c1'))).text()

    expect(createdRaw).not.toContain(secret)
    expect(listedRaw).not.toContain(secret)
    expect(listedRaw).not.toContain('NEVER_SHOW_ME')
  })

  it('stores ciphertext in the database, not the plaintext', async () => {
    const secret = 'sk_live_PLAINTEXT_CANARY'
    await POST(postReq({ name: 'STRIPE_SECRET_KEY', value: secret, companyId: 'c1' }))

    const rows = await getSql()`SELECT ciphertext, key_id FROM hub_secrets`
    expect(rows).toHaveLength(1)
    expect(rows[0].ciphertext).not.toContain(secret)
    expect(rows[0].ciphertext).not.toContain('PLAINTEXT_CANARY')
    // Key id is stamped as a column so a rotation can find rows to re-seal.
    expect(rows[0].key_id).toBe('v1')
    expect(rows[0].ciphertext.startsWith('v1.')).toBe(true)
  })

  it('round-trips the value for server-side use', async () => {
    await POST(postReq({ name: 'STRIPE_SECRET_KEY', value: 'sk_live_ROUNDTRIP', companyId: 'c1' }))
    const { getSecretValue } = await import('@/lib/secrets-store')
    expect(await getSecretValue('STRIPE_SECRET_KEY', 'c1')).toBe('sk_live_ROUNDTRIP')
  })

  /* Fail closed. Storing plaintext here would be undetectable in production:
     no request path ever reads a value back, so the UI would show "✓ Set"
     over an unencrypted credential indefinitely. */
  it('refuses to store anything when no encryption key is configured', async () => {
    vi.stubEnv('SECRET_ENCRYPTION_KEY', '')

    const res = await POST(postReq({ name: 'STRIPE_SECRET_KEY', value: 'sk_live_X', companyId: 'c1' }))
    expect(res.status).toBe(503)
    expect((await res.json()).error).toMatch(/refusing to store the key unencrypted/i)

    // Nothing was written at all — not even an empty or plaintext row.
    expect(await getSql()`SELECT count(*)::int AS n FROM hub_secrets`).toEqual([{ n: 0 }])
  })

  it('reports configured:false so an unconfigured Hub is distinguishable from an empty one', async () => {
    vi.stubEnv('SECRET_ENCRYPTION_KEY', '')
    const body = await (await GET(getReq('?companyId=c1'))).json()
    expect(body.configured).toBe(false)
    expect(body.secrets).toEqual([])
  })

  it('rotates in place when an existing name is re-entered', async () => {
    await POST(postReq({ name: 'STRIPE_SECRET_KEY', value: 'sk_first', companyId: 'c1' }))
    await POST(postReq({ name: 'STRIPE_SECRET_KEY', value: 'sk_second', companyId: 'c1' }))

    const listed = await (await GET(getReq('?companyId=c1'))).json()
    expect(listed.secrets).toHaveLength(1)  // rotation, not a duplicate row

    const { getSecretValue } = await import('@/lib/secrets-store')
    expect(await getSecretValue('STRIPE_SECRET_KEY', 'c1')).toBe('sk_second')
  })

  it('rejects a malformed key name and a blocked key name', async () => {
    expect((await POST(postReq({ name: 'lower_case', value: 'v', companyId: 'c1' }))).status).toBe(400)
    expect((await POST(postReq({ name: 'NEXTAUTH_SECRET', value: 'v', companyId: 'c1' }))).status).toBe(403)
    // The at-rest key itself must not be storable through this UI.
    expect((await POST(postReq({ name: 'SECRET_ENCRYPTION_KEY', value: 'v', companyId: 'c1' }))).status).toBe(403)
  })

  it('deletes only within the caller workspace', async () => {
    await POST(postReq({ name: 'STRIPE_SECRET_KEY', value: 'sk_x', companyId: 'c1' }))
    const [row] = await getSql()`SELECT id FROM hub_secrets`

    // A superadmin files a key under another workspace.
    state.session = session('superadmin', [])
    await POST(postReq({ name: 'OTHER_KEY', value: 'v', companyId: 'c2' }))

    // The c1 admin cannot reach it, and gets the same answer as a bad id.
    state.session = session('admin', ['c1'])
    const [other] = await getSql()`SELECT id FROM hub_secrets WHERE company_id = 'c2'`
    expect((await DELETE(delReq(`?id=${other.id}&companyId=c1`))).status).toBe(403)
    expect(await getSql()`SELECT count(*)::int AS n FROM hub_secrets WHERE company_id = 'c2'`).toEqual([{ n: 1 }])

    // Its own key deletes fine.
    expect((await DELETE(delReq(`?id=${row.id}&companyId=c1`))).status).toBe(200)
  })

  it('isolates workspaces when listing', async () => {
    state.session = session('superadmin', [])
    await POST(postReq({ name: 'A_KEY', value: 'v', companyId: 'c1' }))
    await POST(postReq({ name: 'B_KEY', value: 'v', companyId: 'c2' }))

    const c1 = await (await GET(getReq('?companyId=c1'))).json()
    expect(c1.secrets.map((s: { name: string }) => s.name)).toEqual(['A_KEY'])
  })
})
