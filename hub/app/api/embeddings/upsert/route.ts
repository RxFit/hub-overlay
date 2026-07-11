import { NextRequest, NextResponse } from 'next/server'
import { timingSafeEqual } from 'crypto'
import { eq } from 'drizzle-orm'
import { upsertDocumentChunk, deleteDocumentChunks } from '@/lib/vector-store'
import { db } from '@/lib/db'
import { tenants } from '@/lib/schema'
import { createLogger } from '@/lib/logger'
import { getDefaultTenantId } from '@/lib/tenant-context'

const log = createLogger('embeddings-upsert')

/**
 * Constant-time service-auth check for the `Authorization: Bearer <key>` header.
 *
 * A plain `header !== expected` string compare leaks key material through
 * response-timing; the length guard + timingSafeEqual close that oracle. Fails
 * closed when PAPERCLIP_API_KEY is unset so a misconfigured deploy can't be
 * written to (an empty expected key never matches anything).
 */
function isAuthorized(authHeader: string | null): boolean {
  const expectedKey = process.env.PAPERCLIP_API_KEY
  if (!expectedKey || !authHeader) return false
  const expected = Buffer.from(`Bearer ${expectedKey}`)
  const provided = Buffer.from(authHeader)
  if (expected.length !== provided.length) return false
  try {
    return timingSafeEqual(expected, provided)
  } catch {
    return false
  }
}

/**
 * Validate a body-supplied tenantId against the known set (the `tenants` table)
 * rather than trusting it blindly — the PAPERCLIP_API_KEY holder is a service,
 * not a specific tenant, so an unchecked body value would let it write chunks
 * into an arbitrary tenant. RESIDUAL: this only proves the tenant EXISTS, not
 * that this service call is authorized for it; a true per-tenant service scope
 * (Phase 2 multi-tenancy) still needs to bind the credential to a tenant.
 */
async function isKnownTenant(tenantId: string): Promise<boolean> {
  const rows = await db
    .select({ id: tenants.id })
    .from(tenants)
    .where(eq(tenants.id, tenantId))
    .limit(1)
  return rows.length > 0
}

export async function POST(req: NextRequest) {
  try {
    // Service-to-service auth check (constant-time; fails closed if key unset)
    if (!isAuthorized(req.headers.get('authorization'))) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const body = await req.json()
    const { tenantId, sourceUrl, content } = body

    if (!tenantId || !sourceUrl || !content) {
      return NextResponse.json({ error: 'Missing required fields: tenantId, sourceUrl, content' }, { status: 400 })
    }

    // Don't trust the body's tenantId blindly — it must be a known tenant.
    if (!(await isKnownTenant(tenantId))) {
      return NextResponse.json({ error: 'Unknown tenantId' }, { status: 403 })
    }

    // Guard against excessively large payloads that could exceed embedding model token limits
    const MAX_CONTENT_LENGTH = 10_000
    if (content.length > MAX_CONTENT_LENGTH) {
      log.warn({ contentLength: content.length, max: MAX_CONTENT_LENGTH, sourceUrl },
        'Content exceeds max length — truncating before embedding')
    }
    const safeContent = content.slice(0, MAX_CONTENT_LENGTH)

    const inserted = await upsertDocumentChunk(tenantId, sourceUrl, safeContent)

    log.info({ chunkId: inserted.id }, 'Successfully upserted document chunk embedding')

    return NextResponse.json({ success: true, id: inserted.id }, { status: 200 })
  } catch (err) {
    log.error({ err }, 'Failed to upsert embedding via API')
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 })
  }
}

export async function DELETE(req: NextRequest) {
  try {
    // Service-to-service auth check (constant-time; fails closed if key unset)
    if (!isAuthorized(req.headers.get('authorization'))) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const { searchParams } = new URL(req.url)
    const sourceUrl = searchParams.get('sourceUrl')
    const tenantId = searchParams.get('tenantId') || getDefaultTenantId()

    if (!sourceUrl) {
      return NextResponse.json({ error: 'Missing required query param: sourceUrl' }, { status: 400 })
    }

    await deleteDocumentChunks(tenantId, sourceUrl)

    log.info({ sourceUrl }, 'Successfully deleted document chunks for sourceUrl')

    return NextResponse.json({ success: true }, { status: 200 })
  } catch (err) {
    log.error({ err }, 'Failed to delete chunks via API')
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 })
  }
}
