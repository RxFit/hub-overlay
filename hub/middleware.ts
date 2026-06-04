import { withAuth } from 'next-auth/middleware'
import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'

export default withAuth(
  function middleware(req: NextRequest) {
    const token = (req as any).nextauth?.token
    const role = token?.role as string | undefined
    const pathname = req.nextUrl.pathname

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
     */
    '/((?!login|api/auth|api/chat|_next|favicon\\.svg|static).*)',
  ],
}
