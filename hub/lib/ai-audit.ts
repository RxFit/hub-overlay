/**
 * AI-action audit trail (NS-2).
 *
 * Every AI-initiated side-effecting action (send Gmail, post to Chat, create a
 * task) writes exactly one append-only row to `ai_action_log` — success OR
 * failure — so the AI's actions are accountable after the fact.
 *
 * TWO HARD GUARANTEES this module upholds:
 *
 *  1. REDACTION. A row records PROVENANCE, never CONTENT. `target` carries only
 *     routing metadata (recipient / space / taskId); message bodies, subjects,
 *     notes, and any other free text are stripped. The gate token is reduced to
 *     a non-reversible fingerprint (`gate_token_id`) — the full token is never
 *     stored. `toAuditRow` is a PURE function that enforces this and is unit
 *     tested directly.
 *
 *  2. BEST-EFFORT. `recordAiAction` must NEVER throw into the request path. The
 *     audit write is off the hot path — if the insert fails, we emit an
 *     observability `ai_error` line and swallow the error so the underlying
 *     action still completes/reports normally.
 */
import crypto from 'crypto'
import { db } from './db'
import { aiActionLog } from './schema'
import { emit } from './observability'
import { eq, desc } from 'drizzle-orm'

/** Actions the AI can take. Open-ended (`string`) so new intents don't need a code change here. */
export type AiActionType = 'gmail_send' | 'chat_post' | 'task_create' | (string & {})

export type AiActor = 'ai' | 'user'
export type AiActionStatus = 'success' | 'failed'

/**
 * Input to `recordAiAction`. Callers pass raw-ish metadata; the mapper redacts.
 * `gateToken` accepts the FULL token — it is fingerprinted here and never stored.
 */
export interface AiActionInput {
  userEmail?: string | null
  actor?: AiActor
  actionType: AiActionType
  /** Routing metadata only (recipient/space/taskId). Body-like keys are stripped. */
  target?: Record<string, unknown> | null
  intent?: string | null
  /** The full gate token — reduced to a fingerprint; NEVER persisted verbatim. */
  gateToken?: string | null
  /** Pre-computed token id, if the caller already has one (takes precedence over gateToken). */
  gateTokenId?: string | null
  requestId?: string | null
  status: AiActionStatus
  error?: string | null
}

/** The exact, redacted shape inserted into `ai_action_log`. */
export interface AuditRow {
  userEmail: string | null
  actor: AiActor
  actionType: string
  target: Record<string, unknown> | null
  intent: string | null
  gateTokenId: string | null
  requestId: string | null
  status: AiActionStatus
  error: string | null
}

/**
 * Keys that may carry message bodies / free text / secrets. These are DROPPED
 * from `target` no matter what the caller passes, so a body can never leak into
 * the audit log through the metadata channel.
 */
export const SENSITIVE_TARGET_KEYS: ReadonlySet<string> = new Set([
  'message', 'text', 'body', 'notes', 'content', 'html', 'raw', 'snippet',
  'subject', 'title', 'gatetoken', 'token', 'accesstoken', 'password',
])

/**
 * Non-reversible fingerprint of a gate token. sha256 the token and keep a
 * 16-char hex prefix — enough to correlate/count a token's uses without ever
 * storing the token itself. Returns null for an empty/absent token.
 */
export function fingerprintGateToken(token: string | null | undefined): string | null {
  if (!token) return null
  return crypto.createHash('sha256').update(token).digest('hex').slice(0, 16)
}

/** Strip body-like / sensitive keys from a target object, keeping only metadata. */
function redactTarget(target: Record<string, unknown> | null | undefined): Record<string, unknown> | null {
  if (!target || typeof target !== 'object') return null
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(target)) {
    if (SENSITIVE_TARGET_KEYS.has(k.toLowerCase())) continue
    // Only keep primitive/serializable scalars — nested objects could smuggle bodies.
    if (v === null || ['string', 'number', 'boolean'].includes(typeof v)) out[k] = v
  }
  return Object.keys(out).length ? out : null
}

/**
 * PURE mapper: input → the redacted row that gets inserted. No I/O, no throw.
 * This is the single place the redaction contract lives, so it is unit-tested
 * in isolation. Body content is stripped; only a token FINGERPRINT is kept.
 */
export function toAuditRow(input: AiActionInput): AuditRow {
  const gateTokenId = input.gateTokenId ?? fingerprintGateToken(input.gateToken)
  return {
    userEmail: input.userEmail?.toLowerCase().trim() || null,
    actor: input.actor ?? 'ai',
    actionType: input.actionType,
    target: redactTarget(input.target),
    intent: input.intent ?? null,
    gateTokenId: gateTokenId ?? null,
    requestId: input.requestId ?? null,
    status: input.status,
    error: input.error ?? null,
  }
}

/**
 * Insert one audit row. BEST-EFFORT: never throws into the caller's request
 * path. On failure it emits an observability `ai_error` line and returns.
 */
export async function recordAiAction(input: AiActionInput): Promise<void> {
  const row = toAuditRow(input)
  try {
    await db.insert(aiActionLog).values(row)
  } catch (err) {
    emit({
      type: 'ai_error',
      requestId: row.requestId ?? 'unknown',
      code: 'ai_audit_write_failed',
      message: `Failed to persist ai_action_log row for ${row.actionType}: ${
        err instanceof Error ? err.message : 'unknown error'
      }`,
    })
  }
}

/** A row as returned by the read endpoint. */
export interface AiActionRecord {
  id: string
  createdAt: string
  userEmail: string | null
  actor: string
  actionType: string
  target: Record<string, unknown> | null
  intent: string | null
  gateTokenId: string | null
  requestId: string | null
  status: string
  error: string | null
}

/**
 * Read recent audit rows for a single user, newest first. `limit` is expected
 * to be pre-clamped by the caller (the route clamps it).
 */
export async function listAiActions(opts: { userEmail: string; limit: number }): Promise<AiActionRecord[]> {
  const rows = await db
    .select()
    .from(aiActionLog)
    .where(eq(aiActionLog.userEmail, opts.userEmail.toLowerCase().trim()))
    .orderBy(desc(aiActionLog.createdAt))
    .limit(opts.limit)

  return rows.map((r) => ({
    id: r.id,
    createdAt: r.createdAt instanceof Date ? r.createdAt.toISOString() : String(r.createdAt),
    userEmail: r.userEmail ?? null,
    actor: r.actor,
    actionType: r.actionType,
    target: (r.target as Record<string, unknown> | null) ?? null,
    intent: r.intent ?? null,
    gateTokenId: r.gateTokenId ?? null,
    requestId: r.requestId ?? null,
    status: r.status,
    error: r.error ?? null,
  }))
}
