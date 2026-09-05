import type { ChatAttachment, ChatRecordKind, FeedItem } from '@/types'

/**
 * lib/feed-attachment.ts — what a right-panel card tap sends into chat.
 *
 * Before Phase 4 a tap injected only `Tell me more about: ${title}`; the model
 * had the card's title and nothing else, so it improvised (and reached for the
 * retired Paperclip explanation). Now the tap carries the row BY REFERENCE as
 * a 'record' attachment, and the chat route resolves it server-side inside the
 * caller's own scope (lib/attachment-resolver.ts). The client never carries
 * the record's content — that is why this is a reference, not a text blob.
 *
 * Pure, so the wiring is unit-testable without a React renderer (the same
 * reason lib/panel-inject.ts exists for the left panel).
 */

const RECORD_KIND_BY_SOURCE: Record<string, { kind: ChatRecordKind; idKey: string }> = {
  run: { kind: 'ai_run', idKey: 'runId' },
  ai_action: { kind: 'ai_action', idKey: 'actionId' },
}

/** The structural subset of FeedItem this module reads — accepts both the
 *  canonical `types/index.ts` shape and the hook-side copy in useHubData. */
export type FeedCardLike = Pick<FeedItem, 'id' | 'title' | 'type'> & {
  source: string
  metadata?: Record<string, unknown>
}

/** The record attachment for a card, or null when the card is not backed by a ledger row. */
export function feedItemToAttachment(item: FeedCardLike): ChatAttachment | null {
  const spec = RECORD_KIND_BY_SOURCE[item.source]
  if (!spec) return null
  const raw = item.metadata?.[spec.idKey]
  if (typeof raw !== 'string' || raw.length === 0) return null
  return {
    id: `record-${item.id}`,
    type: 'record',
    label: item.title,
    recordKind: spec.kind,
    recordId: raw,
  }
}

/**
 * The message a tap sends. Kept on the read-style "Tell me more about: …"
 * form the inject router expects (lib/inject-routing.ts), with an explicit
 * ask so the model explains rather than restates the title.
 */
export function buildFeedInjectMessage(item: FeedCardLike): string {
  const failed = item.type === 'needs_you'
  const ask = failed
    ? 'What happened, why did it fail, and what should I do about it?'
    : 'What did this do, and is there anything I should follow up on?'
  return `Tell me more about: ${item.title}\n\n${ask}`
}
