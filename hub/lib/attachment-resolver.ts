import { fetchUrlContent, fetchDriveDocContent } from '@/lib/content-fetch'
import { searchSemanticBrain } from '@/lib/vertex'
import { fetchUrlWithExa } from '@/lib/exa'
import { withTimeout } from '@/lib/timeout'
import { createLogger } from '@/lib/logger'
import { getAiRun } from '@/lib/runs'
import { getAiAction } from '@/lib/ai-audit'
import { getToolRunOwned } from '@/lib/tool-runs'
import { getTenantId } from '@/lib/tenant-context'
import { canAccessAdminRoute } from '@/lib/roles'
import { formatAiRunRecord, formatAiActionRecord, formatToolRunRecord, formatDispatchAlertRecord } from '@/lib/execution-context'
import { getDispatchAlert } from '@/lib/dispatch-alerts'
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
/**
 * Who is asking — needed only for 'record' attachments, whose resolution is
 * a scoped ledger read (ai_runs is admin-plane; ai_action_log and tool_runs
 * are owner-scoped). Absent scope resolves records to an "unavailable" block,
 * never to another user's row.
 */
export interface AttachmentScope {
  userEmail: string
  role: string | undefined
}

const RECORD_UUID = /^[0-9a-f-]{8,64}$/i

/**
 * A right-panel card tapped into chat. The card carried only its title before
 * this existed, so the model answered "tell me more about Run 89378f4f" from
 * nothing — and reached for the retired Paperclip explanation. Now the row
 * itself is read (provenance only, by ledger contract) and rendered with a
 * short glossary so the model can actually explain it.
 */
async function resolveRecord(att: ChatAttachment, scope: AttachmentScope | undefined): Promise<string> {
  const head = `### Attached Execution Record: "${att.label}"`
  const id = att.recordId ?? ''
  if (!scope || !att.recordKind || !RECORD_UUID.test(id)) {
    return `${head}

[Record reference is incomplete — tell the user the card could not be looked up and invite them to tap it again.]`
  }
  const glossary = RECORD_GLOSSARY[att.recordKind]
  if (att.recordKind === 'ai_run') {
    if (!canAccessAdminRoute(scope.role)) {
      return `${head}

[Model-run details are admin-only. Tell the user an admin can look this run up from the Execution panel.]`
    }
    const run = await getAiRun(id)
    if (!run) return `${head}

[No run with this id exists in the ai_runs ledger any more.]`
    return `${head}

${formatAiRunRecord(run)}

${glossary}`
  }
  if (att.recordKind === 'dispatch_alert') {
    if (!canAccessAdminRoute(scope.role)) {
      return `${head}\n\n[Dispatch alerts are admin-only. Tell the user an admin can look this alert up from the Execution panel.]`
    }
    const alert = await getDispatchAlert(getTenantId(), id)
    if (!alert) return `${head}\n\n[No dispatch alert with this id exists in the event log any more.]`
    return `${head}\n\n${formatDispatchAlertRecord(alert)}\n\n${glossary}`
  }
  if (att.recordKind === 'ai_action') {
    const action = await getAiAction(id, scope.userEmail)
    if (!action) return `${head}

[No AI action with this id exists in the user's own action log.]`
    return `${head}

${formatAiActionRecord(action)}

${glossary}`
  }
  const run = await getToolRunOwned(id, getTenantId(), scope.userEmail)
  if (!run) return `${head}

[No deep run with this id exists for this user.]`
  return `${head}

${formatToolRunRecord(run)}

${glossary}`
}

const RECORD_GLOSSARY: Record<NonNullable<ChatAttachment['recordKind']>, string> = {
  ai_run:
    'What this is: one row of the Hub\'s own ai_runs ledger — a single model call the Hub made (a chat turn, a health probe, or a queued work item). "agy" runs execute on the Antigravity CLI subscription allotment via the desktop worker and cost nothing extra; "gemini"/"claude" runs are metered API calls (the fallback chain). The ledger stores provenance only: prompt size and fingerprint, never prompt or response text — so you cannot quote what was said, only describe the run. Explain the verdict, engine, cost class, latency and tokens in plain business terms; for a failure, explain the error class (auth = worker token needs rotation; timeout = the run exceeded its deadline; empty = agy returned nothing, treated as failure by design) and what to do about it.',
  ai_action:
    'What this is: one row of the user\'s own AI action log — an action the assistant carried out on their behalf after they confirmed it (email sent, task created, chat message posted, inbox focus queue built). The log stores routing metadata only (recipient, space, task id), never message bodies. "Prioritized inbox focus queue" means the Hub re-ranked the user\'s inbox into a focus list; it changed nothing in Gmail. Explain what happened, whether it succeeded, and offer the natural follow-up (retry, open the item, adjust).',
  dispatch_alert:
    'What this is: one row of the Hub\'s dispatch alert history — the hourly cron evaluated the desktop worker, the agy failure streak and the allotment share, found a condition, and recorded it (delivering to Google Chat unless the same condition was already delivered inside the 6h re-alert window). It says the ENGINE had a problem at that time, not that any of the user\'s work was lost: chat kept answering on metered fallbacks. Explain the condition in plain terms, whether it is still current (the Execution Layer section shows the worker\'s state now), and what the owner should do (bring the desktop worker back; rotate the agy token per the agy-gateway runbook).',
  tool_run:
    'What this is: one Deep Research / Deep Think run the user started from the panel. It runs as a queued work item on the desktop worker and lands its report as an artifact. "queued" means still running or waiting for the worker; "failed" carries a typed error class. Explain the state and, if it failed, what the class means and whether re-running is sensible.',
}

async function resolveAttachment(
  att: ChatAttachment,
  lastUserMsg: ChatMessage | undefined,
  accessToken: string | undefined,
  scope: AttachmentScope | undefined,
): Promise<string | null> {
  try {
    if (att.type === 'record') {
      return await resolveRecord(att, scope)
    }
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
  scope?: AttachmentScope,
): Promise<string> {
  if (!attachments || attachments.length === 0) return ''

  const resolvedParts = (
    await Promise.all(
      attachments
        .slice(0, MAX_ATTACHMENTS)
        .map(att => resolveAttachment(att, lastUserMsg, accessToken, scope)),
    )
  ).filter((p): p is string => p !== null)

  if (resolvedParts.length === 0) return ''

  return `## User-Attached Context\n\nThe user has attached the following ${resolvedParts.length} item(s) to their message. Use this content to inform your response.\n\n${resolvedParts.join('\n\n---\n\n')}`
}
