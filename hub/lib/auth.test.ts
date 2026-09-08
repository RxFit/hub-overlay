import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { FaultDraft } from '@/lib/fault'
import { hashEmail } from '@/lib/observability'
import { REFRESH_FATAL_ERROR, REFRESH_TRANSIENT_ERROR } from '@/lib/auth-refresh'

/* ════════════════════════════════════════════════════════════════════════════
   lib/auth — the NextAuth callbacks/events ARE the fault boundary.

   app/api/auth/[...nextauth]/route.ts re-exports NextAuth(authOptions) and
   can never be wrapped (tests/fault-exemptions.json), so every refresh / role
   / sign-in failure has to be reported from inside authOptions. This suite
   drives the callbacks directly and asserts two things at once:

     1. the fault pipeline sees the failure (one reportFault, right code), and
     2. the PII contract holds: NEITHER the refresh token NOR the raw email
        ever reaches a fault record or a log line — userHash only.

   The allowlists are resolved at module load from env, so each case sets env,
   `vi.resetModules()`, and re-imports lib/auth (the tests/auth-signin.test.ts
   pattern). Everything mocked is hoisted so the SAME vi.fn survives the
   re-import — a factory-fresh vi.fn per import would be unobservable.
   ════════════════════════════════════════════════════════════════════════════ */

const RAW_EMAIL = 'someone@example-corp.test'
const REFRESH_TOKEN = '1//refresh-token-SECRET-do-not-log-8b3f'

const { reportMock, logMock, fetchMock, tokenStore, roles } = vi.hoisted(() => ({
  reportMock: vi.fn(),
  logMock: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  fetchMock: vi.fn(),
  tokenStore: { store: vi.fn(async () => {}), get: vi.fn(async () => null), clear: vi.fn(async () => {}) },
  roles: {
    getAllRoleEntries: vi.fn(async () => [] as Array<{ email: string; role: string; assignedProjects: string[] }>),
    getUserRole: vi.fn(async () => ({ role: 'onboarding', assignedProjects: [] as string[] })),
    upsertUserRole: vi.fn(async () => {}),
  },
}))

vi.mock('@/lib/fault-report', () => ({ reportFault: reportMock }))
vi.mock('@/lib/logger', () => ({ createLogger: () => logMock, logger: logMock }))
vi.mock('@/lib/userRoles', () => roles)
vi.mock('@/lib/google-token-store', () => ({
  storeGoogleRefreshToken: tokenStore.store,
  getGoogleRefreshToken: tokenStore.get,
  clearGoogleRefreshToken: tokenStore.clear,
}))
// Keep the real classifier and error constants; only the in-request retry
// sleeps go to zero. Real delays are 250+750 ms per transient case — with
// fake timers instead, every `await` inside the retry loop would need manual
// advancing, and the in-flight cache's unref'd setTimeout would too.
vi.mock('@/lib/auth-refresh', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth-refresh')>()),
  REFRESH_RETRY_DELAYS_MS: [0, 0],
}))

type AuthModule = typeof import('@/lib/auth')

async function loadAuth(env: Record<string, string> = {}): Promise<AuthModule['authOptions']> {
  vi.resetModules()
  for (const key of ['SUPERADMIN_EMAILS', 'ADMIN_EMAILS', 'ALLOWED_EMAIL_DOMAINS', 'ALLOWED_EMAIL_ADDRESSES', 'USER_DISPLAY_NAME_OVERRIDES']) {
    delete process.env[key]
  }
  for (const [k, v] of Object.entries(env)) process.env[k] = v
  const mod = await import('@/lib/auth')
  return mod.authOptions
}

/** Google token-endpoint response stub. */
function tokenResponse(status: number, body: Record<string, unknown>) {
  return { ok: status >= 200 && status < 300, status, json: async () => body }
}

/** An expired session JWT (accessTokenExpires in the past → refresh path). */
function expiredToken(overrides: Record<string, unknown> = {}) {
  return {
    email: RAW_EMAIL,
    sub: 'user-1',
    role: 'staff',
    assignedProjects: ['p1'],
    accessToken: 'ya29.stale',
    accessTokenExpires: Date.now() - 60_000,
    refreshToken: REFRESH_TOKEN,
    ...overrides,
  }
}

