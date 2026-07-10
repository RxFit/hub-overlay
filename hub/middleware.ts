import { getToken } from 'next-auth/jwt'
import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'
import { canAccessAdminRoute } from '@/lib/roles'

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

  const token = await getToken({ req })

  // Unauthenticated → 401 for API, redirect to /login for pages
  if (!token) {
    if (isApi) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }
    const loginUrl = new URL('/login', req.url)
    return NextResponse.redirect(loginUrl)
  }

  const role = token.role as string | undefined

  // Protect /admin route — only admin and superadmin can access (guard predicate
  // is the unit-tested canAccessAdminRoute; behavior is identical to the prior
  // inline check).
  if (pathname.startsWith('/admin')) {
    if (!canAccessAdminRoute(role)) {
      return NextResponse.redirect(new URL('/', req.url))
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
  requestHeaders.set('x-nonce', nonce)
  requestHeaders.set('Content-Security-Policy', cspHeader)

  // Pass headers to request and set security headers on response
  const response = NextResponse.next({
    request: {
      headers: requestHeaders,
    },
  })

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
     */
    '/((?!login|api/auth|api/chat|api/embeddings|api/webhooks|api/healthz|_next|favicon\\.svg|static).*)',
  ],
}
