import { listAiRunsSince, type AiRunRecord } from './runs'
import { listAiActions, type AiActionRecord } from './ai-audit'
import { listToolRuns, ACTIVE_WINDOW_MS, type ToolRunRecord } from './tool-runs'
import { listWorkers, queueDepths, isMissingTableError } from './dispatch-store'
import { dispatchFreshMs, isDispatchEnabled } from './agy-dispatch'
import { getTenantId } from './tenant-context'
import { createLogger } from './logger'

const log = createLogger('execution-context')

/**
 * lib/execution-context.ts — the Hub's OWN execution state, read for the
 * assistant and the right panel's Pulse tab (Phase 4 PR 1,
 * docs/architecture/PHASE4_AGENTIC_PANEL_2026-09-05.md §3).
 *
 * ── Why this exists ──
 * Every chat turn used to spend up to 8s calling the retired Paperclip API
 * for "project context" and then told the model that "Paperclip orchestration
 * data is unavailable — the API may be warming up". The model repeated that
 * line to the user whenever a right-panel card was tapped, because the card
 * tap carried only its title and the only "agent activity" the prompt knew
 * about was a dead upstream. The Hub has had its own ledgers for months
 * (ai_runs, ai_action_log, tool_runs, dispatch_jobs/dispatch_workers); this
 * module is the one reader that turns them into (a) a prompt section and
 * (b) the Pulse snapshot, so the assistant and the panel describe the SAME
 * facts.
 *
 * ── Two hard rules, inherited from the ledgers ──
 *  1. PROVENANCE, NEVER CONTENT. Nothing here selects prompt or response text
 *     (the ledgers do not store it; tool_runs `brief` is user-authored and is
 *     clamped + fenced by the prompt builder). Error MESSAGES from ai_runs are
 *     withheld exactly as lib/run-feed.ts withholds them — only the typed
 *     class is surfaced.
 *  2. SCOPED READS. ai_runs and dispatch are admin planes (chat ledger rows
 *     carry no per-user attribution yet — /api/runs §3.4). ai_action_log and
 *     tool_runs are always scoped to the caller. `readExecutionSnapshot`
 *     takes the caller's role and email and never widens beyond them.
 *
 * Every reader is best-effort: a failed plane is reported as a notice in the
 * snapshot, never thrown into the chat path.
 */

export const EXECUTION_WINDOW_HOURS = 24
/** Safety cap on the windowed ai_runs read — a hot ledger reports the window
 *  as truncated rather than presenting a partial sample as a total. */
const LEDGER_WINDOW_CAP = 5_000
const ACTION_REASON_CHARS = 120
const RECENT_FAILURES = 5
const RECENT_ACTIONS = 8
const RECENT_TOOL_RUNS = 5
const BRIEF_PREVIEW_CHARS = 120

export interface EngineTally { ok: number; error: number }

export interface RunsPlane {
  windowHours: number
  /** True when the read hit LEDGER_WINDOW_CAP — totals are a lower bound. */
  truncated: boolean
  total: number
  ok: number
  error: number
  byEngine: Record<string, EngineTally>
  bySource: Record<string, EngineTally>
  /** Share of successful chat serves that ran on the agy allotment (0–100). */
  allotmentSharePercent: number | null
  p50LatencyMs: number | null
  totalTokens: number
  errorClasses: Record<string, number>
  recentFailures: Array<{
    id: string
    createdAt: string
    engine: string
    source: string
    errorClass: string
    latencyMs: number
  }>
}

export interface DispatchPlane {
  enabled: boolean
  freshMs: number
  workers: Array<{
    id: string
    fresh: boolean
    lastSeenAt: string
    version: string | null
    agyVersion: string | null
  }>
  queue: Record<string, number>
}

export interface ActionsPlane {
  total: number
  failed: number
  recent: Array<{
    id: string
    createdAt: string
    actionType: string
    intent: string | null
    status: string
    actor: string
    /** Single-line, clamped failure reason (already redacted at write time by
     *  lib/ai-audit); null unless the action failed. */
    reason: string | null
  }>
}

