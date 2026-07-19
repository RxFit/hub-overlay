import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { resolveGoogleAuth, googleApiErrorResponse } from '@/lib/google-session'
import { requireAiGate } from '@/lib/requireGate'
import { GoogleSheetCreateSchema } from '@/lib/zod-schemas'
import { createGoogleSheet } from '@/lib/google'

export const runtime = 'nodejs'

export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions)
  if (!session?.user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const auth = await resolveGoogleAuth(req)
  if (!auth.ok) return auth.response
  const accessToken = auth.accessToken

  const gate = requireAiGate(req.headers, ['create_google_sheet'])
  if (!gate.ok) {
    return NextResponse.json({ error: gate.error }, { status: gate.status })
  }

  let bodyJson: unknown
  try {
    bodyJson = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  const parsed = GoogleSheetCreateSchema.safeParse(bodyJson)
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Validation failed', details: parsed.error.issues },
      { status: 400 }
    )
  }

  const { title, values } = parsed.data

  try {
    const sheet = await createGoogleSheet(accessToken, title, values || [])
    return NextResponse.json(sheet)
  } catch (error) {
    return googleApiErrorResponse(error)
  }
}