/** Drive callbacks.jwt on the refresh path (no `account`/`user` = not a fresh sign-in). */
async function runJwt(authOptions: AuthModule['authOptions'], token: Record<string, unknown>) {
  const jwt = authOptions.callbacks?.jwt
  if (!jwt) throw new Error('jwt callback is not configured')
  // The refresh path's shape: next-auth passes the persisted JWT and no
  // account/user. The rest of the params object is irrelevant here.
  return jwt({ token, user: undefined as never, account: null })
}

function reportedDraft(index = 0): FaultDraft {
  const call = reportMock.mock.calls[index]
  if (!call) throw new Error(`reportFault call #${index} was not made`)
  return call[0] as FaultDraft
}

/** Everything reportFault was handed, serialized — the PII assertion surface. */
function serializedReports(): string {
  return JSON.stringify(reportMock.mock.calls)
}

/** Everything the logger was handed, serialized — the other PII surface. */
function serializedLogs(): string {
  return JSON.stringify([logMock.info.mock.calls, logMock.warn.mock.calls, logMock.error.mock.calls, logMock.debug.mock.calls])
}

beforeEach(() => {
  vi.clearAllMocks()
  tokenStore.get.mockResolvedValue(null)
  roles.getAllRoleEntries.mockResolvedValue([])
  roles.getUserRole.mockResolvedValue({ role: 'onboarding', assignedProjects: [] })
  vi.stubGlobal('fetch', fetchMock)
  vi.stubEnv('GOOGLE_CLIENT_ID', 'client-id')
  vi.stubEnv('GOOGLE_CLIENT_SECRET', 'client-secret-SECRET')
  // The old code wrote these; the new code must not. Spied so a regression
  // to console.* shows up as a failed PII assertion, not as noisy output.
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

describe('callbacks.jwt — token refresh faults', () => {
  it('(a) a dead grant (400 invalid_grant) reports ONE auth_reauth_required fault with no token and no raw email', async () => {
    fetchMock.mockResolvedValue(tokenResponse(400, { error: 'invalid_grant', error_description: 'Token has been expired or revoked.' }))
    const authOptions = await loadAuth()

    const out = await runJwt(authOptions, expiredToken())

    expect(out.error).toBe(REFRESH_FATAL_ERROR)
    expect(out.accessToken).toBeUndefined()
    expect(out.refreshToken).toBeUndefined()
    // Fatal short-circuits the retry loop: exactly one Google round-trip.
    expect(fetchMock).toHaveBeenCalledTimes(1)
    // The durable copy is dropped so the dead grant is never replayed.
    expect(tokenStore.clear).toHaveBeenCalledWith(RAW_EMAIL)

    expect(reportMock).toHaveBeenCalledTimes(1)
    const draft = reportedDraft()
    expect(draft.code).toBe('auth_reauth_required')
    expect(draft.layer).toBe('lib')
    expect(draft.module).toBe('auth')
    expect(draft.userHash).toBe(hashEmail(RAW_EMAIL))
    expect(draft.userHash).toBeDefined()
    expect(draft.context).toMatchObject({ provider: 'google', tag: 'refreshAccessToken', kind: 'invalid_grant', status: 400 })
    expect(draft.message).toContain('invalid_grant')

    // THE contract: neither credential nor identity in anything reported/logged.
    const reports = serializedReports()
    expect(reports).not.toContain(REFRESH_TOKEN)
    expect(reports).not.toContain(RAW_EMAIL)
    expect(reports).not.toContain('client-secret-SECRET')
    const logs = serializedLogs()
    expect(logs).not.toContain(REFRESH_TOKEN)
    expect(logs).not.toContain(RAW_EMAIL)
    expect(logs).toContain(hashEmail(RAW_EMAIL))
    // And the old console.error line is gone entirely.
    expect(console.error).not.toHaveBeenCalled()
  })

  it('(b) 503 on every try keeps the session (transient) and reports ONE degraded upstream_unavailable fault', async () => {
    fetchMock.mockResolvedValue(tokenResponse(503, {}))
    const authOptions = await loadAuth()

    const out = await runJwt(authOptions, expiredToken())

    expect(out.error).toBe(REFRESH_TRANSIENT_ERROR)
    // Session preserved: the refresh token is kept for the next attempt.
    expect(out.refreshToken).toBe(REFRESH_TOKEN)
    expect(tokenStore.clear).not.toHaveBeenCalled()
    // attempt 0 + one retry per (zeroed) backoff delay.
    expect(fetchMock).toHaveBeenCalledTimes(3)

    expect(reportMock).toHaveBeenCalledTimes(1)
    const draft = reportedDraft()
    expect(draft.code).toBe('upstream_unavailable')
    expect(draft.severity).toBe('degraded')
    expect(draft.outcome).toBe('degraded')
    expect(draft.userHash).toBe(hashEmail(RAW_EMAIL))
    expect(draft.context).toMatchObject({ provider: 'google', kind: 'none', status: 503 })

    const reports = serializedReports()
    expect(reports).not.toContain(REFRESH_TOKEN)
    expect(reports).not.toContain(RAW_EMAIL)
    expect(serializedLogs()).not.toContain(RAW_EMAIL)
  })

  it('(b2) a 503 that recovers on the next try keeps the session, returns the new token, and reports ONE degraded upstream_unavailable fault with retryCount 1', async () => {
    fetchMock
      .mockResolvedValueOnce(tokenResponse(503, {}))
      .mockResolvedValueOnce(tokenResponse(200, { access_token: 'ya29.fresh', expires_in: 3600 }))
    const authOptions = await loadAuth()

    const out = await runJwt(authOptions, expiredToken())

    // The user saw nothing: a working token, no error marker, refresh token kept.
    expect(out.error).toBeUndefined()
    expect(out.accessToken).toBe('ya29.fresh')
    expect(out.refreshToken).toBe(REFRESH_TOKEN)
    expect(tokenStore.clear).not.toHaveBeenCalled()
    expect(fetchMock).toHaveBeenCalledTimes(2)

    // The telemetry did not: one degraded record carrying the retry count and
    // the LAST failure's status — the OTel rule lib/retry.ts states, applied
    // to this hand-rolled loop.
    expect(reportMock).toHaveBeenCalledTimes(1)
    const draft = reportedDraft()
    expect(draft.code).toBe('upstream_unavailable')
    expect(draft.severity).toBe('degraded')
    expect(draft.outcome).toBe('degraded')
    expect(draft.retryCount).toBe(1)
    expect(draft.userHash).toBe(hashEmail(RAW_EMAIL))
    expect(draft.context).toMatchObject({ provider: 'google', tag: 'refreshAccessToken', kind: 'none', status: 503 })

    const reports = serializedReports()
    expect(reports).not.toContain(REFRESH_TOKEN)
    expect(reports).not.toContain('ya29.fresh')
    expect(reports).not.toContain(RAW_EMAIL)
    const logs = serializedLogs()
    expect(logs).not.toContain(RAW_EMAIL)
    expect(logs).not.toContain(REFRESH_TOKEN)
  })

  it('(b3) two transient failures then a 200 → still ONE record, retryCount 2', async () => {
    fetchMock
      .mockResolvedValueOnce(tokenResponse(503, {}))
      .mockResolvedValueOnce(tokenResponse(503, {}))
      .mockResolvedValueOnce(tokenResponse(200, { access_token: 'ya29.fresh', expires_in: 3600 }))
    const authOptions = await loadAuth()

    const out = await runJwt(authOptions, expiredToken())

    expect(out.accessToken).toBe('ya29.fresh')
    expect(fetchMock).toHaveBeenCalledTimes(3)
    expect(reportMock).toHaveBeenCalledTimes(1)
    expect(reportedDraft().retryCount).toBe(2)
    expect(reportedDraft().code).toBe('upstream_unavailable')
  })

  it('(c) no refresh token at all is auth_reauth_required tagged no_refresh_token, with no Google call', async () => {
    const authOptions = await loadAuth()

    const out = await runJwt(authOptions, expiredToken({ refreshToken: undefined }))

    expect(out.error).toBe(REFRESH_FATAL_ERROR)
    expect(fetchMock).not.toHaveBeenCalled()

    expect(reportMock).toHaveBeenCalledTimes(1)
    const draft = reportedDraft()
    expect(draft.code).toBe('auth_reauth_required')
    // `kind` is the allowlisted context key (lib/fault.ts scrubContext) that
    // carries the reason — a `reason` key would be dropped silently.
    expect(draft.context).toMatchObject({ kind: 'no_refresh_token', tag: 'refreshAccessToken' })
    expect(draft.userHash).toBe(hashEmail(RAW_EMAIL))
    expect(serializedReports()).not.toContain(RAW_EMAIL)
  })

  it('a successful refresh reports nothing and re-resolves the role', async () => {
    fetchMock.mockResolvedValue(tokenResponse(200, { access_token: 'ya29.fresh', expires_in: 3600, refresh_token: 'rotated' }))
    roles.getAllRoleEntries.mockResolvedValue([{ email: RAW_EMAIL, role: 'admin', assignedProjects: ['*'] }])
    const authOptions = await loadAuth()

    const out = await runJwt(authOptions, expiredToken())

    expect(out.error).toBeUndefined()
    expect(out.accessToken).toBe('ya29.fresh')
    expect(out.refreshToken).toBe('rotated')
    expect(out.role).toBe('admin')
    expect(reportMock).not.toHaveBeenCalled()
  })
})

describe('callbacks.jwt — role lookup faults (degraded, behavior unchanged)', () => {
  function pgError(code: string, message: string) {
    const err = new Error(message) as Error & { code: string }
    err.code = code
    return err
  }

  it('a failed role lookup preserves the session role and reports a degraded fault with the SQLSTATE-derived code', async () => {
    fetchMock.mockResolvedValue(tokenResponse(200, { access_token: 'ya29.fresh', expires_in: 3600 }))
    // 08006 = connection_failure → recognize() derives db_error; not forced here.
    roles.getAllRoleEntries.mockRejectedValue(pgError('08006', `connection to ${RAW_EMAIL}'s db lost`))
    const authOptions = await loadAuth()

    const out = await runJwt(authOptions, expiredToken({ role: 'staff' }))

    // null from resolveUserRole → keep the stale role, never demote.
    expect(out.role).toBe('staff')
    expect(out.accessToken).toBe('ya29.fresh')

    expect(reportMock).toHaveBeenCalledTimes(1)
    const draft = reportedDraft()
    expect(draft.code).toBe('db_error')
    expect(draft.severity).toBe('degraded')
    expect(draft.layer).toBe('lib')
    expect(draft.module).toBe('auth')
    expect(draft.userHash).toBe(hashEmail(RAW_EMAIL))
    expect(draft.context).toMatchObject({ tag: 'roleLookup' })
    // The thrown message carried an address; scrubFreeText must strip it and
    // the record's userHash is the only identity that survives.
    expect(draft.message).not.toContain(RAW_EMAIL)
    expect(console.error).not.toHaveBeenCalled()
  })

  it('a failed auto-create still signs the user in as onboarding and reports a degraded fault', async () => {
    fetchMock.mockResolvedValue(tokenResponse(200, { access_token: 'ya29.fresh', expires_in: 3600 }))
    roles.getAllRoleEntries.mockResolvedValue([])
    roles.upsertUserRole.mockRejectedValue(pgError('23505', 'duplicate key value violates unique constraint'))
    const authOptions = await loadAuth()

    const out = await runJwt(authOptions, expiredToken({ role: 'staff' }))

    expect(out.role).toBe('onboarding')

    expect(reportMock).toHaveBeenCalledTimes(1)
    const draft = reportedDraft()
    expect(draft.code).toBe('db_constraint')
    expect(draft.severity).toBe('degraded')
    expect(draft.context).toMatchObject({ tag: 'autoCreateUserRow' })
    expect(draft.userHash).toBe(hashEmail(RAW_EMAIL))
    expect(serializedReports()).not.toContain(RAW_EMAIL)
  })
})

describe('events — auth lifecycle lines (userHash only)', () => {
  it('(d) signIn logs one info line with the hash, the provider and isNewUser — never the raw email', async () => {
    const authOptions = await loadAuth()
    const signIn = authOptions.events?.signIn
    if (!signIn) throw new Error('events.signIn is not configured')

    await signIn({
      user: { id: 'user-1', email: RAW_EMAIL, name: 'Some One' },
      account: { provider: 'google', type: 'oauth', providerAccountId: 'g-1' },
      isNewUser: true,
    })

    expect(logMock.info).toHaveBeenCalledTimes(1)
    const [fields, msg] = logMock.info.mock.calls[0]
    expect(fields).toEqual({ userHash: hashEmail(RAW_EMAIL), provider: 'google', isNewUser: true })
    expect(String(msg)).toContain('sign-in')
    const logs = serializedLogs()
    expect(logs).not.toContain(RAW_EMAIL)
    expect(logs).toContain(hashEmail(RAW_EMAIL))
    // Fire-and-forget by contract: no fault, no DB write.
    expect(reportMock).not.toHaveBeenCalled()
    expect(roles.upsertUserRole).not.toHaveBeenCalled()
  })

  it('(d) signOut logs one info line keyed by the JWT email hash — never the raw email', async () => {
    const authOptions = await loadAuth()
    const signOut = authOptions.events?.signOut
    if (!signOut) throw new Error('events.signOut is not configured')

    await signOut({ token: { email: RAW_EMAIL, sub: 'user-1' }, session: undefined as never })

    expect(logMock.info).toHaveBeenCalledTimes(1)
    const [fields, msg] = logMock.info.mock.calls[0]
    expect(fields).toMatchObject({ userHash: hashEmail(RAW_EMAIL) })
    expect(String(msg)).toContain('sign-out')
    const logs = serializedLogs()
    expect(logs).not.toContain(RAW_EMAIL)
    expect(logs).toContain(hashEmail(RAW_EMAIL))
    expect(reportMock).not.toHaveBeenCalled()
  })
})

describe('callbacks.signIn — denial is a warn line, not a fault', () => {
  it('(e) denies an account on no allowlist, logs userHash + domain only, and never reports a fault', async () => {
    // Allowed domain derived from the superadmin; RAW_EMAIL is on another one.
    const authOptions = await loadAuth({ SUPERADMIN_EMAILS: 'danny@rxfitatx.com' })
    const signIn = authOptions.callbacks?.signIn
    if (!signIn) throw new Error('signIn callback is not configured')
    roles.getUserRole.mockResolvedValue({ role: 'onboarding', assignedProjects: [] })

    const allowed = await signIn({
      user: { id: 'user-1', email: RAW_EMAIL },
      account: { provider: 'google', type: 'oauth', providerAccountId: 'g-1' },
    })

    expect(allowed).toBe(false)
    // Read-only lookup — a rejected account never gets a row.
    expect(roles.upsertUserRole).not.toHaveBeenCalled()

    expect(logMock.warn).toHaveBeenCalledTimes(1)
    const [fields] = logMock.warn.mock.calls[0]
    expect(fields).toEqual({ userHash: hashEmail(RAW_EMAIL), domain: 'example-corp.test' })

    // The raw address is absent from EVERY sink: pino, console, faults.
    expect(serializedLogs()).not.toContain(RAW_EMAIL)
    expect(JSON.stringify(vi.mocked(console.warn).mock.calls)).not.toContain(RAW_EMAIL)
    expect(console.warn).not.toHaveBeenCalled()
    // Expected behavior, not a fault — the allowlist doing its job must not
    // let a stranger inflate the error rate.
    expect(reportMock).not.toHaveBeenCalled()
  })
})
