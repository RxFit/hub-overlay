import { semanticChunk } from './chunker'

export interface IngestionResult {
  success: boolean
  chunkIds: string[]
  error?: string
}

/**
 * Splite document text into semantic chunks and sends each chunk individually 
 * to the `/api/embeddings/upsert` endpoint.
 * 
 * @param tenantId Target tenant ID
 * @param sourceUrl Document source URL/identifier
 * @param content Large text document content
 * @param options Configurations for baseUrl, chunkSize, and chunkOverlap
 */
export async function ingestDocument(
  tenantId: string,
  sourceUrl: string,
  content: string,
  options?: {
    baseUrl?: string
    chunkSize?: number
    chunkOverlap?: number
  }
): Promise<IngestionResult> {
  try {
    const apiKey = process.env.PAPERCLIP_API_KEY
    if (!apiKey) {
      throw new Error('PAPERCLIP_API_KEY environment variable is not set')
    }

    const baseUrl = options?.baseUrl ?? process.env.NEXTAUTH_URL ?? 'http://localhost:3000'
    const chunks = semanticChunk(content, options?.chunkSize, options?.chunkOverlap)

    console.log(`[Ingest Client] Split document into ${chunks.length} chunks. Sending to upsert...`)

    // Clear existing chunks for this sourceUrl before inserting new ones
    const clearUrl = `${baseUrl.replace(/\/$/, '')}/api/embeddings/upsert?sourceUrl=${encodeURIComponent(sourceUrl)}&tenantId=${encodeURIComponent(tenantId)}`
    console.log(`[Ingest Client] Clearing existing chunks at ${clearUrl}`)
    const clearRes = await fetch(clearUrl, {
      method: 'DELETE',
      headers: {
        'Authorization': `Bearer ${apiKey}`
      },
      cache: 'no-store'
    })

    if (!clearRes.ok) {
      const errBody = await clearRes.text().catch(() => 'Unknown error')
      console.warn(`[Ingest Client] Warning: Failed to clear old chunks: ${clearRes.status} - ${errBody}`)
    } else {
      console.log(`[Ingest Client] Old chunks cleared successfully.`)
    }

    const chunkIds: string[] = []

    for (let i = 0; i < chunks.length; i++) {
      const chunkText = chunks[i]
      const url = `${baseUrl.replace(/\/$/, '')}/api/embeddings/upsert`

      console.log(`[Ingest Client] Sending chunk ${i + 1}/${chunks.length} (${chunkText.length} chars) to ${url}`)

      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`
        },
        body: JSON.stringify({
          tenantId,
          sourceUrl,
          content: chunkText
        }),
        // Avoid caching webhook requests
        cache: 'no-store'
      })

      if (!res.ok) {
        const errBody = await res.text().catch(() => 'Unknown error')
        throw new Error(`Failed to upsert chunk ${i + 1}: HTTP ${res.status} - ${errBody}`)
      }

      const data = await res.json()
      if (!data.success || !data.id) {
        throw new Error(`Invalid response for chunk ${i + 1}: ${JSON.stringify(data)}`)
      }

      chunkIds.push(data.id)
    }

    return {
      success: true,
      chunkIds
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error'
    console.error('[Ingest Client Error]', err)
    return {
      success: false,
      chunkIds: [],
      error: message
    }
  }
}