export interface ToolRunsPlane {
  active: number
  recent: Array<{
    id: string
    createdAt: string
    finishedAt: string | null
    tool: string
    status: string
    errorClass: string | null
    briefPreview: string
    latencyMs: number | null
  }>
}

export interface ExecutionSnapshot {
  generatedAt: string
  /** Whether the caller may see the admin planes (ai_runs, dispatch). With
   *  this, a null admin plane is unambiguous: not admin → withheld by role;
   *  admin → the read failed (and `notices` says so). */
  isAdmin: boolean
  /** Admin planes are null for callers without the admin role; ANY plane is
   *  null when its read failed — a failed read must never render as "0". */
  runs: RunsPlane | null
  dispatch: DispatchPlane | null
  actions: ActionsPlane | null
  toolRuns: ToolRunsPlane | null
  /** Planes that could not be read this time, with a one-line reason class. */
  notices: string[]
}

/* ── Pure helpers (unit-tested) ─────────────────────────────────────────── */

function sanitizeClass(k: string | null | undefined): string {
  const clean = (k ?? 'unknown').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 32)
  return clean || 'unknown'
}

function tally(map: Record<string, EngineTally>, key: string, ok: boolean): void {
  const t = (map[key] ??= { ok: 0, error: 0 })
  if (ok) t.ok++
  else t.error++
}

function median(values: number[]): number | null {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 1 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2)
}

/** Fold ledger rows inside the window into the runs plane. Pure. */
export function summarizeRuns(
  rows: AiRunRecord[],
  now: number = Date.now(),
  windowHours: number = EXECUTION_WINDOW_HOURS,
  truncated: boolean = false,
): RunsPlane {
  const cutoff = now - windowHours * 3_600_000
  const inWindow = rows.filter((r) => new Date(r.createdAt).getTime() >= cutoff)

  const plane: RunsPlane = {
    windowHours,
    truncated,
    total: inWindow.length,
    ok: 0,
    error: 0,
    byEngine: {},
    bySource: {},
    allotmentSharePercent: null,
    p50LatencyMs: null,
    totalTokens: 0,
    errorClasses: {},
    recentFailures: [],
  }

  const latencies: number[] = []
  let chatOk = 0
  let chatAgyOk = 0

  for (const r of inWindow) {
    const ok = r.status === 'ok'
    if (ok) plane.ok++
    else plane.error++
    tally(plane.byEngine, r.engine, ok)
    tally(plane.bySource, r.source, ok)
    if (typeof r.totalTokens === 'number') plane.totalTokens += r.totalTokens
    if (Number.isFinite(r.latencyMs)) latencies.push(r.latencyMs)
    if (ok && r.source === 'chat') {
      chatOk++
      if (r.engine === 'agy') chatAgyOk++
    }
    if (!ok) {
      const cls = sanitizeClass(r.errorClass)
      plane.errorClasses[cls] = (plane.errorClasses[cls] ?? 0) + 1
      if (plane.recentFailures.length < RECENT_FAILURES) {
        plane.recentFailures.push({
          id: r.id,
          createdAt: r.createdAt,
          engine: r.engine,
          source: r.source,
          errorClass: cls,
          latencyMs: r.latencyMs,
        })
      }
    }
  }

  plane.p50LatencyMs = median(latencies)
  plane.allotmentSharePercent = chatOk > 0 ? Math.round((chatAgyOk / chatOk) * 100) : null
  return plane
}

function clampReason(error: string | null | undefined): string | null {
  if (typeof error !== 'string') return null
  const oneLine = error.replace(/\s+/g, ' ').trim()
  if (!oneLine) return null
  return oneLine.length > ACTION_REASON_CHARS ? oneLine.slice(0, ACTION_REASON_CHARS - 1) + '…' : oneLine
}

