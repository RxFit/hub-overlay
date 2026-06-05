import { NextRequest, NextResponse } from 'next/server'
import { upsertDocumentChunk } from '@/lib/vector-store'
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

    const inserted = await upsertDocumentChunk(tenantId, sourceUrl, content)

    log.info({ chunkId: inserted.id }, 'Successfully upserted document chunk embedding')

    return NextResponse.json({ success: true, id: inserted.id }, { status: 200 })
  } catch (err) {
    log.error({ err }, 'Failed to upsert embedding via API')
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 })
  }
}
