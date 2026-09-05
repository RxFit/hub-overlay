import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { canAccessAdminRoute } from '@/lib/roles'
import { verifyCronSecret } from '@/lib/cron-auth'
import { getServiceAccountAccessToken } from '@/lib/google-auth'
import { getTenantId } from '@/lib/tenant-context'
import {
  planChannelAction,
  fetchStartPageToken,
  watchChanges,
  stopChannel,
  RENEWAL_WINDOW_MS,
} from '@/lib/google/watch-channels'
import { getChannel, saveChannel, DRIVE_CHANGES_KIND } from '@/lib/google/webhook-channels-db'
import { AppError } from '@/lib/errors'
import { withFault } from '@/lib/route-fault'

export const runtime = 'nodejs'

/**
 * POST /api/webhooks/google/renew — keep the Drive push channel alive.
 *
 * Fired HOURLY by Cloud Scheduler (same guard and cadence as /api/reports/run;
 * see docs/runbooks/drive-webhook-channel.md). Drive push channels expire on
 * Google's schedule and, before this existed, expired SILENTLY: the pgvector
 * index just stopped receiving updates, with nothing anywhere saying why. Each
 * firing:
 *
 *   - no stored channel        → bootstrap one from "now" (fresh startPageToken)
 *   - expiring inside the window (or already expired) → register a replacement,
 *     KEEPING the stored changes cursor so any gap is backfilled, then stop the
 *     old channel best-effort
 *   - healthy                  → no-op
 *
 * GET (admin-only) reports the channel's live state, so "is the index still
 * being fed?" has an answer that isn't "wait and see if search goes stale".
 */
export const POST = withFault('webhooks/google/renew', async (req: NextRequest) => {
  const secret = process.env.CRON_SECRET
  if (!secret) {
    return NextResponse.json({ error: 'CRON_SECRET is not configured' }, { status: 503 })
  }
  if (!verifyCronSecret(req.headers.get('x-cron-secret'), secret)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const channelToken = process.env.GOOGLE_WEBHOOK_CHANNEL_TOKEN
  if (!channelToken) {
    // Without the token the webhook route rejects every notification — a
    // channel would be delivering into a wall. Fail loudly instead.
    return NextResponse.json({ error: 'GOOGLE_WEBHOOK_CHANNEL_TOKEN is not configured' }, { status: 503 })
  }

  const baseUrl = process.env.NEXTAUTH_URL
  if (!baseUrl || !baseUrl.startsWith('https://')) {
    // Google only delivers push notifications to HTTPS addresses.
    return NextResponse.json(
      { error: 'NEXTAUTH_URL must be an https:// URL to receive Drive push notifications' },
      { status: 503 },
    )
  }
  const address = `${baseUrl.replace(/\/$/, '')}/api/webhooks/google`

  const accessToken = await getServiceAccountAccessToken('https://www.googleapis.com/auth/drive.readonly')
  if (!accessToken) {
    return NextResponse.json({ error: 'Service account credential unavailable' }, { status: 503 })
  }

  const tenantId = getTenantId()

  try {
    const existing = await getChannel(tenantId, DRIVE_CHANGES_KIND)
    const action = planChannelAction(existing)

    if (action === 'healthy') {
      return NextResponse.json({
        ok: true,
        status: 'healthy',
        channelId: existing!.id,
        expiration: existing!.expiration.toISOString(),
      })
    }

    // Renewal keeps the cursor — the gap since expiry (if any) backfills on
    // the next notification. Only a first-ever bootstrap starts from "now".
    const pageToken = existing?.pageToken ?? (await fetchStartPageToken(accessToken))

    const channel = await watchChanges(accessToken, {
      channelId: crypto.randomUUID(),
      pageToken,
      address,
      channelToken,
    })

    await saveChannel({
      id: channel.channelId,
      tenantId,
      kind: DRIVE_CHANGES_KIND,
      resourceId: channel.resourceId,
      pageToken,
      expiration: channel.expiration,
      address,
    })

    // Stop the superseded channel AFTER its replacement is live — a failed
    // stop means at worst duplicate notifications until it expires on its own.
    if (existing) await stopChannel(accessToken, existing.id, existing.resourceId)

    console.log(
      `[webhook-renew] ${action === 'bootstrap' ? 'Bootstrapped' : 'Renewed'} Drive changes channel ` +
        `${channel.channelId} (expires ${channel.expiration.toISOString()})`,
    )
    return NextResponse.json({
      ok: true,
      status: action === 'bootstrap' ? 'bootstrapped' : 'renewed',
      channelId: channel.channelId,
      expiration: channel.expiration.toISOString(),
    })
  } catch (err) {
    // Renewal talks to Google; a failure here is upstream's, so keep the 502.
    // AppError names the code (statusForCode maps upstream_5xx → 502) and
    // `cause` preserves the original error. The caller is Cloud Scheduler,
    // which reads the status, not the body — and the body used to echo the raw
    // Google error text.
    console.error('[webhook-renew] failed:', err instanceof Error ? err.message : 'unknown error')
    throw new AppError('Drive channel renewal failed', {
      code: 'upstream_5xx',
      cause: err,
      context: { route: 'webhooks/google/renew' },
    })
  }
})

/** Admin diagnostic: is the channel alive, and how long does it have left? */
export const GET = withFault('webhooks/google/renew', async () => {
  const session = await getServerSession(authOptions)
  const user = session?.user as { email?: string | null; role?: string | null } | undefined
  if (!user?.email) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  if (!canAccessAdminRoute(user.role)) {
    return NextResponse.json({ error: 'Forbidden — admin only' }, { status: 403 })
  }

  try {
    const row = await getChannel(getTenantId(), DRIVE_CHANGES_KIND)
    if (!row) {
      return NextResponse.json(
        { configured: false, healthy: false, detail: 'No Drive changes channel registered — the renewal cron has not run yet.' },
        { status: 503 },
      )
    }
    const remainingMs = row.expiration.getTime() - Date.now()
    const healthy = remainingMs > 0
    return NextResponse.json(
      {
        configured: true,
        healthy,
        channelId: row.id,
        expiration: row.expiration.toISOString(),
        remainingMs,
        renewsWithinMs: RENEWAL_WINDOW_MS,
        hasCursor: Boolean(row.pageToken),
        address: row.address,
      },
      { status: healthy ? 200 : 503 },
    )
  } catch (err) {
    const message = err instanceof Error ? err.message : 'unknown error'
    return NextResponse.json({ configured: false, healthy: false, error: message }, { status: 503 })
  }
})
