import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { resolveGoogleAuth, googleApiErrorResponse } from '@/lib/google-session'
import { clampInt } from '@/lib/num'
import { listRecentFiles } from '@/lib/google'
import { getTenantConfig } from '@/lib/tenant'
import { buildDriveQuery, rankByOwnActivity, RANK_FETCH_SIZE } from '@/lib/google/drive-query'

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

  const limit = clampInt(maxResults, 15, 1, 100)

  try {
    const files = await listRecentFiles(accessToken, {
      // Re-ranking needs a candidate pool bigger than the page, or the user's
      // own docs get cut before they can be moved to the front.
      maxResults: plan.rankByMyEdits ? Math.max(limit, RANK_FETCH_SIZE) : limit,
      query: plan.query,
      corpora: plan.corpora,
    })
    const ranked = plan.rankByMyEdits ? rankByOwnActivity(files).slice(0, limit) : files
    return NextResponse.json({ files: ranked })
  } catch (error) {
    return googleApiErrorResponse(error)
  }
}