export function summarizeActions(rows: AiActionRecord[]): ActionsPlane {
  // The failed-actions chip asks "which ones, why", so EVERY failed row in the
  // read is projected — not just those inside the newest-N window. Newest N
  // first, then any older failures, ledger order preserved within each.
  const newest = rows.slice(0, RECENT_ACTIONS)
  const olderFailures = rows.slice(RECENT_ACTIONS).filter((r) => r.status === 'failed')
  return {
    total: rows.length,
    failed: rows.filter((r) => r.status === 'failed').length,
    recent: [...newest, ...olderFailures].map((r) => ({
      id: r.id,
      createdAt: r.createdAt,
      actionType: r.actionType,
      intent: r.intent,
      status: r.status,
      actor: r.actor,
      // The failed-actions chip asks "which ones, why" — carry the reason the
      // feed card already shows (lib/ai-action-feed.ts renders the same field).
      reason: r.status === 'failed' ? clampReason(r.error) : null,
    })),
  }
}

function briefPreview(brief: string): string {
  const oneLine = brief.replace(/\s+/g, ' ').trim()
  return oneLine.length > BRIEF_PREVIEW_CHARS ? oneLine.slice(0, BRIEF_PREVIEW_CHARS - 1) + '…' : oneLine
}

/** A queued row older than the active window is an orphan (crash, failed
 *  reap) — the same rule lib/tool-runs.ts applies to the per-user cap. */
function isActiveToolRun(r: ToolRunRecord, now: number): boolean {
  return r.status === 'queued' && new Date(r.createdAt).getTime() >= now - ACTIVE_WINDOW_MS
}

export function summarizeToolRuns(rows: ToolRunRecord[], now: number = Date.now()): ToolRunsPlane {
  return {
    active: rows.filter((r) => isActiveToolRun(r, now)).length,
    recent: rows.slice(0, RECENT_TOOL_RUNS).map((r) => ({
      id: r.id,
      createdAt: r.createdAt,
      finishedAt: r.finishedAt,
      tool: r.tool,
      status: r.status === 'queued' && !isActiveToolRun(r, now) ? 'queued (stale — likely orphaned)' : r.status,
      errorClass: r.errorClass ? sanitizeClass(r.errorClass) : null,
      briefPreview: briefPreview(r.brief),
      latencyMs: r.latencyMs,
    })),
  }
}

/* ── The reader ─────────────────────────────────────────────────────────── */

export interface SnapshotScope {
  userEmail: string
  /** Admin role unlocks the ai_runs + dispatch planes. */
  isAdmin: boolean
  now?: number
}

/**
 * Read every plane the caller may see, concurrently, each failing open into
 * `notices`. Never throws.
 */
export async function readExecutionSnapshot(scope: SnapshotScope): Promise<ExecutionSnapshot> {
  const now = scope.now ?? Date.now()
  const notices: string[] = []
  const tenantId = getTenantId()

  const since = new Date(now - EXECUTION_WINDOW_HOURS * 3_600_000)
  const [runsRes, dispatchRes, actionsRes, toolRunsRes] = await Promise.allSettled([
    scope.isAdmin ? listAiRunsSince(since, LEDGER_WINDOW_CAP) : Promise.resolve(null),
    scope.isAdmin ? readDispatchPlane(now) : Promise.resolve(null),
    listAiActions({ userEmail: scope.userEmail, limit: 25 }),
    listToolRuns(tenantId, scope.userEmail, { limit: 10 }),
  ])

  let runs: RunsPlane | null = null
  if (runsRes.status === 'fulfilled') {
    runs = runsRes.value
      ? summarizeRuns(runsRes.value, now, EXECUTION_WINDOW_HOURS, runsRes.value.length >= LEDGER_WINDOW_CAP)
      : null
  } else {
    log.warn({ err: runsRes.reason }, 'ai_runs read failed')
    notices.push('runs ledger unreadable')
  }

  let dispatch: DispatchPlane | null = null
  if (dispatchRes.status === 'fulfilled') {
    dispatch = dispatchRes.value
  } else {
    log.warn({ err: dispatchRes.reason }, 'dispatch read failed')
    notices.push('dispatch rail unreadable')
  }

  let actions: ActionsPlane | null = null
  if (actionsRes.status === 'fulfilled') {
    actions = summarizeActions(actionsRes.value)
  } else {
    log.warn({ err: actionsRes.reason }, 'ai_action_log read failed')
    notices.push('AI action log unreadable')
  }

  let toolRuns: ToolRunsPlane | null = null
  if (toolRunsRes.status === 'fulfilled') {
    toolRuns = summarizeToolRuns(toolRunsRes.value, now)
  } else {
    log.warn({ err: toolRunsRes.reason }, 'tool_runs read failed')
    notices.push('deep-run ledger unreadable')
  }

  return { generatedAt: new Date(now).toISOString(), isAdmin: scope.isAdmin, runs, dispatch, actions, toolRuns, notices }
}

