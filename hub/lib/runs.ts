import crypto from 'crypto'
import { and, desc, eq, gt, sql } from 'drizzle-orm'
import { db } from './db'
import { aiRuns } from './schema'
import { emit, type AiProvider } from './observability'

/**
 * The AI runs ledger (Phase 2 of the agy migration).
 *
 * One append-only row per model run, whatever engine served it. This is the
 * accountability layer the migration exists to build — the old Paperclip runs
 * failed silently with no record anywhere, and the agy gateway's whole design
 * (pty, empty-means-failed, typed errors) is about making failure VISIBLE.
 * The ledger is where that visibility becomes durable: the Phase 3 right-panel
 * feed reads from here, and "is the allotment actually serving?" is a SQL
 * query rather than a Cloud Logging expedition.
 *
 * Engine-agnostic by design (Phase 2 scope decision, 2026-08-14): `engine` is
 * the AiProvider union, so the metered Gemini/Claude chains can join the
 * ledger later without a migration. The agy call sites (chat + health probe)
 * are wired now.
 *
 * TWO HARD GUARANTEES, mirroring lib/ai-audit.ts:
 *
 *  1. REDACTION — provenance, never content. The prompt is reduced to a
 *     length + sha256 fingerprint by the PURE mapper `toRunRow` (unit-tested
 *     directly); response text and raw envelopes are never persisted. `meta`
 *     accepts only primitive values and drops body-like keys, so content
 *     cannot be smuggled in through the extras channel.
 *  2. BEST-EFFORT — `recordAiRun` never throws into the request path. A
 *     failed insert emits an observability `ai_error` line and is swallowed;
 *     chat must never degrade because the ledger hiccuped.
 */

export type RunSource = 'chat' | 'health_probe' | (string & {})
export type RunStatus = 'ok' | 'error'

export interface AiRunInput {
  engine: AiProvider
  /** Model that actually served, when the engine reports one. */
  model?: string | null
  source: RunSource
  status: RunStatus
  /** Typed class ('auth', 'timeout', …) — never raw stack text. */
  errorClass?: string | null
  /** Human-readable failure message; flattened + truncated by the mapper. */
  error?: string | null
  latencyMs: number
  /** The full prompt — fingerprinted by the mapper, NEVER stored. */
  prompt?: string | null
  usage?: {
    inputTokens?: number
    outputTokens?: number
    cacheReadTokens?: number
    totalTokens?: number
  }
  requestId?: string | null
  userEmail?: string | null
  /** Small structured extras (markerVerified, envelope keys). Primitives only. */
  meta?: Record<string, unknown> | null
}

/** The exact, redacted shape inserted into `ai_runs`. */
export interface AiRunRow {
  engine: AiProvider
  model: string | null
  source: string
  status: RunStatus
  errorClass: string | null
  error: string | null
  latencyMs: number
  inputTokens: number | null
  outputTokens: number | null
  cacheReadTokens: number | null
  totalTokens: number | null
  promptChars: number | null
  promptSha256: string | null
  requestId: string | null
  userEmail: string | null
  meta: Record<string, unknown> | null
}

/** Keys that could carry content into `meta`; dropped unconditionally
 *  (same philosophy as SENSITIVE_TARGET_KEYS in lib/ai-audit.ts). */
const SENSITIVE_META_KEYS: ReadonlySet<string> = new Set([
  'prompt', 'text', 'response', 'output', 'message', 'body', 'content',
  'raw', 'envelope', 'token', 'accesstoken', 'password',
])

/** Non-reversible prompt fingerprint: sha256, 16-hex prefix — enough to
 *  correlate identical prompts (cache-hit analysis) without storing one. */
export function fingerprintPrompt(prompt: string | null | undefined): string | null {
  if (!prompt) return null
  return crypto.createHash('sha256').update(prompt).digest('hex').slice(0, 16)
}

function flattenError(msg: string | null | undefined, max = 300): string | null {
  if (!msg) return null
  const flat = msg.replace(/\s+/g, ' ').trim()
  if (!flat) return null
  return flat.length > max ? `${flat.slice(0, max)}…` : flat
}

function scrubMeta(meta: Record<string, unknown> | null | undefined): Record<string, unknown> | null {
  if (!meta || typeof meta !== 'object') return null
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(meta)) {
    if (SENSITIVE_META_KEYS.has(k.toLowerCase())) continue
    if (v === null || ['string', 'number', 'boolean'].includes(typeof v)) {
      out[k] = v
    } else if (Array.isArray(v) && v.every((x) => typeof x === 'string')) {
      // String arrays are allowed for key lists (e.g. envelope top-level keys).
      out[k] = v
    }
  }
  return Object.keys(out).length ? out : null
}

