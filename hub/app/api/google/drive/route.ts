import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { resolveGoogleAuth, googleApiErrorResponse } from '@/lib/google-session'
import { clampInt } from '@/lib/num'
import { listRecentFiles } from '@/lib/google'
import { getTenantConfig } from '@/lib/tenant'

export const runtime = 'nodejs'

/** Video MIME type exclusions used in Drive queries */
const VIDEO_EXCLUSIONS = [
  "mimeType != 'video/mp4'",
  "mimeType != 'video/quicktime'",
  "mimeType != 'video/x-msvideo'",
  "mimeType != 'video/webm'",
].join(' and ')

/** Result of building a Drive query.
 *  - { query }            → run this query
 *  - { empty: true }      → return an empty file list without calling Drive */
type DriveQueryPlan = { query?: string; empty?: boolean }

/** Build the Drive query plan based on filter type and the active tenant. */
function buildDriveQuery(
  filter: string | null,
  customQ: string | undefined,
  transcriptsFolderId: string | undefined,
): DriveQueryPlan {
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString()

  switch (filter) {
    case 'shared':
      return { query: `sharedWithMe = true and modifiedTime > '${sevenDaysAgo}' and ${VIDEO_EXCLUSIONS}` }

    case 'transcripts':
      // Per-tenant folder; no hardcoded id. Unconfigured → empty (no cross-tenant leak).
      if (!transcriptsFolderId) return { empty: true }
      return { query: `'${transcriptsFolderId}' in parents and ${VIDEO_EXCLUSIONS}` }

    case 'recent':
    default: {
      // Default "recent" query: files I modified, excluding videos
      const base = customQ
        ? `${customQ} and ${VIDEO_EXCLUSIONS}`
        : `modifiedTime > '${sevenDaysAgo}' and ${VIDEO_EXCLUSIONS}`
      return { query: base }
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

  // Per-tenant transcripts folder: env override wins, then tenant config. No hardcoded id.
  const transcriptsFolderId =
    process.env.DRIVE_TRANSCRIPTS_FOLDER_ID || getTenantConfig().transcriptsFolderId

  const plan = buildDriveQuery(filter, customQ, transcriptsFolderId)

  // Transcripts requested but no folder configured for this tenant → clean empty result.
  if (plan.empty) {
    return NextResponse.json({ files: [] })
  }

  try {
    const files = await listRecentFiles(accessToken, {
      maxResults: clampInt(maxResults, 15, 1, 100),
      query: plan.query,
    })
    return NextResponse.json({ files })
  } catch (error) {
    return googleApiErrorResponse(error)
  }
}
