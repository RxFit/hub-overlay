import { withAuth } from 'next-auth/middleware'
import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'

export default withAuth(
  function middleware(req: NextRequest) {
    const token = (req as any).nextauth?.token
    const role = token?.role as string | undefined
    const pathname = req.nextUrl.pathname

    // TEMP DIAGNOSTIC — remove after superadmin confirmed
    console.log(`[auth] session callback: token.role="${String(token?.role)}" token.email="${String(token?.email)}"`)

    // Protect /admin route — only admin and superadmin can access
    if (pathname.startsWith('/admin')) {
      if (!role || !['admin', 'superadmin'].includes(role)) {
        return NextResponse.redirect(new URL('/', req.url))
      }
    }

    return NextResponse.next()
  },
  {
    pages: {
      signIn: '/login',
    },
  }
)

export const config = {
  // Protect all routes except login, public assets, and auth API
  matcher: [
    /*
     * Match all request paths except:
     * - /login (auth page)
     * - /api/auth (NextAuth endpoints)
     * - /_next (Next.js internals)
     * - /favicon.svg (public asset)
     * - /static (public assets)
     */
    '/((?!login|api/auth|api/debug-auth|_next|favicon\\.svg|static).*)',
  ],
}
