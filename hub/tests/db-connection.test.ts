import { describe, it, expect, afterEach, vi } from 'vitest'
import { resolveDbConnection } from '@/lib/db'

/* ════════════════════════════════════════════════════════════════════════════
   resolveDbConnection — DATABASE_URL Cloud SQL socket-invariant guard (P1).

   Both lib/db.ts and drizzle/migrate.mjs used to silently fall back to a
   `localhost` connection when DATABASE_URL was malformed — which in Cloud Run
   reaches nothing and ECONNREFUSEs at the FIRST query instead of failing loudly
   at boot, hiding a broken deploy. This guard fails early with an actionable
   message WITHOUT false-positiving on local dev, real-TCP, or test URLs.

   SECURITY: the raw URL / cleanUrl carry the DB password and must NEVER appear
   in a thrown message — only the (non-secret) socket path and loopback host
   token may. The last test pins that invariant.
   ════════════════════════════════════════════════════════════════════════════ */

// A distinctive password token so the "no secret leak" assertions are meaningful
// (a single char like 'p' would match by accident in ordinary prose).
const SECRET = 'sup3r-s3cr3t-pw'

describe('resolveDbConnection', () => {
  afterEach(() => {
    // Restore NODE_ENV (and any other stubbed env) to what vitest set between
    // cases. vi.stubEnv special-cases NODE_ENV so the readonly type still works.
    vi.unstubAllEnvs()
  })

  it('throws when ?host= is present but not an absolute socket path', () => {
    expect(() =>
      resolveDbConnection(`postgres://u:${SECRET}@localhost/db?host=some-host`),
    ).toThrow(/\[db\].*absolute Cloud SQL socket path/)
  })

  it('throws in production when the host is localhost and there is no ?host= override', () => {
    vi.stubEnv('NODE_ENV', 'production')
    expect(() =>
      resolveDbConnection(`postgres://u:${SECRET}@localhost:5432/db`),
    ).toThrow(/\[db\].*localhost.*production/)
  })

  it('throws in production for the 127.0.0.1 loopback with no ?host= override', () => {
    vi.stubEnv('NODE_ENV', 'production')
    expect(() =>
      resolveDbConnection(`postgres://u:${SECRET}@127.0.0.1:5432/db`),
    ).toThrow(/\[db\].*127\.0\.0\.1.*production/)
  })

  it('returns the socket host and stripped URL for a valid Cloud SQL socket URL', () => {
    // The real prod shape: localhost placeholder to satisfy the URL parser, with
    // the actual connection driven by an absolute ?host= Unix socket path.
    vi.stubEnv('NODE_ENV', 'production')
    const { cleanUrl, explicitHost } = resolveDbConnection(
      `postgres://u:${SECRET}@localhost/db?host=/cloudsql/proj:reg:inst`,
    )
    expect(explicitHost).toBe('/cloudsql/proj:reg:inst')
    // ?host= is stripped so postgres.js doesn't forward it as a DB config param.
    expect(cleanUrl).toBe(`postgres://u:${SECRET}@localhost/db`)
  })

  it('does NOT throw for @localhost when NODE_ENV is not production (local dev)', () => {
    vi.stubEnv('NODE_ENV', 'development')
    const { cleanUrl, explicitHost } = resolveDbConnection(
      `postgres://u:${SECRET}@localhost:5432/db`,
    )
    expect(explicitHost).toBeUndefined()
    expect(cleanUrl).toBe(`postgres://u:${SECRET}@localhost:5432/db`)
  })

  it('does NOT throw for a real TCP host in production', () => {
    vi.stubEnv('NODE_ENV', 'production')
    const { cleanUrl, explicitHost } = resolveDbConnection(
      `postgres://u:${SECRET}@db.internal:5432/db`,
    )
    expect(explicitHost).toBeUndefined()
    expect(cleanUrl).toBe(`postgres://u:${SECRET}@db.internal:5432/db`)
  })

  it('does NOT throw on an unparseable URL in production (defensive parse — unknown host treated as non-local)', () => {
    vi.stubEnv('NODE_ENV', 'production')
    // Not a valid URL: `new URL()` throws internally; the guard must swallow that
    // and treat the host as unknown/non-local rather than crash or false-fail.
    expect(() => resolveDbConnection('this is not a url')).not.toThrow()
  })

  it('never leaks the DB password into a thrown message', () => {
    // Both throwing paths: the non-absolute ?host= path and the prod-localhost path.
    const capture = (fn: () => unknown): string => {
      try {
        fn()
      } catch (err) {
        return (err as Error).message
      }
      throw new Error('expected resolveDbConnection to throw, but it did not')
    }

    const msg1 = capture(() =>
      resolveDbConnection(`postgres://u:${SECRET}@localhost/db?host=not-absolute`),
    )
    expect(msg1).not.toContain(SECRET)
    expect(msg1).toContain('[db]')

    vi.stubEnv('NODE_ENV', 'production')
    const msg2 = capture(() => resolveDbConnection(`postgres://u:${SECRET}@localhost:5432/db`))
    expect(msg2).not.toContain(SECRET)
    expect(msg2).toContain('[db]')
  })
})
