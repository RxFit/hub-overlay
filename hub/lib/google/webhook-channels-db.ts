/**
 * Webhook channel registry — DB access (SERVER-ONLY).
 *
 * One row per (tenant, kind). The renewal cron upserts here; the webhook
 * route reads the changes cursor and advances it after processing. Mirrors
 * lib/google/prefs-db.ts conventions.
 */

import { and, eq } from 'drizzle-orm'
import { db } from '../db'
import { webhookChannels, tenants } from '../schema'

export const DRIVE_CHANGES_KIND = 'drive-changes'

export interface WebhookChannelRow {
  id: string
  tenantId: string
  kind: string
  resourceId: string
  pageToken: string | null
  expiration: Date
  address: string
}

async function ensureTenant(tenantId: string): Promise<void> {
  await db.insert(tenants).values({ id: tenantId, name: tenantId }).onConflictDoNothing()
}

/** The stored channel for a tenant/kind, or null when none has been registered. */
export async function getChannel(tenantId: string, kind: string): Promise<WebhookChannelRow | null> {
  const [row] = await db
    .select()
    .from(webhookChannels)
    .where(and(eq(webhookChannels.tenantId, tenantId), eq(webhookChannels.kind, kind)))
    .limit(1)
  return row ?? null
}

/**
 * Record a freshly-registered channel. Replaces the previous row for the same
 * (tenant, kind) — after a renewal only the LIVE channel matters; the caller
 * stops the old one with Google separately (best-effort).
 */
export async function saveChannel(row: WebhookChannelRow): Promise<void> {
  await ensureTenant(row.tenantId)
  await db
    .insert(webhookChannels)
    .values({ ...row, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: [webhookChannels.tenantId, webhookChannels.kind],
      set: {
        id: row.id,
        resourceId: row.resourceId,
        pageToken: row.pageToken,
        expiration: row.expiration,
        address: row.address,
        updatedAt: new Date(),
      },
    })
}

/** Advance the changes cursor after a batch has been fully processed. */
export async function updatePageToken(tenantId: string, kind: string, pageToken: string): Promise<void> {
  await db
    .update(webhookChannels)
    .set({ pageToken, updatedAt: new Date() })
    .where(and(eq(webhookChannels.tenantId, tenantId), eq(webhookChannels.kind, kind)))
}
