import { getToken } from 'next-auth/jwt'
import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'
import { canAccessAdminRoute } from '@/lib/roles'
import { safeRequestId } from '@/lib/request-id'

/**
 * Auth middleware (manual token check instead of withAuth).
 *
 * Why not withAuth: its built-in behavior 302-redirects unauthenticated
 * requests to /login — including XHR calls to /api/*, which breaks client
 * error handling (useHubData branches on `status === 401`). Here we return a
 * JSON 401 for API routes and only redirect actual page navigations.
 */
export default async function middleware(req: NextRequest) {
  const pathname = req.nextUrl.pathname
  const isApi = pathname.startsWith('/api')

  // The correlation spine (ERROR_REPORTING_2026-08-24.md Layer 0): one id per
  // request, minted here where middleware runs. An inbound header is honored
  // only when it is exactly a UUID — same posture as the x-tenant-id strip
  // below — so downstream handlers on matched paths can trust it verbatim.
  // Excluded paths (api/chat, api/worker, api/cron/, …) never pass through
  // here; withFault mints its own id there.
  const requestId = safeRequestId(req.headers.get('x-hub-request-id'))

  const token = await getToken({ req })

  // Unauthenticated → 401 for API, redirect to /login for pages. These early
  // returns still carry the request id: the dead-session scenario is exactly
  // the one most worth correlating from a client report.
  if (!token) {
    if (isApi) {
      return NextResponse.json(
        { error: 'Unauthorized' },
        { status: 401, headers: { 'x-hub-request-id': requestId } },
      )
    }
    const loginUrl = new URL('/login', req.url)
    const redirect = NextResponse.redirect(loginUrl)
    redirect.headers.set('x-hub-request-id', requestId)
    return redirect
  }

  const role = token.role as string | undefined

  // Protect /admin route — only admin and superadmin can access (guard predicate
  // is the unit-tested canAccessAdminRoute; behavior is identical to the prior
  // inline check).
  if (pathname.startsWith('/admin')) {
    if (!canAccessAdminRoute(role)) {
      // Carries the request id like every other matched response — a
      // client-reported forbidden redirect must tie back to its server logs.
      const forbidden = NextResponse.redirect(new URL('/', req.url))
      forbidden.headers.set('x-hub-request-id', requestId)
      return forbidden
    }
  }

  // Generate a cryptographically secure random nonce
  const nonce = Buffer.from(crypto.randomUUID()).toString('base64')
  const isDev = process.env.NODE_ENV === 'development'

  // Construct the Content-Security-Policy
  const cspHeader = `
    default-src 'self';
    script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${isDev ? " 'unsafe-eval'" : ''};
    style-src 'self' 'unsafe-inline';
    img-src 'self' blob: data: https:;
    font-src 'self' data:;
    object-src 'none';
    base-uri 'self';
    form-action 'self';
    frame-ancestors 'none';
    connect-src 'self'${isDev ? ' http://localhost:* http://127.0.0.1:* ws://localhost:* ws://127.0.0.1:*' : ''};
    upgrade-insecure-requests;
  `.replace(/\s{2,}/g, ' ').trim()

  const requestHeaders = new Headers(req.headers)
  // SECURITY: strip any client-supplied x-tenant-id so a caller cannot inject a
  // tenant and cross tenant-isolation boundaries. Tenant identity is a
  // server-side signal only; nothing legitimately sets this header today, so
  // getTenantId() falls back to the default tenant (behavior-neutral). Note
  // getTenantId() also ignores this header directly, which covers routes not
  // matched by this middleware (e.g. /api/chat). Phase 2 (multi-tenancy) will
  // set tenant identity from the authenticated session / hostname here — never
  // from an inbound client header.
  requestHeaders.delete('x-tenant-id')
  // Overwrites any inbound value: after this line the header is trustworthy
  // on every middleware-matched path (safeRequestId above already rejected
  // anything that is not exactly a UUID).
  requestHeaders.set('x-hub-request-id', requestId)
  requestHeaders.set('x-nonce', nonce)
  requestHeaders.set('Content-Security-Policy', cspHeader)

  // Pass headers to request and set security headers on response
  const response = NextResponse.next({
    request: {
      headers: requestHeaders,
    },
  })

  response.headers.set('x-hub-request-id', requestId)
  response.headers.set('Content-Security-Policy', cspHeader)
  response.headers.set('X-Frame-Options', 'DENY')
  response.headers.set('X-Content-Type-Options', 'nosniff')
  response.headers.set('Referrer-Policy', 'strict-origin-when-cross-origin')
  response.headers.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains; preload')

  return response
}

export const config = {
  // Protect all routes except login, public assets, and auth API
  matcher: [
    /*
     * Match all request paths except:
     * - /login (auth page)
     * - /api/auth (NextAuth endpoints)
     * - /api/healthz (unauthenticated Cloud Run startup/health probe — must be
     *   reachable without a session so the probe never 401s or redirects)
     * - /_next (Next.js internals)
     * - static brand assets by extension (png/ico/svg/webmanifest). iOS fetches
     *   /apple-touch-icon.png for "Add to Home Screen" WITHOUT the session
     *   cookie; a 307 to /login hands it HTML instead of the PNG, so Safari
     *   silently falls back to a page-screenshot tile. Same for favicon.ico,
     *   the PWA icons, and site.webmanifest (Android/Chrome install icons).
     *   These are public brand images — nothing sensitive ships with these
     *   extensions, and no route handler serves them.
     */
    // - /api/worker (desktop-dispatch machine routes — a worker can never hold
    //   a NextAuth cookie; each handler enforces its own constant-time
    //   x-worker-secret auth and 503s when the secret is unconfigured)
    // - /api/cron/ (scheduler-fired machine routes — same reasoning as
    //   /api/worker; each handler enforces its own constant-time x-cron-secret
    //   auth and 503s when CRON_SECRET is unconfigured. Trailing slash keeps
    //   the exclusion segment-anchored: /api/cronx stays middlewared)
    // - /api/reports/run (the hourly scheduled-reports runner — a cron caller
    //   holds no NextAuth cookie, so this middleware 401'd it before its own
    //   constant-time x-cron-secret check could run, and scheduled digests
    //   never published. Same class as /api/kpis/sync's non-exclusion, which
    //   this repo treats as a live landmine. Deliberately the single route,
    //   NOT the /api/reports prefix: everything else under /api/reports stays
    //   session-protected. NOTE it is a prefix match, so a future route whose
    //   path starts with /api/reports/run (e.g. .../runner) would silently
    //   inherit this exclusion — name it something else, or anchor this.)
    '/((?!login|api/auth|api/chat|api/embeddings|api/webhooks|api/healthz|api/worker|api/reports/run|api/cron/|_next|static|.*\\.(?:png|ico|svg|webmanifest)$).*)',
  ],
}
