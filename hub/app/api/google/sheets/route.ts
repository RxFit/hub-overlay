import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { getToken } from 'next-auth/jwt'
import { authOptions } from '@/lib/auth'
import { readSheetValues } from '@/lib/google'

export const runtime = 'nodejs'

export async function GET(req: NextRequest) {
  const session = await getServerSession(authOptions)
  if (!session?.user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const token = await getToken({ req })
  const accessToken = token?.accessToken as string | undefined
  if (!accessToken) {
    return NextResponse.json({ error: 'No Google access token' }, { status: 401 })
  }

  const { searchParams } = new URL(req.url)
  const spreadsheetId = searchParams.get('spreadsheetId')
  const range = searchParams.get('range')

  if (!spreadsheetId || !range) {
    return NextResponse.json(
      { error: 'spreadsheetId and range are required query parameters' },
      { status: 400 }
    )
  }

  try {
    const values = await readSheetValues(accessToken, spreadsheetId, range)
    return NextResponse.json({ values })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
