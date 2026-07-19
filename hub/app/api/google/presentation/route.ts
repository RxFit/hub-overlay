import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { resolveGoogleAuth, googleApiErrorResponse } from '@/lib/google-session'
import { requireAiGate } from '@/lib/requireGate'
import { GooglePresentationCreateSchema } from '@/lib/zod-schemas'
import { createGooglePresentation } from '@/lib/google'

export const runtime = 'nodejs'

export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions)
  if (!session?.user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const auth = await resolveGoogleAuth(req)
  if (!auth.ok) return auth.response
  const accessToken = auth.accessToken

  const gate = requireAiGate(req.headers, ['create_google_presentation'])
  if (!gate.ok) {
    return NextResponse.json({ error: gate.error }, { status: gate.status })
  }

  let bodyJson: unknown
  try {
    bodyJson = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  const parsed = GooglePresentationCreateSchema.safeParse(bodyJson)
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Validation failed', details: parsed.error.issues },
      { status: 400 }
    )
  }

  const { title, slides } = parsed.data

  try {
    const pres = await createGooglePresentation(accessToken, title, slides || [])
    return NextResponse.json(pres)
  } catch (error) {
    return googleApiErrorResponse(error)
  }
}
