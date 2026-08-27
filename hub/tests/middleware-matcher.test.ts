import { describe, it, expect } from 'vitest'
import { config } from '@/middleware'

/**
 * The middleware matcher — which paths get the session gate, and which are
 * deliberately excluded.
 *
 * This file exists because the exclusion list is a load-bearing security
 * boundary with a documented failure history on BOTH sides:
 *
 *  - Excluded too little: `/api/reports/run` was middlewared, so the hourly
 *    scheduled-reports cron (which carries a secret header, never a NextAuth
 *    cookie) 401'd before its own constant-time check could run — and no
 *    digest ever published. `/api/kpis/sync` is the same latent class.
 *  - Excluded too much: a broad prefix silently un-gates every future route
 *    beneath it, and no handler-level test would notice.
 *
 * Nothing else in the suite asserts this regex, so a well-meaning edit could
 * widen or narrow it invisibly. Every excluded path below MUST have its own
 * per-handler auth (constant-time secret, or intentional public access).
 *
 * How this models Next: for a lookahead-style matcher like ours, Next compiles
 * the string to a regex anchored at both ends. Reconstructing it that way is
 * the closest we can get to the routing layer without booting Next itself.
 */

const matcher = (config.matcher as string[])[0]
const matcherRe = new RegExp(`^${matcher}$`)

/** True when the auth middleware RUNS for this path (i.e. it is protected). */
const isProtected = (pathname: string): boolean => matcherRe.test(pathname)

describe('middleware matcher — protected paths', () => {
  it.each([
    ['/', 'the app shell'],
    ['/settings', 'a page route'],
    ['/admin', 'the admin page (role-gated inside)'],
    ['/api/runs', 'the runs feed — session + admin gated in-handler'],
    ['/api/kpis', 'a session API route'],
    ['/api/feed', 'a session API route'],
    ['/api/reports/other', 'a sibling of the excluded runner stays gated'],
    ['/api/cronx', 'near-miss of the api/cron/ exclusion stays gated'],
  ])('%s is protected (%s)', (path) => {
    expect(isProtected(path)).toBe(true)
  })

  /**
   * KNOWN GAP, pinned deliberately rather than fixed here.
   *
   * `api/worker` carries no trailing slash, so it is a prefix match: a future
   * route at /api/workers or /api/worker-admin would inherit the exclusion and
   * ship un-gated. Harmless today — only /api/worker/{claim,jobs/...} exist,
   * all with their own x-worker-secret check — and anchoring it to
   * `api/worker/` is the one-character fix. It is NOT bundled into the
   * scheduled-reports PR because that would move the live dispatch worker's
   * auth boundary for an unrelated reason. This test documents the behavior so
   * the fix is a deliberate edit here, not a surprise.
   */
  it('DOCUMENTED GAP: api/worker is a prefix, so sibling paths are un-gated', () => {
    expect(isProtected('/api/workers')).toBe(false)
  })
})

describe('middleware matcher — deliberate exclusions', () => {
  it.each([
    ['/login', 'the auth page itself'],
    ['/api/auth/session', 'NextAuth endpoints'],
    ['/api/healthz', 'unauthenticated Cloud Run probe'],
    ['/api/chat', 'streams with its own session check'],
    ['/api/embeddings/upsert', 'bearer-token ingest, fails closed'],
    ['/api/webhooks/google', 'channel-token verified'],
    ['/api/worker/claim', 'x-worker-secret, 503 when unset'],
    ['/api/worker/jobs/abc/result', 'x-worker-secret, 503 when unset'],
    ['/api/cron/dispatch-alert', 'x-cron-secret, 503 when unset'],
    ['/api/reports/run', 'x-cron-secret, 503 when unset — the fix'],
    ['/favicon.ico', 'brand asset fetched without a cookie'],
    ['/apple-touch-icon.png', 'iOS home-screen icon'],
    ['/site.webmanifest', 'PWA manifest'],
  ])('%s is excluded (%s)', (path) => {
    expect(isProtected(path)).toBe(false)
  })

  // The exclusion is one route, not the /api/reports prefix. If someone
  // "simplifies" it to `api/reports`, this fails.
  it('excludes the reports runner without un-gating the /api/reports prefix', () => {
    expect(isProtected('/api/reports/run')).toBe(false)
    expect(isProtected('/api/reports')).toBe(true)
    expect(isProtected('/api/reports/history')).toBe(true)
  })
})
