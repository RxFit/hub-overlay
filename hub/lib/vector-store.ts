import { GoogleGenerativeAI } from '@google/generative-ai'
import { db } from './db'
import { documentChunks } from './schema'
import { desc, sql, eq, and } from 'drizzle-orm'
import { createLogger } from './logger'

const log = createLogger('vector-store')

/**
 * Minimum cosine similarity score (0–1) a chunk must reach to be included
 * in chat context. Configurable via SIMILARITY_THRESHOLD env var.
 * Default 0.65 balances precision vs. recall for typical corpora.
 */
export const SIMILARITY_THRESHOLD = Number(process.env.SIMILARITY_THRESHOLD) || 0.65

/**
 * Maximum character length accepted by the embedding model.
 * Inputs longer than this are truncated to prevent token-limit errors.
 * gemini-embedding-001 supports ~2048 tokens ≈ 8000 chars conservatively.
 */
const MAX_EMBEDDING_INPUT_CHARS = 8_000

let genAI: GoogleGenerativeAI | null = null

function getGenAI() {
  if (!genAI) {
    const key = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || process.env.GOOGLE_GENERATIVE_AI_API_KEY || ''
    if (!key) {
      throw new Error('No Gemini API key found for embeddings.')
    }
    genAI = new GoogleGenerativeAI(key)
  }
  return genAI
}

/**
 * Generate a 768-dimensional embedding using Gemini
 */
export async function generateEmbedding(text: string): Promise<number[]> {
  try {
    // Guard: truncate excessively long inputs to avoid token-limit errors
    const safeText = text.length > MAX_EMBEDDING_INPUT_CHARS
      ? text.slice(0, MAX_EMBEDDING_INPUT_CHARS)
      : text

    if (safeText.length < text.length) {
      log.warn({ originalLength: text.length, truncatedTo: MAX_EMBEDDING_INPUT_CHARS },
        'Input text truncated before embedding generation')
    }

    const model = getGenAI().getGenerativeModel({ model: 'gemini-embedding-001' })
    const result = await model.embedContent({
      content: { parts: [{ text: safeText }] },
      outputDimensionality: 768,
    } as any)
    return result.embedding.values
  } catch (err) {
    log.error({ err }, 'Failed to generate embedding')
    throw err
  }
}

/**
 * Perform a semantic search across document chunks using cosine distance.
 * Only returns results with similarity > SIMILARITY_THRESHOLD.
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
      .where(sql`${documentChunks.tenantId} = ${tenantId} AND 1 - (${documentChunks.embedding} <=> ${JSON.stringify(queryEmbedding)}::vector) > ${SIMILARITY_THRESHOLD}`)
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

/**
 * Delete all document chunks matching a specific source URL and tenant ID
 */
export async function deleteDocumentChunks(tenantId: string, sourceUrl: string) {
  try {
    await db
      .delete(documentChunks)
      .where(
        and(
          eq(documentChunks.tenantId, tenantId),
          eq(documentChunks.sourceUrl, sourceUrl)
        )
      )
  } catch (err) {
    log.error({ err }, 'Failed to delete document chunks')
    throw err
  }
}
