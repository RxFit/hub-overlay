/* ══════════════════════════════════════════════════════════════════════════
   EXECUTION PANEL — pure helpers for the Issues & Agents tabs (Phase 2)

   Client-safe module (no server imports): comment normalization, the issue
   state-change vocabulary sent over the wire, and agent lifecycle affordance
   rules. Kept out of lib/paperclip.ts because that module pulls in
   server-only auth/session code.
   ══════════════════════════════════════════════════════════════════════════ */

import type { Agent } from '@/types'

/* ── Issue comments ── */

export interface IssueComment {
  id: string
  body: string
  authorName: string
  authorType: 'agent' | 'user' | 'system'
  createdAt: string
}

function str(v: unknown, fallback = ''): string {
  return typeof v === 'string' ? v : fallback
}

/**
 * Normalize Paperclip's comment list (bare array or `{ comments: [...] }`)
 * into a stable render shape. Unknown author fields degrade to "system".
 */
export function normalizeComments(data: unknown): IssueComment[] {
  const arr = Array.isArray(data)
    ? data
    : data && typeof data === 'object' && Array.isArray((data as Record<string, unknown>).comments)
      ? ((data as Record<string, unknown>).comments as unknown[])
      : []

  return arr
    .filter((c): c is Record<string, unknown> => !!c && typeof c === 'object')
    .map((c, i) => {
      const rawAuthorType = str(c.authorType ?? c.actorType).toLowerCase()
      const authorType: IssueComment['authorType'] =
        rawAuthorType === 'agent' ? 'agent' : rawAuthorType === 'user' ? 'user' : 'system'
      return {
        id: str(c.id, `comment-${i}`),
        body: str(c.body ?? c.content),
        authorName: str(c.authorName ?? c.authorAgentName ?? c.actorId, authorType),
        authorType,
        createdAt: str(c.createdAt),
      }
    })
    .filter((c) => c.body.length > 0)
}

/* ── Issue state changes ── */

/**
 * The state-change options offered in the issue drawer, in board order.
 * `status` is Paperclip's wire vocabulary — the PATCH goes through the
 * [...path] proxy verbatim (no server-side translation on that path).
 */
export const ISSUE_STATE_OPTIONS: Array<{ status: string; label: string }> = [
  { status: 'backlog', label: 'Backlog' },
  { status: 'todo', label: 'Todo' },
  { status: 'in_progress', label: 'In Progress' },
  { status: 'in_review', label: 'In Review' },
  { status: 'blocked', label: 'Blocked' },
  { status: 'done', label: 'Done' },
  { status: 'cancelled', label: 'Cancelled' },
]

/** Hub state-group/name → the wire status currently active (for select value). */
export function wireStatusForState(state: { group: string; name: string }): string {
  const byName = ISSUE_STATE_OPTIONS.find(
    (o) => o.label.toLowerCase() === state.name.toLowerCase()
  )
  if (byName) return byName.status
  switch (state.group) {
    case 'backlog': return 'backlog'
    case 'unstarted': return 'todo'
    case 'started': return 'in_progress'
    case 'completed': return 'done'
    case 'cancelled': return 'cancelled'
    default: return 'todo'
  }
}

/* ── Agent lifecycle affordances ── */

export type AgentLifecycleAction = 'wakeup' | 'pause' | 'resume' | 'clear-error'

export const AGENT_ACTION_LABELS: Record<AgentLifecycleAction, string> = {
  wakeup: 'Wake',
  pause: 'Pause',
  resume: 'Resume',
  'clear-error': 'Clear error',
}

/**
 * Which lifecycle actions make sense for an agent's current (raw) status.
 * Terminated/pending agents get none; errored agents lead with clear-error;
 * paused agents can only resume; everything else can wake or pause.
 */
export function availableAgentActions(agent: Pick<Agent, 'status' | 'rawStatus'>): AgentLifecycleAction[] {
  const raw = (agent.rawStatus ?? '').toLowerCase()
  if (raw === 'terminated' || raw === 'pending_approval') return []
  if (raw === 'error' || agent.status === 'error') return ['clear-error', 'wakeup']
  if (raw === 'paused') return ['resume']
  if (raw === 'running') return ['pause']
  // idle / active / unknown-but-operational
  return ['wakeup', 'pause']
}
