/**
 * Google Drive push-notification channels (changes.watch) — the mechanism that
 * keeps the semantic index in sync with Drive.
 *
 * Drive delivers push notifications only while a CHANNEL is alive, and
 * channels expire on Google's schedule, not ours. When the original
 * (manually-registered) channel lapsed, the pgvector index silently stopped
 * updating — no error anywhere, documents just stopped appearing in search.
 * These wrappers plus /api/webhooks/google/renew make the channel a managed,
 * self-healing resource instead of a one-off manual setup.
 *
 * All calls run with the SERVICE ACCOUNT token (same identity the webhook
 * ingestor uses to read file content), so what the channel can see is exactly
 * what the index can ingest.
 */

const DRIVE_BASE = 'https://www.googleapis.com/drive/v3'
const TIMEOUT_MS = 15_000

/** Ask for a week; Google clamps to its actual maximum and the RESPONSE's
 *  expiration is what gets stored, so the exact granted TTL never matters. */
export const REQUESTED_TTL_MS = 7 * 24 * 60 * 60 * 1000

/**
 * Renew when less than this remains. The cron fires hourly; the window is
 * several multiples of that so a missed run (deploy, outage) still leaves
 * renewal attempts before the channel actually dies.
 */
export const RENEWAL_WINDOW_MS = 6 * 60 * 60 * 1000

export type ChannelAction = 'bootstrap' | 'renew' | 'healthy'

/**
 * Decide what the renewal pass must do. Pure — the cron route's whole policy
 * in one testable function. An already-expired channel is just 'renew': the
 * stored changes cursor survives, so listing resumes where it stopped and the
 * gap is backfilled.
 */
export function planChannelAction(
  row: { expiration: Date } | null | undefined,
  now: Date = new Date(),
): ChannelAction {
  if (!row) return 'bootstrap'
  if (row.expiration.getTime() - now.getTime() < RENEWAL_WINDOW_MS) return 'renew'
  return 'healthy'
}

async function driveFetch<T>(url: string, accessToken: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      ...init?.headers,
    },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`Drive watch API ${res.status}: ${body.slice(0, 300)}`)
  }
  return res.json() as Promise<T>
}

/** Where to begin listing changes "from now" — used only when no cursor is stored. */
export async function fetchStartPageToken(accessToken: string): Promise<string> {
  const data = await driveFetch<{ startPageToken?: string }>(
    `${DRIVE_BASE}/changes/startPageToken?supportsAllDrives=true`,
    accessToken,
  )
  if (!data.startPageToken) throw new Error('Drive returned no startPageToken')
  return data.startPageToken
}

export interface DriveChannel {
  channelId: string
  resourceId: string
  expiration: Date
}

/**
 * Open a changes.watch channel. Google POSTs to `address` with
 * X-Goog-Channel-Token = `channelToken` (which the webhook route verifies)
 * until `expiration`.
 */
export async function watchChanges(
  accessToken: string,
  opts: {
    channelId: string
    pageToken: string
    address: string
    channelToken: string
    ttlMs?: number
  },
): Promise<DriveChannel> {
  const params = new URLSearchParams({
    pageToken: opts.pageToken,
    supportsAllDrives: 'true',
    includeItemsFromAllDrives: 'true',
  })
  const data = await driveFetch<{ resourceId?: string; expiration?: string }>(
    `${DRIVE_BASE}/changes/watch?${params}`,
    accessToken,
    {
      method: 'POST',
      body: JSON.stringify({
        id: opts.channelId,
        type: 'web_hook',
        address: opts.address,
        token: opts.channelToken,
        expiration: String(Date.now() + (opts.ttlMs ?? REQUESTED_TTL_MS)),
      }),
    },
  )
  if (!data.resourceId) throw new Error('Drive watch response carried no resourceId')
  return {
    channelId: opts.channelId,
    resourceId: data.resourceId,
    // Google answers with the TTL it actually granted (epoch ms as a string).
    expiration: data.expiration ? new Date(Number(data.expiration)) : new Date(Date.now() + 3_600_000),
  }
}

/**
 * Stop a channel. Best-effort by contract: a channel that is already expired
 * or unknown (404) is exactly the state we wanted, so only report, never throw.
 */
export async function stopChannel(
  accessToken: string,
  channelId: string,
  resourceId: string,
): Promise<void> {
  try {
    await driveFetch<unknown>(`${DRIVE_BASE}/channels/stop`, accessToken, {
      method: 'POST',
      body: JSON.stringify({ id: channelId, resourceId }),
    })
  } catch (err) {
    console.warn(`[watch-channels] stopChannel(${channelId}) failed (non-fatal):`, err instanceof Error ? err.message : err)
  }
}

export interface DriveChange {
  fileId: string
  /** File permanently removed (or access lost) — chunks must be deleted. */
  removed: boolean
  /** File moved to trash — treated like removal by the index. */
  trashed: boolean
  mimeType?: string
  name?: string
}

export interface DriveChangeBatch {
  changes: DriveChange[]
  /** Cursor for the NEXT notification — store it after processing. */
  newStartPageToken: string
}

interface ChangesPage {
  changes?: Array<{
    fileId?: string
    removed?: boolean
    file?: { name?: string; mimeType?: string; trashed?: boolean }
  }>
  nextPageToken?: string
  newStartPageToken?: string
}

/** Thrown when Drive rejects the stored cursor — caller resets to a fresh startPageToken. */
export class InvalidPageTokenError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'InvalidPageTokenError'
  }
}

/**
 * List every change since `pageToken`, following pagination to the end.
 * The returned newStartPageToken is the next cursor; Drive guarantees one is
 * present on the final page.
 */
export async function listChanges(accessToken: string, pageToken: string): Promise<DriveChangeBatch> {
  const changes: DriveChange[] = []
  let token = pageToken

  for (;;) {
    const params = new URLSearchParams({
      pageToken: token,
      supportsAllDrives: 'true',
      includeItemsFromAllDrives: 'true',
      pageSize: '100',
      fields: 'changes(fileId,removed,file(name,mimeType,trashed)),nextPageToken,newStartPageToken',
    })
    let page: ChangesPage
    try {
      page = await driveFetch<ChangesPage>(`${DRIVE_BASE}/changes?${params}`, accessToken)
    } catch (err) {
      const msg = err instanceof Error ? err.message : ''
      // Drive answers 400 "Invalid Value" / "pageToken" for a cursor too old
      // to serve. Typed so the caller can reset the cursor instead of failing.
      if (/\b400\b/.test(msg) && /pagetoken|invalid/i.test(msg)) {
        throw new InvalidPageTokenError(msg)
      }
      throw err
    }

    for (const c of page.changes ?? []) {
      if (!c.fileId) continue
      changes.push({
        fileId: c.fileId,
        removed: Boolean(c.removed),
        trashed: Boolean(c.file?.trashed),
        mimeType: c.file?.mimeType,
        name: c.file?.name,
      })
    }

    if (page.nextPageToken) {
      token = page.nextPageToken
      continue
    }
    return {
      changes,
      newStartPageToken: page.newStartPageToken ?? token,
    }
  }
}

const FOLDER_MIME = 'application/vnd.google-apps.folder'

/**
 * Should this change trigger an INGEST? (Deletions/trashings are handled
 * separately — this is only the "read and index it" filter.) Folders have no
 * content; everything else is offered to the ingestor, whose content
 * extraction already skips binaries it cannot text-extract.
 */
export function shouldIngestChange(change: DriveChange): boolean {
  if (change.removed || change.trashed) return false
  return change.mimeType !== FOLDER_MIME
}
