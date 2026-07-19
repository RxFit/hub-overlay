import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { resolveGoogleAuth, googleApiErrorResponse } from '@/lib/google-session'
import { searchContacts, searchDirectoryUsers } from '@/lib/google'

export const runtime = 'nodejs'

export async function GET(req: NextRequest) {
  const session = await getServerSession(authOptions)
  if (!session?.user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const auth = await resolveGoogleAuth(req)
  if (!auth.ok) return auth.response
  const accessToken = auth.accessToken

  const { searchParams } = new URL(req.url)
  const q = searchParams.get('q')
  if (!q) {
    return NextResponse.json({ error: 'Query parameter q is required' }, { status: 400 })
  }

  try {
    const contacts = await searchContacts(accessToken, q)
    const directory = await searchDirectoryUsers(accessToken, q)

    const seen = new Set<string>()
    const results = []

    for (const c of [...contacts, ...directory]) {
      const email = c.email.toLowerCase().trim()
      if (email && !seen.has(email)) {
        seen.add(email)
        results.push(c)
      }
    }

    return NextResponse.json({ contacts: results })
  } catch (error) {
    return googleApiErrorResponse(error)
  }
}
