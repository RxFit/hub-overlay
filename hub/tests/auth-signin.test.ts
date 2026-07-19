import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

/* ════════════════════════════════════════════════════════════════════════════
   Sign-in allowlist (P1) — the NextAuth `signIn` callback in lib/auth.

   Google is an OPEN IdP; without this gate ANY Google account could complete
   OAuth, be auto-provisioned as `onboarding`, and reach every session-gated
   route. The callback must FAIL CLOSED for unknown external accounts while never
   locking out a currently-legitimate user (env admins, DB-assigned staff, or the
   company domain).

   The email lists + domain allowlist are resolved at MODULE LOAD from env, so
   each case sets env, `vi.resetModules()`, and re-imports lib/auth. The DB layer
   (`lib/userRoles`) is mocked so the read-only role lookup is deterministic.
   ════════════════════════════════════════════════════════════════════════════ */

const { state } = vi.hoisted(() => ({
  state: { roles: {} as Record<string, { role: string; assignedProjects: string[] }> },
}))

vi.mock('@/lib/userRoles', () => ({
  getAllRoleEntries: vi.fn(async () =>
    Object.entries(state.roles).map(([email, v]) => ({ email, ...v })),
  ),
  // Read-only single-user lookup — the callback must NOT auto-create rows.
  getUserRole: vi.fn(async (email: string) =>
    state.roles[email.toLowerCase()] ?? { role: 'onboarding', assignedProjects: [] },
  ),
  upsertUserRole: vi.fn(async () => {}),
}))

type SignIn = (p: { user: { email?: string | null } | null }) => Promise<boolean | string>

async function loadSignIn(env: Record<string, string | undefined>): Promise<SignIn> {
  vi.resetModules()
  for (const key of ['SUPERADMIN_EMAILS', 'ADMIN_EMAILS', 'ALLOWED_EMAIL_DOMAINS', 'ALLOWED_EMAIL_ADDRESSES']) {
    delete process.env[key]
  }
  for (const [k, v] of Object.entries(env)) {
    if (v !== undefined) process.env[k] = v
  }
  const mod = await import('@/lib/auth')
  const cb = mod.authOptions.callbacks?.signIn
  if (!cb) throw new Error('signIn callback is not configured')
  return cb as unknown as SignIn
}

beforeEach(() => {
  state.roles = {}
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})
afterEach(() => {
  vi.restoreAllMocks()
})

describe('auth signIn — ALLOW matrix (no legitimate user is locked out)', () => {
  it('allows an env-configured superadmin', async () => {
    const signIn = await loadSignIn({ SUPERADMIN_EMAILS: 'danny@rxfitatx.com' })
    expect(await signIn({ user: { email: 'danny@rxfitatx.com' } })).toBe(true)
  })

  it('allows an env-configured admin (email match is case-insensitive)', async () => {
    const signIn = await loadSignIn({ ADMIN_EMAILS: 'boss@rxfitatx.com' })
    expect(await signIn({ user: { email: 'BOSS@RxFitATX.com' } })).toBe(true)
  })

  it('allows a company-domain user with no DB row yet (default domain derived from admin email)', async () => {
    const signIn = await loadSignIn({ SUPERADMIN_EMAILS: 'danny@rxfitatx.com' })
    // New hire → onboarding, but on the allowed company domain → permitted.
    expect(await signIn({ user: { email: 'newhire@rxfitatx.com' } })).toBe(true)
  })

  it('allows a DB-assigned staff/contractor on a FOREIGN domain', async () => {
    state.roles['contractor@gmail.com'] = { role: 'staff', assignedProjects: ['p1'] }
    const signIn = await loadSignIn({ SUPERADMIN_EMAILS: 'danny@rxfitatx.com' })
    expect(await signIn({ user: { email: 'contractor@gmail.com' } })).toBe(true)
  })

  it('preserves env admins even when their domain is excluded by an explicit allowlist', async () => {
    const signIn = await loadSignIn({
      SUPERADMIN_EMAILS: 'danny@rxfitatx.com',
      ADMIN_EMAILS: 'ceo@othercorp.com',
      ALLOWED_EMAIL_DOMAINS: 'nowhere.example',
    })
    expect(await signIn({ user: { email: 'danny@rxfitatx.com' } })).toBe(true)
    expect(await signIn({ user: { email: 'ceo@othercorp.com' } })).toBe(true)
  })

  it('honors an explicit multi-domain ALLOWED_EMAIL_DOMAINS (leading @ tolerated)', async () => {
    const signIn = await loadSignIn({
      SUPERADMIN_EMAILS: 'danny@rxfitatx.com',
      ALLOWED_EMAIL_DOMAINS: '@partner.io, rxfit.co',
    })
    expect(await signIn({ user: { email: 'x@partner.io' } })).toBe(true)
    expect(await signIn({ user: { email: 'y@rxfit.co' } })).toBe(true)
  })

  it('allows an individually-invited guest on a consumer domain (ALLOWED_EMAIL_ADDRESSES)', async () => {
    // The caroljean37 case: a gmail.com guest with only an onboarding DB row —
    // (b) and (c) both fail, so the explicit per-address invite must admit her.
    state.roles['caroljean37@gmail.com'] = { role: 'onboarding', assignedProjects: [] }
    const signIn = await loadSignIn({
      SUPERADMIN_EMAILS: 'danny@rxfitatx.com',
      ALLOWED_EMAIL_ADDRESSES: 'caroljean37@gmail.com',
    })
    expect(await signIn({ user: { email: 'caroljean37@gmail.com' } })).toBe(true)
    // Case-insensitive, like the admin lists.
    expect(await signIn({ user: { email: 'CarolJean37@Gmail.com' } })).toBe(true)
    // The invite is for HER address only — the rest of gmail.com stays denied.
    expect(await signIn({ user: { email: 'other@gmail.com' } })).toBe(false)
  })
})

describe('auth signIn — DENY matrix (fail closed for unknown external accounts)', () => {
  it('denies an unknown external Google account', async () => {
    const signIn = await loadSignIn({ SUPERADMIN_EMAILS: 'danny@rxfitatx.com' })
    expect(await signIn({ user: { email: 'random@gmail.com' } })).toBe(false)
  })

  it('denies an off-domain account that only has an onboarding DB row', async () => {
    state.roles['pending@gmail.com'] = { role: 'onboarding', assignedProjects: [] }
    const signIn = await loadSignIn({ SUPERADMIN_EMAILS: 'danny@rxfitatx.com' })
    expect(await signIn({ user: { email: 'pending@gmail.com' } })).toBe(false)
  })

  it('denies a sign-in with no email', async () => {
    const signIn = await loadSignIn({ SUPERADMIN_EMAILS: 'danny@rxfitatx.com' })
    expect(await signIn({ user: { email: null } })).toBe(false)
    expect(await signIn({ user: {} })).toBe(false)
    expect(await signIn({ user: null })).toBe(false)
  })

  it('with an explicit allowlist, a random company-domain hire is NOT implicitly allowed', async () => {
    // Explicit ALLOWED_EMAIL_DOMAINS REPLACES the derived default.
    const signIn = await loadSignIn({
      SUPERADMIN_EMAILS: 'danny@rxfitatx.com',
      ALLOWED_EMAIL_DOMAINS: 'partner.io',
    })
    expect(await signIn({ user: { email: 'newhire@rxfitatx.com' } })).toBe(false)
    // …but the configured superadmin still gets in via the env rule.
    expect(await signIn({ user: { email: 'danny@rxfitatx.com' } })).toBe(true)
  })
})
