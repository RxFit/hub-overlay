import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { getToken } from 'next-auth/jwt'
import { authOptions } from '@/lib/auth'
import { db } from '@/lib/db'
import { kpis, tenants } from '@/lib/schema'
import { eq, and } from 'drizzle-orm'
import { runAllSources } from '@/lib/kpi-sources'

export const runtime = 'nodejs'

const TENANT_ID = process.env.NEXT_PUBLIC_TENANT_ID || 'rxfit'

/** Ensure the rxfit tenant row exists */
async function ensureTenant() {
  await db
    .insert(tenants)
    .values({ id: TENANT_ID, name: 'RxFit Athletics', domain: 'rxfitatx.com' })
    .onConflictDoNothing()
}

/**
 * POST /api/kpis/sync
 *
 * Fetches live metrics from GA4, Stripe, and Google Search Console,
 * then upserts rows in the `kpis` table.
 *
 * Protected by:
 * - Admin session  (browser-triggered "Sync Now")
 * - CRON_SECRET header  (Railway cron job)
 */
export async function POST(req: NextRequest) {
  // Auth: accept either an admin session OR a valid cron secret
  const cronSecret = process.env.CRON_SECRET
  const cronHeader = req.headers.get('x-cron-secret')
  const isCron = cronSecret && cronHeader === cronSecret

  if (!isCron) {
    const session = await getServerSession(authOptions)
    const role = (session?.user as Record<string, unknown>)?.role as string
    if (!session?.user || (role !== 'admin' && role !== 'superadmin')) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }
  }

  // Get the Google OAuth access token (needed for GA4 + GSC)
  let accessToken: string | undefined
  try {
    const token = await getToken({ req })
    accessToken = token?.accessToken as string | undefined
  } catch {
    // Cron calls won't have a user token — GA4/GSC will be skipped gracefully
    // in the source fetchers when no token is provided
  }

  try {
    await ensureTenant()
    const now = new Date()

    // Run all sources in parallel (each handles its own missing-credential case)
    const { kpis: syncedKPIs, sources } = await runAllSources(accessToken)

    if (syncedKPIs.length === 0) {
      return NextResponse.json({
        synced: 0,
        sources,
        message: 'No credentials configured for any source. Add GA4_PROPERTY_ID, STRIPE_SECRET_KEY, or GSC_SITE_URL to Railway env vars.',
      })
    }

    // Upsert each KPI row using its stable `id` as the unique key
    // The `id` field here is the source-specific identifier (e.g. 'ga4_sessions')
    // stored in `source_config.sourceId` so we can match rows on re-sync
    let upserted = 0
    for (const kpi of syncedKPIs) {
      // Look for an existing row matching this tenant + source + source KPI id
      const [existing] = await db
        .select({ id: kpis.id, value: kpis.value })
        .from(kpis)
        .where(
          and(
            eq(kpis.tenantId, TENANT_ID),
            eq(kpis.source, kpi.source),
          )
        )
        // Filter by sourceConfig.sourceId after fetch (JSONB equality is db-version-sensitive)
        .then(rows => rows.filter(r => {
          // We'll re-read sourceConfig via a separate column match below
          return true  // handled by the sourceId comparison on insert
        }))

      // Compute trend vs previous value
      const prevValue = existing?.value ? parseFloat(existing.value) : null
      const currValue = kpi.rawValue

      // Find exact match by sourceConfig
      const exactMatch = await db
        .select()
        .from(kpis)
        .where(
          and(
            eq(kpis.tenantId, TENANT_ID),
            eq(kpis.source, kpi.source),
            // Match by label as the stable identifier for now
            eq(kpis.label, kpi.label),
          )
        )
        .then(rows => rows[0] ?? null)

      const updateData = {
        value: String(kpi.rawValue),
        trend: kpi.trend,
        trendDirection: kpi.trendDirection,
        unit: kpi.unit ?? null,
        previousValue: exactMatch?.value ?? null,
        lastSyncedAt: now,
        updatedAt: now,
        sourceConfig: { sourceId: kpi.id },
      }

      if (exactMatch) {
        await db.update(kpis).set(updateData).where(eq(kpis.id, exactMatch.id))
      } else {
        await db.insert(kpis).values({
          tenantId: TENANT_ID,
          label: kpi.label,
          source: kpi.source,
          visibility: 'staff',
          scope: 'global',
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
    return NextResponse.json({ error: String(err) }, { status: 500 })
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
      label: kpis.label,
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
