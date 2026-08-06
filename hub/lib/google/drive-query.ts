/**
 * Query planning + ranking for the Documents panel's /api/google/drive route.
 * Lives outside the route file because Next.js route modules may only export
 * handlers, and both helpers need unit tests.
 */

/** Video MIME type exclusions used in Drive queries */
const VIDEO_EXCLUSIONS = [
  "mimeType != 'video/mp4'",
  "mimeType != 'video/quicktime'",
  "mimeType != 'video/x-msvideo'",
  "mimeType != 'video/webm'",
].join(' and ')

/** Result of building a Drive query.
 *  - { query }            → run this query
 *  - { empty: true }      → return an empty file list without calling Drive
 *  - { rankByMyEdits }    → over-fetch and re-rank so the caller's own edits
 *                           come first (see rankByOwnActivity) */
export type DriveQueryPlan = { query?: string; empty?: boolean; rankByMyEdits?: boolean }

/** Build the Drive query plan based on filter type and the active tenant. */
export function buildDriveQuery(
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
      // Custom q (the attach-menu search) is a plain filtered listing.
      if (customQ) return { query: `${customQ} and ${VIDEO_EXCLUSIONS}` }
      // Default "Recent": the docs the USER has been working on. Drive's query
      // language cannot filter on modifiedByMeTime, and plain
      // `modifiedTime desc` ranks by ANYONE's edits — in an active org that
      // buries the user's own documents below other people's churn (the
      // "I don't see any doc I recently worked on" report). So: window by
      // modifiedTime, then re-rank locally by the user's own edit time.
      return {
        query: `modifiedTime > '${sevenDaysAgo}' and ${VIDEO_EXCLUSIONS}`,
        rankByMyEdits: true,
      }
    }
  }
}

/** How many candidates to over-fetch when re-ranking by the user's own edits. */
export const RANK_FETCH_SIZE = 60

/**
 * Order files so the ones the user themself edited come first (newest own-edit
 * first), followed by everything else on plain modifiedTime. Done locally
 * because the Drive API can sort by modifiedByMeTime but cannot filter on it,
 * and its ordering for files never modified by the user is unspecified.
 */
export function rankByOwnActivity<T extends { modifiedTime: string; modifiedByMeTime?: string }>(
  files: T[],
): T[] {
  const mine = files.filter(f => f.modifiedByMeTime)
  const others = files.filter(f => !f.modifiedByMeTime)
  mine.sort((a, b) => (b.modifiedByMeTime as string).localeCompare(a.modifiedByMeTime as string))
  others.sort((a, b) => b.modifiedTime.localeCompare(a.modifiedTime))
  return [...mine, ...others]
}
