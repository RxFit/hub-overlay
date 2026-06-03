import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { getToken } from 'next-auth/jwt'
import { authOptions } from '@/lib/auth'
import { db } from '@/lib/db'
import { kpis, tenants } from '@/lib/schema'
import { eq, and, inArray } from 'drizzle-orm'
import { timingSafeEqual } from 'crypto'
import { runAllSources } from '@/lib/kpi-sources'

export const runtime = 'nodejs'

const TENANT_ID = process.env.NEXT_PUBLIC_TENANT_ID || 'rxfit'

/** Ensure the rxfit tenant row exists */
async function ensureTenant() {
  await db
    .insert(tenants)
    .values({ id: TENANT_ID, name: 'RxFit Athletics', domain: 'rxfit.co' })
    .onConflictDoNothing()
}

/** Constant-time cron secret comparison — prevents timing oracle attacks */
function verifyCronSecret(header: string | null, secret: string): boolean {
  if (!header) return false
  try {
    const a = Buffer.from(header)
    const b = Buffer.from(secret)
    if (a.length !== b.length) return false
    return timingSafeEqual(a, b)
  } catch {
    return false
  }
}

/**
 * POST /api/kpis/sync
 *
 * Fetches live metrics from GA4, Stripe, and Google Search Console,
 * then upserts rows in the `kpis` table using stable sourceId keys.
 *
 * Protected by:
 * - Admin session  (browser-triggered "Sync Now")
 * - CRON_SECRET header  (Railway cron job — constant-time comparison)
 */
export async function POST(req: NextRequest) {
  // Auth: accept either an admin session OR a valid cron secret (timing-safe)
  const cronSecret = process.env.CRON_SECRET
  const isCron = cronSecret
    ? verifyCronSecret(req.headers.get('x-cron-secret'), cronSecret)
    : false

  if (!isCron) {
    const session = await getServerSession(authOptions)
    const role = (session?.user as Record<string, unknown>)?.role as string
    if (!session?.user || (role !== 'admin' && role !== 'superadmin')) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }
  }

  // Get the Google OAuth access token (needed for GA4 + GSC)
  // Note: cron calls have no user session, so GA4/GSC will be skipped gracefully.
  // To sync GA4 + GSC via cron, a service account SA key is needed (future work).
  let accessToken: string | undefined
  try {
    const token = await getToken({ req })
    accessToken = token?.accessToken as string | undefined
  } catch {
    // No token available (cron path) — Stripe-only sync will proceed
  }

  try {
    await ensureTenant()
    const now = new Date()

    // Run all sources in parallel (each handles its own missing-credential case)
    const { kpis: syncedKPIs, sources } = await runAllSources(accessToken)

    // Annotate which sources were skipped due to missing access token
    if (!accessToken) {
      if (sources.ga4.count === 0 && !sources.ga4.error) {
        sources.ga4 = { ok: false, count: 0, error: 'No access token — re-auth required for GA4' }
      }
      if (sources.gsc.count === 0 && !sources.gsc.error) {
        sources.gsc = { ok: false, count: 0, error: 'No access token — re-auth required for GSC' }
      }
    }

    if (syncedKPIs.length === 0) {
      return NextResponse.json({
        synced: 0,
        sources,
        message: 'No credentials configured for any source. Add GA4_PROPERTY_ID, STRIPE_SECRET_KEY, or GSC_SITE_URL to Railway env vars.',
      })
    }

    // ── Batch lookup: fetch ALL existing rows for this tenant + these sources ──
    // Single DB round-trip instead of N+2 per KPI
    const sourceIds = syncedKPIs.map(k => k.id)
    const existingRows = await db
      .select()
      .from(kpis)
      .where(
        and(
          eq(kpis.tenantId, TENANT_ID),
          inArray(kpis.source, Array.from(new Set(syncedKPIs.map(k => k.source))) as string[]),
        )
      )

    // Index existing rows by sourceConfig.sourceId for O(1) lookup
    const existingBySourceId = new Map<string, typeof existingRows[0]>()
    for (const row of existingRows) {
      const sid = (row.sourceConfig as Record<string, unknown> | null)?.sourceId as string | undefined
      if (sid) existingBySourceId.set(sid, row)
    }

    // ── Upsert loop — one write per KPI ──
    let upserted = 0
    for (const kpi of syncedKPIs) {
      // Round raw value to 2dp before storage
      const roundedValue = Math.round(kpi.rawValue * 100) / 100

      const exactMatch = existingBySourceId.get(kpi.id) ?? null

      const updateData = {
        value:         String(roundedValue),
        trend:         kpi.trend,
        trendDirection: kpi.trendDirection,
        unit:          kpi.unit ?? null,
        previousValue: exactMatch?.value ?? null,   // previous value for trend display
        lastSyncedAt:  now,
        updatedAt:     now,
        sourceConfig:  { sourceId: kpi.id },        // stable dedup key
      }

      if (exactMatch) {
        await db
          .update(kpis)
          .set(updateData)
          .where(and(eq(kpis.id, exactMatch.id), eq(kpis.tenantId, TENANT_ID)))
      } else {
        await db.insert(kpis).values({
          tenantId:  TENANT_ID,
          label:     kpi.label,
          source:    kpi.source,
          visibility: 'staff',
          scope:     'global',
          ...updateData,
        })
      }
      upserted++
    }

    return NextResponse.json({
      synced: upserted,
      sources,
      syncedAt: now.toISOString(),
    })

  } catch (err) {
    console.error('[kpis/sync] Error:', err)
    // Do NOT include raw error string in response — may expose env context
    const message = err instanceof Error ? err.message : 'Internal sync error'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}

/**
 * GET /api/kpis/sync
 * Returns last sync timestamps per source for the settings UI.
 */
export async function GET(req: NextRequest) {
  const session = await getServerSession(authOptions)
  if (!session?.user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const rows = await db
    .select({
      source: kpis.source,
      lastSyncedAt: kpis.lastSyncedAt,
    })
    .from(kpis)
    .where(eq(kpis.tenantId, TENANT_ID))

  // Group by source, return latest sync time per source
  const bySource: Record<string, string | null> = {}
  for (const row of rows) {
    const src = row.source ?? 'manual'
    const existing = bySource[src]
    if (!existing || (row.lastSyncedAt && row.lastSyncedAt.toISOString() > existing)) {
      bySource[src] = row.lastSyncedAt?.toISOString() ?? null
    }
  }

  return NextResponse.json({ lastSync: bySource })
}
