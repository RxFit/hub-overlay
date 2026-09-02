import { db } from './db'
import { toolArtifacts, documentChunks } from './schema'
import { eq, and, desc, sql } from 'drizzle-orm'
import { generateEmbedding, EMBEDDING_MODEL } from './vector-store'
import { createLogger } from './logger'

const log = createLogger('tool-artifacts')

/** The embedding-friendly text representation of an artifact. */
function artifactChunkText(toolId: string, title: string, content: unknown): string {
  return `Tool Artifact (${toolId}): ${title}\n\n${JSON.stringify(content)}`
}

/**
 * Embed an already-saved artifact into document_chunks for semantic
 * retrieval. BEST-EFFORT BY CONTRACT: never throws. An artifact that can't
 * be embedded right now (no Gemini key, model outage, vector extension
 * missing) is still an artifact the user can open from the Artifacts tab —
 * it just isn't semantically searchable until re-embedded. Returns whether
 * the chunk was written so callers can log the truth.
 */
export async function embedToolArtifact(artifact: {
  id: string
  tenantId: string
  toolId: string
  title: string
  content: unknown
}): Promise<boolean> {
  try {
    const chunkContent = artifactChunkText(artifact.toolId, artifact.title, artifact.content)
    const embedding = await generateEmbedding(chunkContent)
    await db.insert(documentChunks).values({
      tenantId: artifact.tenantId,
      sourceUrl: `tool-artifact:${artifact.id}`,
      content: chunkContent,
      embedding,
      embeddingModel: EMBEDDING_MODEL,
    })
    return true
  } catch (err) {
    log.warn({ err, artifactId: artifact.id }, 'Tool artifact saved without an embedding — not semantically searchable until re-embedded')
    return false
  }
}

/**
 * Insert a new tool artifact and generate a companion document_chunk
 * with a vector embedding for semantic retrieval.
 *
 * The row insert is the operation that can fail this call. The embedding
 * used to be in the same try — so a Gemini hiccup AFTER the insert reported
 * failure to the caller while the row silently existed (the panel showed
 * nothing saved; the Artifacts tab showed the row). Now the row is the
 * result and the embedding is best-effort (embedToolArtifact).
 */
export async function saveToolArtifact(data: {
  tenantId: string
  toolId: string
  chatId?: string
  title: string
  content: any
  contextSummary?: string
  createdBy?: string
}) {
  let artifact: typeof toolArtifacts.$inferSelect
  try {
    ;[artifact] = await db
      .insert(toolArtifacts)
      .values({
        tenantId: data.tenantId,
        toolId: data.toolId,
        chatId: data.chatId ?? null,
        title: data.title,
        content: data.content,
        contextSummary: data.contextSummary ?? null,
        createdBy: data.createdBy ?? null,
        status: 'active',
      })
      .returning()
  } catch (err) {
    log.error({ err, toolId: data.toolId }, 'Failed to save tool artifact')
    throw err
  }

  const embedded = await embedToolArtifact({
    id: artifact.id,
    tenantId: data.tenantId,
    toolId: data.toolId,
    title: data.title,
    content: data.content,
  })
  log.info({ artifactId: artifact.id, toolId: data.toolId, embedded }, 'Tool artifact saved')
  return artifact
}

/**
 * Owner identity for artifacts is an email, and emails are compared
 * case-insensitively everywhere in the Hub (tool_runs stores them lowercased;
 * a Google session may carry mixed case). Every createdBy comparison goes
 * through here so a report auto-saved at landing under the run's lowercased
 * owner is still THAT user's artifact when their session email says
 * "Danny@…".
 */
export function normalizeArtifactOwner(email: string | null | undefined): string {
  return (email ?? '').trim().toLowerCase()
}

/** True when `createdBy` (as stored) belongs to the caller identified by `email`. */
export function isArtifactOwner(createdBy: string | null | undefined, email: string | null | undefined): boolean {
  const owner = normalizeArtifactOwner(createdBy)
  return owner !== '' && owner === normalizeArtifactOwner(email)
}

/**
 * Fetch tool artifacts for a tenant, optionally filtered by toolId.
 * Results are ordered newest-first.
 */
export async function getToolArtifacts(
  tenantId: string,
  toolId?: string,
  limit: number = 20,
  createdBy?: string,
) {
  try {
    const filters = [
      eq(toolArtifacts.tenantId, tenantId),
      eq(toolArtifacts.status, 'active'),
    ]
    if (toolId) filters.push(eq(toolArtifacts.toolId, toolId))
    // When createdBy is provided, scope results to that author (non-admin
    // callers) — case-insensitively, see normalizeArtifactOwner.
    if (createdBy) filters.push(sql`lower(${toolArtifacts.createdBy}) = ${normalizeArtifactOwner(createdBy)}`)
    const conditions = and(...filters)

    const rows = await db
      .select()
      .from(toolArtifacts)
      .where(conditions)
      .orderBy(desc(toolArtifacts.updatedAt))
      .limit(limit)

    return rows
  } catch (err) {
    log.error({ err, tenantId, toolId }, 'Failed to fetch tool artifacts')
    throw err
  }
}

/**
 * Fetch a single tool artifact by primary key.
 */
export async function getToolArtifact(id: string) {
  try {
    const [row] = await db
      .select()
      .from(toolArtifacts)
      .where(eq(toolArtifacts.id, id))
      .limit(1)

    return row ?? null
  } catch (err) {
    log.error({ err, artifactId: id }, 'Failed to fetch tool artifact')
    throw err
  }
}

/**
 * Update an artifact's content (and optionally title), refresh its
 * updatedAt timestamp, and re-embed the companion document chunk.
 */
export async function updateToolArtifact(
  id: string,
  content: any,
  title?: string,
) {
  try {
    const updateData: Record<string, unknown> = {
      content,
      updatedAt: new Date(),
    }
    if (title !== undefined) {
      updateData.title = title
    }

    const [updated] = await db
      .update(toolArtifacts)
      .set(updateData)
      .where(eq(toolArtifacts.id, id))
      .returning()

    if (!updated) return null

    /* Re-embed the document chunk tied to this artifact */
    const displayTitle = title ?? updated.title
    const chunkContent = artifactChunkText(updated.toolId, displayTitle, content)
    const embedding = await generateEmbedding(chunkContent)

    await db
      .update(documentChunks)
      .set({ content: chunkContent, embedding, embeddingModel: EMBEDDING_MODEL })
      .where(eq(documentChunks.sourceUrl, `tool-artifact:${id}`))

    log.info({ artifactId: id }, 'Tool artifact updated with re-embedding')
    return updated
  } catch (err) {
    log.error({ err, artifactId: id }, 'Failed to update tool artifact')
    throw err
  }
}

/**
 * Soft-delete an artifact by setting its status to 'archived'.
 */
export async function archiveToolArtifact(id: string) {
  try {
    const [archived] = await db
      .update(toolArtifacts)
      .set({ status: 'archived', updatedAt: new Date() })
      .where(eq(toolArtifacts.id, id))
      .returning()

    if (!archived) return null

    log.info({ artifactId: id }, 'Tool artifact archived')
    return archived
  } catch (err) {
    log.error({ err, artifactId: id }, 'Failed to archive tool artifact')
    throw err
  }
}
