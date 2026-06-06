import { NextRequest, NextResponse } from 'next/server'
import { upsertDocumentChunk, deleteDocumentChunks } from '@/lib/vector-store'
import { createLogger } from '@/lib/logger'

const log = createLogger('embeddings-upsert')

export async function POST(req: NextRequest) {
  try {
    // Service-to-service auth check
    const authHeader = req.headers.get('authorization')
    const expectedKey = process.env.PAPERCLIP_API_KEY
    if (!expectedKey || authHeader !== `Bearer ${expectedKey}`) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const body = await req.json()
    const { tenantId, sourceUrl, content } = body

    if (!tenantId || !sourceUrl || !content) {
      return NextResponse.json({ error: 'Missing required fields: tenantId, sourceUrl, content' }, { status: 400 })
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
    // Service-to-service auth check
    const authHeader = req.headers.get('authorization')
    const expectedKey = process.env.PAPERCLIP_API_KEY
    if (!expectedKey || authHeader !== `Bearer ${expectedKey}`) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const { searchParams } = new URL(req.url)
    const sourceUrl = searchParams.get('sourceUrl')
    const tenantId = searchParams.get('tenantId') || process.env.NEXT_PUBLIC_TENANT_ID || 'rxfit'

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
