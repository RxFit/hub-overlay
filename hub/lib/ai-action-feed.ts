/**
 * AI-action → Activity-feed formatter (NS-9).
 *
 * Pure mapping from an `ai_action_log` row (as returned by `listAiActions`)
 * to a `FeedItem` so the user's own AI actions show up as first-class cards
 * in the right-panel Activity feed ("AI sent an email to …").
 *
 * DEFENSIVE CONTRACT:
 *  - NEVER throws — `target` may be null, missing, or any shape at all.
 *  - Metadata-only. Reads a fixed set of known ROUTING scalars from `target`
 *    (recipient/to, space/spaceName, taskId/title) and copies NOTHING else —
 *    a body-like key smuggled into `target` can never leak into a card.
 *    (`lib/ai-audit` already strips body-like keys at write time; this is
 *    defense in depth for rows of unknown provenance.)
 */
import type { FeedItem } from '@/types'
import type { AiActionRecord } from './ai-audit'

/** Read one known key from an arbitrary target as a trimmed non-empty string. */
function targetString(target: unknown, key: string): string | null {
  if (!target || typeof target !== 'object' || Array.isArray(target)) return null
  const v = (target as Record<string, unknown>)[key]
  if (typeof v !== 'string') return null
  const s = v.trim()
  return s.length > 0 ? s : null
}

function firstTargetString(target: unknown, keys: string[]): string | null {
  for (const key of keys) {
    const s = targetString(target, key)
    if (s) return s
  }
  return null
}

/** Success/failed titles per action type; anything unknown gets a generic line. */
function buildTitle(row: AiActionRecord, failed: boolean): string {
  switch (row.actionType) {
    case 'gmail_send': {
      const recipient = firstTargetString(row.target, ['recipient', 'to']) ?? 'a recipient'
      return failed ? `AI email to ${recipient} failed` : `AI sent an email to ${recipient}`
    }
    case 'chat_post': {
      const space = firstTargetString(row.target, ['space', 'spaceName']) ?? 'a chat space'
      return failed ? `AI post in ${space} failed` : `AI posted in ${space}`
    }
    case 'task_create': {
      // `title` is normally stripped by the audit redaction; tolerate either way.
      const title = firstTargetString(row.target, ['title'])
      const taskId = firstTargetString(row.target, ['taskId'])
      if (failed) return 'AI task creation failed'
      if (title) return `AI created task "${title}"`
      if (taskId) return `AI created task ${taskId}`
      return 'AI created a task'
    }
    default:
      return failed ? 'AI action failed' : 'AI performed an action'
  }
}

function buildDescription(row: AiActionRecord, failed: boolean): string {
  const intent = typeof row.intent === 'string' && row.intent.trim() ? row.intent.trim() : null
  const prefix = intent ? `${intent} · ` : ''
  if (!failed) return `${prefix}Completed successfully`
  const reason = typeof row.error === 'string' && row.error.trim() ? ` — ${row.error.trim()}` : ''
  return `${prefix}Failed${reason}`
}

/**
 * Map one audit row to a feed card.
 * success → 'completed'; failed → 'needs_you' (the user may want to retry);
 * any other/unknown status → 'info'.
 */
export function aiActionToFeedItem(row: AiActionRecord): FeedItem {
  const failed = row.status === 'failed'
  const type = row.status === 'success' ? 'completed' as const
    : failed ? 'needs_you' as const
    : 'info' as const

  return {
    id: `ai-${row.id}`,
    source: 'ai_action',
    type,
    title: buildTitle(row, failed),
    description: buildDescription(row, failed),
    timestamp: typeof row.createdAt === 'string' ? row.createdAt : new Date().toISOString(),
    icon: 'sparkles',
    metadata: {
      // actionId lets a card tap attach the row by reference (lib/feed-attachment.ts).
      actionId: row.id,
      actionType: row.actionType,
      status: row.status,
      requestId: row.requestId,
    },
  }
}
