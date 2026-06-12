import { getToken } from 'next-auth/jwt'
import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'

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

  // Protect /admin route — only admin and superadmin can access
  if (pathname.startsWith('/admin')) {
    if (!role || !['admin', 'superadmin'].includes(role)) {
      return NextResponse.redirect(new URL('/', req.url))
    }
  }

  return NextResponse.next()
}

export const config = {
  // Protect all routes except login, public assets, and auth API
  matcher: [
    /*
     * Match all request paths except:
     * - /login (auth page)
     * - /api/auth (NextAuth endpoints)
     * - /_next (Next.js internals)
     */
    '/((?!login|api/auth|api/chat|api/embeddings|api/webhooks|_next|favicon\\.svg|static).*)',
  ],
}