async function readDispatchPlane(now: number): Promise<DispatchPlane> {
  const freshMs = dispatchFreshMs()
  const plane: DispatchPlane = { enabled: isDispatchEnabled(), freshMs, workers: [], queue: {} }
  try {
    const cutoff = now - freshMs
    const [workers, queue] = await Promise.all([listWorkers(), queueDepths()])
    plane.workers = workers.map((w) => ({
      id: w.id,
      fresh: w.lastSeenAt.getTime() > cutoff,
      lastSeenAt: w.lastSeenAt.toISOString(),
      version: w.version,
      agyVersion: w.agyVersion,
    }))
    plane.queue = queue
  } catch (err) {
    // Tables not migrated yet reads as "no dispatch" rather than a failure —
    // mirrors /api/admin/dispatch-health.
    if (!isMissingTableError(err)) throw err
    plane.enabled = false
  }
  return plane
}

/* ── Prompt rendering (pure) ────────────────────────────────────────────── */

const CT = 'America/Chicago'

function whenCT(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return d.toLocaleString('en-US', { timeZone: CT, month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
}

function ago(iso: string, now: number): string {
  const ms = now - new Date(iso).getTime()
  if (!Number.isFinite(ms) || ms < 0) return 'just now'
  const m = Math.floor(ms / 60_000)
  if (m < 1) return 'just now'
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 48) return `${h}h ago`
  return `${Math.floor(h / 24)}d ago`
}

function latency(ms: number | null): string {
  if (ms === null) return 'n/a'
  return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`
}

/**
 * The "Execution Layer" prompt section. Deliberately compact (a few hundred
 * tokens) — it is on EVERY turn. Rendered inside an untrusted fence by the
 * prompt builder because tool_runs briefs and action intents are user-authored.
 */
export function formatExecutionContext(snap: ExecutionSnapshot, now: number = Date.now()): string {
  const lines: string[] = []

  if (snap.runs) {
    const r = snap.runs
    lines.push(`Model runs, last ${r.windowHours}h: ${r.total} total — ${r.ok} ok, ${r.error} failed.${r.truncated ? ' (Window truncated at the read cap; totals are a lower bound.)' : ''}`)
    const engines = Object.entries(r.byEngine)
      .map(([e, t]) => `${e} ${t.ok} ok/${t.error} failed`)
      .join('; ')
    if (engines) lines.push(`By engine: ${engines}.`)
    const sources = Object.entries(r.bySource)
      .map(([s, t]) => `${s} ${t.ok + t.error}`)
      .join(', ')
    if (sources) lines.push(`By source: ${sources}.`)
    lines.push(
      `Allotment share of chat serves: ${r.allotmentSharePercent === null ? 'n/a (no chat serves in window)' : `${r.allotmentSharePercent}% on agy`}. ` +
        `p50 latency ${latency(r.p50LatencyMs)}. Tokens ${r.totalTokens}.`,
    )
    if (r.error > 0) {
      const classes = Object.entries(r.errorClasses).map(([c, n]) => `${c}×${n}`).join(', ')
      lines.push(`Failure classes: ${classes}.`)
      lines.push('Recent failures:')
      for (const f of r.recentFailures) {
        lines.push(`  - run ${f.id.slice(0, 8)} · ${f.engine}/${f.source} · ${f.errorClass} · ${latency(f.latencyMs)} · ${ago(f.createdAt, now)}`)
      }
    }
  } else if (!snap.isAdmin) {
    lines.push('Model-run ledger: not visible to this role (admin-only plane).')
  } else {
    lines.push('Model-run ledger: could not be read this turn (not a permissions issue — the read failed).')
  }

  if (!snap.dispatch && snap.isAdmin) {
    lines.push('Desktop dispatch rail: could not be read this turn.')
  }
  if (snap.dispatch) {
    const d = snap.dispatch
    if (!d.enabled && d.workers.length === 0) {
      lines.push('Desktop dispatch (agy allotment worker): disabled.')
    } else {
      const fresh = d.workers.filter((w) => w.fresh)
      const stale = d.workers.filter((w) => !w.fresh)
      const workerLine = d.workers.length === 0
        ? 'no worker has ever registered'
        : `${fresh.length} live${fresh.length ? ` (${fresh.map((w) => w.id).join(', ')})` : ''}` +
          (stale.length ? `, ${stale.length} offline (${stale.map((w) => `${w.id} last seen ${ago(w.lastSeenAt, now)}`).join(', ')})` : '')
      lines.push(`Desktop dispatch workers: ${workerLine}.`)
      const q = Object.entries(d.queue).filter(([, n]) => n > 0).map(([s, n]) => `${s} ${n}`).join(', ')
      lines.push(`Dispatch queue: ${q || 'empty'}.`)
    }
  }

  const a = snap.actions
  if (a) {
    lines.push(`AI actions on the user's behalf (their own log): ${a.total} recent, ${a.failed} failed.`)
    for (const x of a.recent) {
      lines.push(`  - ${whenCT(x.createdAt)} · ${x.actionType} · ${x.status}${x.intent ? ` · "${x.intent}"` : ''}${x.reason ? ` · reason: ${x.reason}` : ''}`)
    }
  } else {
    lines.push('AI action log: could not be read this turn (not "no actions" — unknown).')
  }

  const t = snap.toolRuns
  if (!t) {
    lines.push('Deep-run ledger: could not be read this turn.')
  } else if (t.recent.length === 0 && t.active === 0) {
    lines.push('Deep runs (Deep Research / Deep Think) for this user: 0 active, no recent runs.')
  } else {
    lines.push(`Deep runs (Deep Research / Deep Think) for this user: ${t.active} active.`)
    for (const x of t.recent) {
      lines.push(`  - ${whenCT(x.createdAt)} · ${x.tool} · ${x.status}${x.errorClass ? ` (${x.errorClass})` : ''} · "${x.briefPreview}"`)
    }
  }

  if (snap.notices.length > 0) {
    lines.push(`Planes not readable this turn: ${snap.notices.join('; ')}.`)
  }

  return lines.join('\n')
}

