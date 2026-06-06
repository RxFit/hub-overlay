import { db } from './db'
import { toolArtifacts, documentChunks } from './schema'
import { eq, and, desc } from 'drizzle-orm'
import { generateEmbedding } from './vector-store'
import { createLogger } from './logger'

const log = createLogger('tool-artifacts')

/**
 * Insert a new tool artifact and generate a companion document_chunk
 * with a vector embedding for semantic retrieval.
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
  try {
    /* 1. Insert the artifact row */
    const [artifact] = await db
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

    /* 2. Generate an embedding-friendly text representation */
    const chunkContent = `Tool Artifact (${data.toolId}): ${data.title}\n\n${JSON.stringify(data.content)}`

    /* 3. Embed and store in document_chunks for semantic search */
    const embedding = await generateEmbedding(chunkContent)
    await db.insert(documentChunks).values({
      tenantId: data.tenantId,
      sourceUrl: `tool-artifact:${artifact.id}`,
      content: chunkContent,
      embedding,
    })

    log.info({ artifactId: artifact.id, toolId: data.toolId }, 'Tool artifact saved with embedding')
    return artifact
  } catch (err) {
    log.error({ err, toolId: data.toolId }, 'Failed to save tool artifact')
    throw err
  }
}

/**
 * Fetch tool artifacts for a tenant, optionally filtered by toolId.
 * Results are ordered newest-first.
 */
export async function getToolArtifacts(
  tenantId: string,
  toolId?: string,
  limit: number = 20,
) {
  try {
    const conditions = toolId
      ? and(eq(toolArtifacts.tenantId, tenantId), eq(toolArtifacts.toolId, toolId))
      : eq(toolArtifacts.tenantId, tenantId)

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
    const chunkContent = `Tool Artifact (${updated.toolId}): ${displayTitle}\n\n${JSON.stringify(content)}`
    const embedding = await generateEmbedding(chunkContent)

    await db
      .update(documentChunks)
      .set({ content: chunkContent, embedding })
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
