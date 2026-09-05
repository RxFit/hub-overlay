import type { ChatRecordKind } from '@/types'
import { listAiRunsSince, type AiRunRecord } from './runs'
import { listAiActions, type AiActionRecord } from './ai-audit'
import { listToolRuns, ACTIVE_WINDOW_MS, type ToolRunRecord } from './tool-runs'
import { listDispatchAlerts, type DispatchAlertRow } from './dispatch-alerts'
import { listDismissedKeys } from './queue-dismissals'
import { buildActionTitle, firstTargetString } from './ai-action-feed'
import { getTenantId } from './tenant-context'
import { createLogger } from './logger'

const log = createLogger('needs-you')

/**
 * lib/needs-you.ts — the "Needs you" queue (Phase 4 PR 2,
 * docs/architecture/PHASE4_AGENTIC_PANEL_2026-09-05.md §5 PR 2).
 *
 * The inbox at the top of the Runs tab: everything the Hub's AI could not
 * finish on its own, as cards with Explain / Retry / Dismiss. It is DERIVED
 * from the same ledgers the Execution Layer reads — never a table of its own
 * — so a card can never disagree with the assistant's context:
 *
 *   review   — a failure the owner should look at: a failed model run
 *              (admin), a failed AI action (owner), a failed deep run (owner)
 *   question — the engine is unsure: a deep run still 'queued' past the
 *              active window (an orphan — the cap helper treats it the same)
 *   notify   — an FYI: a delivered dispatch alert (admin)
 *
 * Item types follow the LangChain ambient-agent framing (Notify / Question /
 * Review) so PR 3's playbooks can post into the same queue.
 *
 * Rules inherited from the ledgers: provenance never content (run error
 * MESSAGES are withheld — typed classes only; action reasons are clamped
 * exactly as the feed card shows them), admin planes never read for
 * non-admins, every reader fails open into `notices`.
 */

export type NeedsYouKind = 'review' | 'question' | 'notify'
export type NeedsYouSource = 'ai_run' | 'ai_action' | 'tool_run' | 'dispatch_alert'

export type NeedsYouRetry =
  /** Re-enqueue the deep run with the same brief + context (POST /api/deep-runs/:id {action:'retry'}). */
  | { mode: 'deep_run'; runId: string; tool: string }
  /** The action body was never stored (audit redaction), so a retry re-opens
   *  the confirm-card flow from an execute-style prompt the app can gate. */
  | { mode: 'action'; prompt: string }

export interface NeedsYouItem {
  /** Stable, dismissable identity: 'run:<id>' | 'action:<id>' | 'deep:<id>' | 'alert:<id>'. */
  key: string
  kind: NeedsYouKind
  source: NeedsYouSource
  title: string
  description: string
  createdAt: string
  /** The ledger row behind the card, for the Explain tap (record attachment). */
  record: { recordKind: ChatRecordKind; recordId: string } | null
  retry: NeedsYouRetry | null
}

export interface NeedsYouQueue {
  items: NeedsYouItem[]
  /** Items the caller dismissed and are hidden — shown as "n dismissed". */
  dismissedCount: number
  notices: string[]
}

const RUN_WINDOW_HOURS = 24
const RUN_WINDOW_CAP = 2_000
const ACTIONS_LIMIT = 25
const TOOL_RUNS_LIMIT = 10
const TOOL_RUN_WINDOW_MS = 7 * 24 * 3_600_000
const ALERTS_LIMIT = 10
const REASON_CHARS = 120

/* ── Pure builders ──────────────────────────────────────────────────────── */

function sanitizeClass(k: string | null | undefined): string {
  const clean = (k ?? 'unknown').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 32)
  return clean || 'unknown'
}

function clamp(text: string | null | undefined, max: number = REASON_CHARS): string | null {
  if (typeof text !== 'string') return null
  const oneLine = text.replace(/\s+/g, ' ').trim()
  if (!oneLine) return null
  return oneLine.length > max ? oneLine.slice(0, max - 1) + '…' : oneLine
}

