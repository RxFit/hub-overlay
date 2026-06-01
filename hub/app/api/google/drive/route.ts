import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { getToken } from 'next-auth/jwt'
import { authOptions } from '@/lib/auth'
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

  const token = await getToken({ req })
  const accessToken = token?.accessToken as string | undefined
  if (!accessToken) {
    return NextResponse.json({ error: 'No Google access token' }, { status: 401 })
  }

  const { searchParams } = new URL(req.url)
  const maxResults = searchParams.get('maxResults')
  const filter = searchParams.get('filter')
  const customQ = searchParams.get('q') ?? undefined

  const query = buildDriveQuery(filter, customQ)

  try {
    const files = await listRecentFiles(accessToken, {
      maxResults: maxResults ? parseInt(maxResults, 10) : 15,
      query,
    })
    return NextResponse.json({ files })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
