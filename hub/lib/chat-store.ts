import crypto from 'crypto'
import { and, desc, eq, asc } from 'drizzle-orm'
import { db } from './db'
import { chats, chatMessages } from './schema'
import { emit } from './observability'

/**
 * Server-side conversation persistence (Phase 2 of the agy migration).
 *
 * Before this module, chat state lived only in client React state — lost on
 * refresh, invisible to the server, and capped at the last-20 window the
 * client re-POSTs each turn. These helpers make conversations durable so the
 * Hub's "adds memory over raw CLIs" claim is real (see scripts/agy/README.md
 * § Phase 2 remaining scope).
 *
 * CONTRACTS:
 *
 *  - WRITES ARE BEST-EFFORT and never throw into the chat request path (the
 *    same rule as lib/runs.ts and lib/ai-audit.ts): a failed persist emits an
 *    `ai_error` telemetry line and the turn proceeds as if nothing happened.
 *    Chat working > chat remembered.
 *  - OWNERSHIP IS THE SESSION EMAIL. The chat id is client-minted, so a
 *    malicious client could send someone else's uuid: every write verifies
 *    the chat belongs to the caller before appending (a mismatch is dropped,
 *    not an error — no oracle for probing which ids exist), and every read is
 *    WHERE-scoped to the caller.
 *  - IDEMPOTENT APPENDS. User turns keep their client message id, so a retry
 *    of the same POST cannot double-insert (ON CONFLICT DO NOTHING).
 */

const MAX_TITLE_CHARS = 80

/** First-user-message → chat title: whitespace collapsed, bounded. Pure. */
export function deriveChatTitle(content: string): string | null {
  const flat = content.replace(/\s+/g, ' ').trim()
  if (!flat) return null
  return flat.length > MAX_TITLE_CHARS ? `${flat.slice(0, MAX_TITLE_CHARS)}…` : flat
}

function reportPersistFailure(what: string, chatId: string, err: unknown): void {
  emit({
    type: 'ai_error',
    requestId: 'unknown',
    code: 'chat_persist_failed',
    message: `Failed to persist ${what} for chat ${chatId}: ${err instanceof Error ? err.message : 'unknown error'}`,
  })
}

/**
 * Returns the chat row's owner if the chat exists, else null. Used by both
 * write paths to enforce ownership before touching messages.
 */
async function chatOwner(chatId: string): Promise<string | null> {
  const rows = await db.select({ userEmail: chats.userEmail }).from(chats).where(eq(chats.id, chatId)).limit(1)
  return rows[0]?.userEmail ?? null
}

export interface UserTurnInput {
  chatId: string
  userEmail: string
  /** Client message id — the dedupe key for retries. */
  messageId?: string | null
  content: string
}

/**
 * Persist a user turn: create the chat on first sight (title from this
 * message), bump updated_at otherwise, and append the message idempotently.
 * BEST-EFFORT — never throws.
 */
export async function persistUserTurn(input: UserTurnInput): Promise<void> {
  const email = input.userEmail.toLowerCase().trim()
  try {
    const owner = await chatOwner(input.chatId)
    if (owner === null) {
      await db
        .insert(chats)
        .values({ id: input.chatId, userEmail: email, title: deriveChatTitle(input.content) })
        .onConflictDoNothing()
    } else if (owner !== email) {
      // Someone else's chat id — drop silently (no existence oracle).
      return
    } else {
      await db.update(chats).set({ updatedAt: new Date() }).where(eq(chats.id, input.chatId))
    }
    await db
      .insert(chatMessages)
      .values({
        id: input.messageId?.trim() || crypto.randomUUID(),
        chatId: input.chatId,
        role: 'user',
        content: input.content,
      })
      .onConflictDoNothing()
  } catch (err) {
    reportPersistFailure('user turn', input.chatId, err)
  }
}

export interface AssistantTurnInput {
  chatId: string
  userEmail: string
  content: string
  /** Serving model badge (e.g. 'Antigravity', 'Gemini 3.5 Flash'), if known. */
  model?: string | null
}

/**
 * Persist an assistant turn under an existing, owned chat. A missing or
 * foreign chat drops the write (the user turn creates the chat; if that
 * failed, there is nothing consistent to append to). BEST-EFFORT.
 */
export async function persistAssistantTurn(input: AssistantTurnInput): Promise<void> {
  const email = input.userEmail.toLowerCase().trim()
  try {
    const owner = await chatOwner(input.chatId)
    if (owner !== email) return
    await db.insert(chatMessages).values({
      id: crypto.randomUUID(),
      chatId: input.chatId,
      role: 'assistant',
      content: input.content,
      model: input.model?.trim() || null,
    })
    await db.update(chats).set({ updatedAt: new Date() }).where(eq(chats.id, input.chatId))
  } catch (err) {
    reportPersistFailure('assistant turn', input.chatId, err)
  }
}

export interface ChatSummary {
  id: string
  title: string | null
  createdAt: string
  updatedAt: string
}

/** The caller's chats, most recently active first. Reads throw normally —
 *  the API route turns failures into a 500. */
export async function listChats(userEmail: string, limit: number): Promise<ChatSummary[]> {
  const rows = await db
    .select()
    .from(chats)
    .where(eq(chats.userEmail, userEmail.toLowerCase().trim()))
    .orderBy(desc(chats.updatedAt))
    .limit(limit)
  return rows.map((r) => ({
    id: r.id,
    title: r.title ?? null,
    createdAt: r.createdAt instanceof Date ? r.createdAt.toISOString() : String(r.createdAt),
    updatedAt: r.updatedAt instanceof Date ? r.updatedAt.toISOString() : String(r.updatedAt),
  }))
}

export interface StoredChatMessage {
  id: string
  role: string
  content: string
  model: string | null
  createdAt: string
}

/**
 * A chat's messages in insertion order, or null when the chat doesn't exist
 * OR belongs to someone else — indistinguishable by design (the route 404s
 * both, so ids can't be probed).
 */
export async function getChatMessages(chatId: string, userEmail: string): Promise<StoredChatMessage[] | null> {
  const email = userEmail.toLowerCase().trim()
  const owned = await db
    .select({ id: chats.id })
    .from(chats)
    .where(and(eq(chats.id, chatId), eq(chats.userEmail, email)))
    .limit(1)
  if (!owned.length) return null
  const rows = await db.select().from(chatMessages).where(eq(chatMessages.chatId, chatId)).orderBy(asc(chatMessages.seq))
  return rows.map((r) => ({
    id: r.id,
    role: r.role,
    content: r.content,
    model: r.model ?? null,
    createdAt: r.createdAt instanceof Date ? r.createdAt.toISOString() : String(r.createdAt),
  }))
}