function latency(ms: number | null): string {
  if (ms === null) return 'n/a'
  return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`
}

const TOOL_LABEL: Record<string, string> = { 'deep-research': 'Deep Research', 'deep-think': 'Deep Think' }
function toolLabel(tool: string): string {
  return TOOL_LABEL[tool] ?? tool
}

/** A failed model run → review. Never the error message, only the class. */
export function runToNeedsYou(run: AiRunRecord): NeedsYouItem | null {
  if (run.status === 'ok') return null
  const cls = sanitizeClass(run.errorClass)
  return {
    key: `run:${run.id}`,
    kind: 'review',
    source: 'ai_run',
    title: `Run ${run.id.slice(0, 8)} failed (${cls})`,
    description: `${run.engine} · ${run.source} · ${latency(run.latencyMs)}`,
    createdAt: run.createdAt,
    record: { recordKind: 'ai_run', recordId: run.id },
    retry: null,
  }
}

/**
 * The execute-style prompt a Retry sends for a failed action. The audit
 * row stores routing scalars only (recipient, space, task title), so the
 * prompt names the target and lets the app's interview + confirm card
 * collect the rest — a retry is never an unreviewed re-send.
 */
export function actionRetryPrompt(row: AiActionRecord): string | null {
  switch (row.actionType) {
    case 'gmail_send': {
      const to = firstTargetString(row.target, ['recipient', 'to'])
      return to ? `Send an email to ${to}` : 'Send an email'
    }
    case 'chat_post': {
      const space = firstTargetString(row.target, ['space', 'spaceName'])
      return space ? `Post a message in ${space}` : 'Post a message in a Google Chat space'
    }
    case 'task_create': {
      const title = firstTargetString(row.target, ['title'])
      return title ? `Create a task: ${title}` : 'Create a task'
    }
    default:
      return null
  }
}

/** A failed AI action → review, worded exactly like its feed card. */
export function actionToNeedsYou(row: AiActionRecord): NeedsYouItem | null {
  if (row.status !== 'failed') return null
  const reason = clamp(row.error)
  const prompt = actionRetryPrompt(row)
  return {
    key: `action:${row.id}`,
    kind: 'review',
    source: 'ai_action',
    title: buildActionTitle(row, true),
    description: [row.intent ? clamp(row.intent, 60) : null, reason ? `Failed — ${reason}` : 'Failed'].filter(Boolean).join(' · '),
    createdAt: row.createdAt,
    record: { recordKind: 'ai_action', recordId: row.id },
    retry: prompt ? { mode: 'action', prompt } : null,
  }
}

function isOrphaned(run: ToolRunRecord, now: number): boolean {
  return run.status === 'queued' && new Date(run.createdAt).getTime() < now - ACTIVE_WINDOW_MS
}

/** A failed deep run → review; a queued one past the active window → question. */
export function toolRunToNeedsYou(run: ToolRunRecord, now: number = Date.now()): NeedsYouItem | null {
  const brief = clamp(run.brief, 80) ?? ''
  if (run.status === 'failed') {
    return {
      key: `deep:${run.id}`,
      kind: 'review',
      source: 'tool_run',
      title: `${toolLabel(run.tool)} failed (${sanitizeClass(run.errorClass)})`,
      description: brief,
      createdAt: run.finishedAt ?? run.createdAt,
      record: { recordKind: 'tool_run', recordId: run.id },
      retry: { mode: 'deep_run', runId: run.id, tool: run.tool },
    }
  }
  if (isOrphaned(run, now)) {
    const hours = Math.max(1, Math.round((now - new Date(run.createdAt).getTime()) / 3_600_000))
    return {
      key: `deep:${run.id}`,
      kind: 'question',
      source: 'tool_run',
      title: `${toolLabel(run.tool)} looks stuck (queued ${hours}h)`,
      description: brief,
      createdAt: run.createdAt,
      record: { recordKind: 'tool_run', recordId: run.id },
      retry: { mode: 'deep_run', runId: run.id, tool: run.tool },
    }
  }
  return null
}

const ALERT_LABEL: Record<string, string> = {
  worker_stale: 'desktop worker offline',
  tables_missing: 'dispatch tables missing',
  agy_error_streak: 'agy failing repeatedly',
  allotment_collapse: 'chat fell back to metered models',
}

/** A delivered dispatch alert → notify. Recovery rows (no kinds) are skipped. */
export function alertToNeedsYou(row: DispatchAlertRow): NeedsYouItem | null {
  if (row.kinds.length === 0) return null
  const labels = row.kinds.map((k) => ALERT_LABEL[k] ?? k)
  return {
    key: `alert:${row.id}`,
    kind: 'notify',
    source: 'dispatch_alert',
    title: `Dispatch alert: ${labels.join(', ')}`,
    description: row.channel === 'chat' || row.channel === 'github' ? `delivered via ${row.channel}` : 'recorded (delivery suppressed)',
    createdAt: row.createdAt.toISOString(),
    record: null,
    retry: null,
  }
}

/**
 * Assemble, de-duplicate and order the queue. Pure.
 *  - a failed ai_run that belongs to a deep run listed here is dropped (the
 *    deep-run card carries the Retry; two cards for one failure is noise)
 *  - dismissed keys are removed and counted
 *  - newest first
 */
export function assembleQueue(
  parts: {
    runs: AiRunRecord[]
    actions: AiActionRecord[]
    toolRuns: ToolRunRecord[]
    alerts: DispatchAlertRow[]
  },
  dismissed: Set<string>,
  now: number = Date.now(),
): { items: NeedsYouItem[]; dismissedCount: number } {
  const deepItems = parts.toolRuns.map((r) => toolRunToNeedsYou(r, now)).filter((x): x is NeedsYouItem => x !== null)
  const deepIds = new Set(deepItems.map((i) => i.key.slice('deep:'.length)))

  const runItems = parts.runs
    .filter((r) => {
      const linked = r.meta && typeof r.meta.toolRunId === 'string' ? r.meta.toolRunId : null
      return !(linked && deepIds.has(linked))
    })
    .map(runToNeedsYou)
    .filter((x): x is NeedsYouItem => x !== null)

  const all = [
    ...runItems,
    ...parts.actions.map(actionToNeedsYou).filter((x): x is NeedsYouItem => x !== null),
    ...deepItems,
    ...parts.alerts.map(alertToNeedsYou).filter((x): x is NeedsYouItem => x !== null),
  ]
  const visible = all.filter((i) => !dismissed.has(i.key))
  visible.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
  return { items: visible, dismissedCount: all.length - visible.length }
}

/* ── The reader ─────────────────────────────────────────────────────────── */

export interface QueueScope {
  userEmail: string
  isAdmin: boolean
  now?: number
}

/** Read every source the caller may see, concurrently, each failing open. Never throws. */
export async function readNeedsYou(scope: QueueScope): Promise<NeedsYouQueue> {
  const now = scope.now ?? Date.now()
  const tenantId = getTenantId()
  const notices: string[] = []
  const runSince = new Date(now - RUN_WINDOW_HOURS * 3_600_000)

  const [runsRes, actionsRes, toolRunsRes, alertsRes, dismissedRes] = await Promise.allSettled([
    scope.isAdmin ? listAiRunsSince(runSince, RUN_WINDOW_CAP) : Promise.resolve([] as AiRunRecord[]),
    listAiActions({ userEmail: scope.userEmail, limit: ACTIONS_LIMIT }),
    listToolRuns(tenantId, scope.userEmail, { limit: TOOL_RUNS_LIMIT }),
    scope.isAdmin ? listDispatchAlerts(tenantId, runSince, ALERTS_LIMIT) : Promise.resolve([] as DispatchAlertRow[]),
    listDismissedKeys(tenantId, scope.userEmail),
  ])

  const take = <T,>(res: PromiseSettledResult<T>, empty: T, notice: string): T => {
    if (res.status === 'fulfilled') return res.value
    log.warn({ err: res.reason }, notice)
    notices.push(notice)
    return empty
  }

  const runs = take(runsRes, [] as AiRunRecord[], 'runs ledger unreadable')
  const actions = take(actionsRes, [] as AiActionRecord[], 'AI action log unreadable')
  const toolRuns = take(toolRunsRes, [] as ToolRunRecord[], 'deep-run ledger unreadable')
    .filter((r) => new Date(r.finishedAt ?? r.createdAt).getTime() >= now - TOOL_RUN_WINDOW_MS)
  const alerts = take(alertsRes, [] as DispatchAlertRow[], 'dispatch alert history unreadable')
  const dismissed = take(dismissedRes, new Set<string>(), 'dismissals unreadable')

  const { items, dismissedCount } = assembleQueue({ runs, actions, toolRuns, alerts }, dismissed, now)
  return { items, dismissedCount, notices }
}
