import { fetchUrlContent, fetchDriveDocContent } from '@/lib/content-fetch'
import { searchSemanticBrain } from '@/lib/vertex'
import { fetchUrlWithExa } from '@/lib/exa'
import { withTimeout } from '@/lib/timeout'
import { createLogger } from '@/lib/logger'
import type { ChatAttachment, ChatMessage } from '@/types'

const log = createLogger('attachment-resolver')

// Cap the number of attachments resolved per request (cost/latency guard).
const MAX_ATTACHMENTS = 5

/**
 * Resolves a single attachment into an injected-context block.
 *
 * Returns `null` for an attachment that matches no handled shape (e.g. a
 * document with no fileId) — those contribute no block, matching the original
 * inline behaviour. On any thrown error the item degrades to a "[Failed to load
 * content]" block so a single bad attachment never rejects the whole batch.
 */
async function resolveAttachment(
  att: ChatAttachment,
  lastUserMsg: ChatMessage | undefined,
  accessToken: string | undefined,
): Promise<string | null> {
  try {
    if (att.type === 'text' && att.content) {
      // Direct text — use as-is
      return `### Attached Text: "${att.label}"\n\n${att.content.slice(0, 16_000)}`
    } else if (att.type === 'url' && att.url) {
      // Try Exa.AI first (handles JS-heavy pages), fall back to raw fetch
      let urlText: string | undefined
      try {
        urlText = await fetchUrlWithExa(att.url)
      } catch {
        // Exa unavailable or failed
      }
      if (!urlText?.trim()) {
        urlText = await fetchUrlContent(att.url)
      }
      return `### Attached URL: ${att.url}\n\n${urlText}`
    } else if (att.type === 'document' && att.fileId) {
      // Vertex AI semantic search first (token-efficient), Drive API fallback
      let docText: string | null = null

      // Attempt Vertex AI semantic search for the document.
      // Datastore is env-configurable (P0-4); should become tenant-derived
      // with the per-tenant work (P0-3) rather than a single shared store.
      if (lastUserMsg) {
        const vertexResults = await withTimeout(
          searchSemanticBrain(
            `${lastUserMsg.content} ${att.label}`,
            process.env.VERTEX_DATA_STORE_ID || 'rxfit-gdrive'
          ),
          6_000,
          null,
          'attachment-vertex',
        )
        if (vertexResults && vertexResults.length > 0) {
          docText = vertexResults
            .map(r => `**${r.title}**\n${r.snippet}`)
            .join('\n\n---\n\n')
          docText = `[Retrieved via Semantic Brain]\n\n${docText}`
        }
      }

      // Fallback: direct Drive API export
      if (!docText && accessToken) {
        docText = await fetchDriveDocContent(accessToken, att.fileId, att.mimeType)
      }

      if (!docText && !accessToken) {
        log.warn({ label: att.label, fileId: att.fileId }, 'Document attachment unresolved: no Google access token')
      }

      const docFallback = !accessToken
        ? '[Unable to retrieve document content: your Google session has no valid access token (it may be missing or expired). Ask the user to sign out and sign back in to re-grant Google Drive access.]'
        : '[Unable to retrieve document content]'

      return `### Attached Document: "${att.label}"\n\n${docText ?? docFallback}`
    }
    return null
  } catch (err) {
    log.error({ err, label: att.label }, 'Failed to resolve attachment')
    return `### Attached: "${att.label}"\n\n[Failed to load content]`
  }
}

/**
 * Resolves up to MAX_ATTACHMENTS attachments into a single injected-context
 * string for the system prompt.
 *
 * The attachments are independent, so they resolve CONCURRENTLY via Promise.all.
 * Array order (and therefore the order of the injected blocks) is preserved, and
 * per-item error isolation lives in resolveAttachment — one failing item cannot
 * fail-fast the whole batch. This is a pure concurrency refactor of the former
 * inline sequential loop: same blocks, same order, same fallback text.
 */
export async function resolveAttachmentContext(
  attachments: ChatAttachment[] | undefined,
  lastUserMsg: ChatMessage | undefined,
  accessToken: string | undefined,
): Promise<string> {
  if (!attachments || attachments.length === 0) return ''

  const resolvedParts = (
    await Promise.all(
      attachments
        .slice(0, MAX_ATTACHMENTS)
        .map(att => resolveAttachment(att, lastUserMsg, accessToken)),
    )
  ).filter((p): p is string => p !== null)

  if (resolvedParts.length === 0) return ''

  return `## User-Attached Context\n\nThe user has attached the following ${resolvedParts.length} item(s) to their message. Use this content to inform your response.\n\n${resolvedParts.join('\n\n---\n\n')}`
}