function intOrNull(v: number | undefined): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : null
}

/**
 * PURE mapper: input → the redacted row. No I/O, no throw. This is the single
 * place the redaction contract lives; it is unit-tested in isolation.
 */
export function toRunRow(input: AiRunInput): AiRunRow {
  return {
    engine: input.engine,
    model: input.model?.trim() || null,
    source: input.source,
    status: input.status,
    errorClass: input.errorClass?.trim() || null,
    error: flattenError(input.error),
    latencyMs: Math.max(0, Math.round(input.latencyMs)),
    inputTokens: intOrNull(input.usage?.inputTokens),
    outputTokens: intOrNull(input.usage?.outputTokens),
    cacheReadTokens: intOrNull(input.usage?.cacheReadTokens),
    totalTokens: intOrNull(input.usage?.totalTokens),
    promptChars: input.prompt ? input.prompt.length : null,
    promptSha256: fingerprintPrompt(input.prompt),
    requestId: input.requestId ?? null,
    userEmail: input.userEmail?.toLowerCase().trim() || null,
    meta: scrubMeta(input.meta),
  }
}

/**
 * Insert one ledger row. BEST-EFFORT: never throws into the caller's request
 * path. On failure it emits an observability `ai_error` line and returns.
 */
export async function recordAiRun(input: AiRunInput): Promise<void> {
  const row = toRunRow(input)
  try {
    await db.insert(aiRuns).values(row)
  } catch (err) {
    emit({
      type: 'ai_error',
      requestId: row.requestId ?? 'unknown',
      code: 'ai_run_write_failed',
      message: `Failed to persist ai_runs row (${row.engine}/${row.source}): ${
        err instanceof Error ? err.message : 'unknown error'
      }`,
    })
  }
}

/** A row as returned to admin/panel readers. */
export interface AiRunRecord {
  id: string
  createdAt: string
  engine: string
  model: string | null
  source: string
  status: string
  errorClass: string | null
  error: string | null
  latencyMs: number
  inputTokens: number | null
  outputTokens: number | null
  cacheReadTokens: number | null
  totalTokens: number | null
  promptChars: number | null
  promptSha256: string | null
  requestId: string | null
  userEmail: string | null
  meta: Record<string, unknown> | null
}

/**
 * Terminal chat SERVES by engine inside a window — "who actually answered".
 * status='ok' only: an agy failure followed by a Gemini serve counts once,
 * for Gemini. This is the allotment-vs-metered ratio surfaced on
 * dispatch-health (hardening review move 3); the alert evaluator in
 * lib/dispatch-alerts.ts runs its own windowed reads.
 */
export async function chatServeCounts(windowMs = 24 * 60 * 60 * 1000): Promise<Record<string, number>> {
  const cutoff = new Date(Date.now() - windowMs)
  const rows = await db
    .select({ engine: aiRuns.engine, n: sql<number>`count(*)::int` })
    .from(aiRuns)
    .where(and(eq(aiRuns.source, 'chat'), eq(aiRuns.status, 'ok'), gt(aiRuns.createdAt, cutoff)))
    .groupBy(aiRuns.engine)
  return Object.fromEntries(rows.map((r) => [r.engine, r.n]))
}

/** Read recent runs, newest first. `limit` is expected pre-clamped by the
 *  caller (the Phase 3 panel route will clamp, mirroring listAiActions). */
export async function listAiRuns(opts: { limit: number }): Promise<AiRunRecord[]> {
  const rows = await db.select().from(aiRuns).orderBy(desc(aiRuns.createdAt)).limit(opts.limit)
  return rows.map((r) => ({
    id: r.id,
    createdAt: r.createdAt instanceof Date ? r.createdAt.toISOString() : String(r.createdAt),
    engine: r.engine,
    model: r.model ?? null,
    source: r.source,
    status: r.status,
    errorClass: r.errorClass ?? null,
    error: r.error ?? null,
    latencyMs: r.latencyMs,
    inputTokens: r.inputTokens ?? null,
    outputTokens: r.outputTokens ?? null,
    cacheReadTokens: r.cacheReadTokens ?? null,
    totalTokens: r.totalTokens ?? null,
    promptChars: r.promptChars ?? null,
    promptSha256: r.promptSha256 ?? null,
    requestId: r.requestId ?? null,
    userEmail: r.userEmail ?? null,
    meta: (r.meta as Record<string, unknown> | null) ?? null,
  }))
}