/* ── Single-record rendering for "tell me more about this card" taps ────── */

export function formatAiRunRecord(run: AiRunRecord, now: number = Date.now()): string {
  const ok = run.status === 'ok'
  const workerId = run.meta && typeof run.meta.workerId === 'string' ? run.meta.workerId : null
  const rows: Array<[string, string]> = [
    ['Run id', run.id],
    ['When', `${whenCT(run.createdAt)} CT (${ago(run.createdAt, now)})`],
    ['Verdict', ok ? 'served successfully' : `FAILED — error class "${sanitizeClass(run.errorClass)}"`],
    ['Engine', run.engine + (run.engine === 'agy' ? ' (Antigravity CLI on the subscription allotment — no metered cost)' : ' (metered API)')],
    ['Model', run.model ?? 'not reported'],
    ['Source', run.source + (run.source === 'chat' ? ' (an assistant chat turn)' : run.source === 'health_probe' ? ' (the end-to-end health probe)' : '')],
    ['Latency', latency(run.latencyMs)],
    ['Tokens', run.totalTokens === null ? 'not reported' : `${run.totalTokens} total (in ${run.inputTokens ?? '?'}, out ${run.outputTokens ?? '?'}, cache-read ${run.cacheReadTokens ?? 0})`],
    ['Prompt', run.promptChars === null ? 'size not recorded' : `${run.promptChars} chars (fingerprint ${run.promptSha256 ?? 'n/a'}; the text itself is never stored)`],
  ]
  if (workerId) rows.push(['Worker', workerId])
  if (run.userEmail) rows.push(['Actor', run.userEmail])
  if (run.requestId) rows.push(['Request id', run.requestId])
  const keys = run.meta ? Object.keys(run.meta).filter((k) => k !== 'workerId') : []
  if (keys.length) {
    rows.push(['Meta', keys.map((k) => `${k}=${String(run.meta![k])}`).join(', ')])
  }
  return rows.map(([k, v]) => `- ${k}: ${v}`).join('\n')
}

