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
 * The gemini-embedding family supports ~2048 tokens ≈ 8000 chars conservatively.
 */
const MAX_EMBEDDING_INPUT_CHARS = 8_000

/**
 * Active embedding model + output dimensionality.
 *
 * gemini-embedding-001 reached end-of-life on 2026-07-14; gemini-embedding-2 is
 * its GA successor. The two produce vectors in INCOMPATIBLE spaces, so a stored
 * vector is only comparable to a query vector from the SAME model. We therefore
 * tag every stored row with the model that produced it
 * (document_chunks.embedding_model) and restrict search to rows on the ACTIVE
 * model — a cross-space comparison can never happen, and rows still on the old
 * model stay invisible until the backfill re-embeds them
 * (scripts/reembed-document-chunks.mjs).
 *
 * EMBEDDING_MODEL is overridable so the exact API id can be corrected without a
 * code change. 768 dims — a supported Matryoshka truncation of the model's 3072
 * default — keeps the existing vector(768) column and HNSW cosine index as-is
 * (cosine is scale-invariant, so a truncated vector needs no re-normalization).
 */
export const EMBEDDING_MODEL = process.env.EMBEDDING_MODEL || 'gemini-embedding-2'
export const EMBEDDING_DIMENSIONS = 768

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

    const model = getGenAI().getGenerativeModel({ model: EMBEDDING_MODEL })
    const result = await model.embedContent({
      content: { parts: [{ text: safeText }] },
      outputDimensionality: EMBEDDING_DIMENSIONS,
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
      // Restrict to rows produced by the ACTIVE model: a stored embedding is only
      // comparable to a query vector from the same model, so old-model (and legacy
      // NULL) rows are excluded until the backfill re-embeds them — never a
      // cross-space match.
      .where(sql`${documentChunks.tenantId} = ${tenantId} AND ${documentChunks.embeddingModel} = ${EMBEDDING_MODEL} AND 1 - (${documentChunks.embedding} <=> ${JSON.stringify(queryEmbedding)}::vector) > ${SIMILARITY_THRESHOLD}`)
      .orderBy(desc(similarity))
      .limit(limit)

    return results
  } catch (err) {
    log.error({ err }, 'Failed to search similar documents')
    return []
  }
}

/**
 * Embed a chunk of text and store it in the pgvector database, idempotently.
 *
 * The name promises upsert semantics, but a plain INSERT let repeated ingests
 * of the same (tenantId, sourceUrl, content) accumulate duplicate chunks that
 * all surface in search. We can't clear every chunk for the sourceUrl here —
 * a single document is stored as many chunks sharing one sourceUrl (see
 * ingest-client), so a blanket delete would wipe sibling chunks. Instead we
 * dedupe on the exact chunk: delete any prior row with identical
 * (tenantId, sourceUrl, content) and re-insert with a fresh embedding, in one
 * transaction. Re-ingesting an unchanged chunk stays a single row; distinct
 * chunks of the same document are untouched. First-ingest behaviour is
 * unchanged (nothing to delete).
 */
export async function upsertDocumentChunk(tenantId: string, sourceUrl: string, content: string) {
  try {
    const embedding = await generateEmbedding(content)

    const inserted = await db.transaction(async (tx) => {
      await tx
        .delete(documentChunks)
        .where(
          and(
            eq(documentChunks.tenantId, tenantId),
            eq(documentChunks.sourceUrl, sourceUrl),
            eq(documentChunks.content, content)
          )
        )

      const [row] = await tx
        .insert(documentChunks)
        .values({
          tenantId,
          sourceUrl,
          content,
          embedding,
          embeddingModel: EMBEDDING_MODEL,
        })
        .returning()

      return row
    })

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
