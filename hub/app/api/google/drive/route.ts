import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { resolveGoogleAuth, googleApiErrorResponse } from '@/lib/google-session'
import { clampInt } from '@/lib/num'
import { listRecentFiles } from '@/lib/google'

export const runtime = 'nodejs'

/** Video MIME type exclusions used in Drive queries */
const VIDEO_EXCLUSIONS = [
  "mimeType != 'video/mp4'",
  "mimeType != 'video/quicktime'",
  "mimeType != 'video/x-msvideo'",
  "mimeType != 'video/webm'",
].join(' and ')

/** Build the Drive query string based on filter type */
function buildDriveQuery(filter: string | null, customQ?: string): string | undefined {
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString()

  switch (filter) {
    case 'shared':
      return `sharedWithMe = true and modifiedTime > '${sevenDaysAgo}' and ${VIDEO_EXCLUSIONS}`

    case 'transcripts':
      return `'1PQ47SWRWn-A1dToniwglJy9uqEwZSVwA' in parents`

    case 'recent':
    default: {
      // Default "recent" query: files I modified, excluding videos
      const base = customQ
        ? `${customQ} and ${VIDEO_EXCLUSIONS}`
        : `modifiedTime > '${sevenDaysAgo}' and ${VIDEO_EXCLUSIONS}`
      return base
    }
  }
}

export async function GET(req: NextRequest) {
  const session = await getServerSession(authOptions)
  if (!session?.user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const auth = await resolveGoogleAuth(req)
  if (!auth.ok) return auth.response
  const accessToken = auth.accessToken

  const { searchParams } = new URL(req.url)
  const maxResults = searchParams.get('maxResults')
  const filter = searchParams.get('filter')
  const customQ = searchParams.get('q') ?? undefined

  const query = buildDriveQuery(filter, customQ)

  try {
    const files = await listRecentFiles(accessToken, {
      maxResults: clampInt(maxResults, 15, 1, 100),
      query,
    })
    return NextResponse.json({ files })
  } catch (error) {
    return googleApiErrorResponse(error)
  }
}