export function formatAiActionRecord(action: AiActionRecord, now: number = Date.now()): string {
  const rows: Array<[string, string]> = [
    ['Action id', action.id],
    ['When', `${whenCT(action.createdAt)} CT (${ago(action.createdAt, now)})`],
    ['Type', action.actionType],
    ['Outcome', action.status === 'failed' ? `FAILED${action.error ? ` — ${action.error}` : ''}` : action.status],
    ['Actor', action.actor === 'ai' ? 'the assistant, on the user\'s behalf' : action.actor],
  ]
  if (action.intent) rows.push(['Intent', action.intent])
  if (action.target && Object.keys(action.target).length > 0) {
    const t = Object.entries(action.target)
      .filter(([, v]) => typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean')
      .map(([k, v]) => `${k}=${String(v)}`)
      .join(', ')
    if (t) rows.push(['Target', t])
  }
  if (action.gateTokenId) rows.push(['Approval', `user-confirmed (gate ${action.gateTokenId})`])
  if (action.requestId) rows.push(['Request id', action.requestId])
  return rows.map(([k, v]) => `- ${k}: ${v}`).join('\n')
}

const ALERT_MEANING: Record<string, string> = {
  worker_stale: 'the desktop worker that spends the agy allotment stopped heart-beating — chat falls back to metered models and deep runs cannot start until it is back',
  tables_missing: 'the dispatch tables are not migrated on this deployment — run the migrations',
  agy_error_streak: 'several agy runs failed in a row — usually the OAuth token needs rotation (see the agy-gateway runbook)',
  allotment_collapse: 'chat turns were served mostly by metered models instead of the allotment — check the worker and the agy token',
}

/** One dispatch alert row (event_log) for the needs-you Explain tap. Content-free by construction. */
export function formatDispatchAlertRecord(
  row: { id: string; createdAt: Date | string; kinds: string[]; channel: string },
  now: number = Date.now(),
): string {
  const createdIso = row.createdAt instanceof Date ? row.createdAt.toISOString() : String(row.createdAt)
  const rows: Array<[string, string]> = [
    ['Alert id', row.id],
    ['When', `${whenCT(createdIso)} CT (${ago(createdIso, now)})`],
    ['Delivery', row.channel === 'chat' || row.channel === 'github' ? `delivered via ${row.channel}` : `recorded only (${row.channel}) — a repeat inside the re-alert window is not re-delivered`],
    ['Conditions', row.kinds.length ? row.kinds.join(', ') : 'none (this is a recovery record)'],
  ]
  for (const k of row.kinds) {
    rows.push([`What "${k}" means`, ALERT_MEANING[k] ?? 'an unrecognised alert kind — treat as a dispatch health problem'])
  }
  return rows.map(([k, v]) => `- ${k}: ${v}`).join('\n')
}

export function formatToolRunRecord(run: ToolRunRecord, now: number = Date.now()): string {
  const rows: Array<[string, string]> = [
    ['Deep run id', run.id],
    ['Tool', run.tool],
    ['Status', run.status + (run.errorClass ? ` (${sanitizeClass(run.errorClass)})` : '')],
    ['Started', `${whenCT(run.createdAt)} CT (${ago(run.createdAt, now)})`],
    ['Finished', run.finishedAt ? whenCT(run.finishedAt) + ' CT' : 'not yet'],
    ['Model', run.model ?? 'not reported'],
    ['Latency', latency(run.latencyMs)],
    ['Brief', briefPreview(run.brief)],
  ]
  if (run.inputs?.length) rows.push(['Inputs', run.inputs.map((i) => i.title).join('; ')])
  return rows.map(([k, v]) => `- ${k}: ${v}`).join('\n')
}
