import { GoogleGenerativeAI } from '@google/generative-ai'
import { db } from './db'
import { documentChunks } from './schema'
import { desc, sql } from 'drizzle-orm'
import { createLogger } from './logger'

const log = createLogger('vector-store')

let genAI: GoogleGenerativeAI | null = null

function getGenAI() {
  if (!genAI) {
    genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || '')
  }
  return genAI
}

/**
 * Generate a 768-dimensional embedding using Gemini
 */
export async function generateEmbedding(text: string): Promise<number[]> {
  try {
    const model = getGenAI().getGenerativeModel({ model: 'gemini-embedding-001' })
    const result = await model.embedContent({
      content: { parts: [{ text: text }] },
      outputDimensionality: 768,
    } as any)
    return result.embedding.values
  } catch (err) {
    log.error({ err }, 'Failed to generate embedding')
    throw err
  }
}

/**
 * Perform a semantic search across document chunks using cosine distance
 */
export async function searchSimilarDocuments(tenantId: string, query: string, limit: number = 5) {
  try {
    const queryEmbedding = await generateEmbedding(query)
    
    // Calculate cosine similarity (1 - distance)
    const similarity = sql<number>`1 - (${documentChunks.embedding} <=> ${JSON.stringify(queryEmbedding)}::vector)`
    
    const results = await db
      .select({
        id: documentChunks.id,
        content: documentChunks.content,
        sourceUrl: documentChunks.sourceUrl,
        similarity,
      })
      .from(documentChunks)
      .where(sql`${documentChunks.tenantId} = ${tenantId} AND 1 - (${documentChunks.embedding} <=> ${JSON.stringify(queryEmbedding)}::vector) > 0.65`)
      .orderBy(desc(similarity))
      .limit(limit)

    return results
  } catch (err) {
    log.error({ err }, 'Failed to search similar documents')
    return []
  }
}

/**
 * Embed a chunk of text and insert it into the pgvector database
 */
export async function upsertDocumentChunk(tenantId: string, sourceUrl: string, content: string) {
  try {
    const embedding = await generateEmbedding(content)
    
    const [inserted] = await db
      .insert(documentChunks)
      .values({
        tenantId,
        sourceUrl,
        content,
        embedding,
      })
      .returning()
      
    return inserted
  } catch (err) {
    log.error({ err }, 'Failed to upsert document chunk')
    throw err
  }
}
