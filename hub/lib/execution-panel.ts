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

/* ── Routine runs ── */

export interface RoutineRun {
  id: string
  /** created | dispatched | coalesced | skipped | failed | … (wire vocabulary kept open) */
  status: string
  source: string
  linkedIssueId: string | null
  createdAt: string
  completedAt: string | null
  failureReason: string | null
}

/**
 * Normalize GET /api/routines/:id/runs (bare array or `{ runs: [...] }`).
 * Field presence varies by Paperclip version — everything degrades to
 * empty/null rather than throwing.
 */
export function normalizeRoutineRuns(data: unknown): RoutineRun[] {
  const arr = Array.isArray(data)
    ? data
    : data && typeof data === 'object' && Array.isArray((data as Record<string, unknown>).runs)
      ? ((data as Record<string, unknown>).runs as unknown[])
      : []

  return arr
    .filter((r): r is Record<string, unknown> => !!r && typeof r === 'object')
    .map((r, i) => ({
      id: str(r.id, `run-${i}`),
      status: str(r.status, 'unknown'),
      source: str(r.source, 'schedule'),
      linkedIssueId: typeof r.linkedIssueId === 'string' ? r.linkedIssueId : null,
      createdAt: str(r.createdAt),
      completedAt: typeof r.completedAt === 'string' ? r.completedAt : null,
      failureReason: typeof r.failureReason === 'string' ? r.failureReason : null,
    }))
}

/* ── Goal hierarchy ── */

export interface GoalNode<T extends { id: string; parentId: string | null; level: string }> {
  goal: T
  depth: number
}

const GOAL_LEVEL_ORDER: Record<string, number> = { company: 0, team: 1, agent: 2, task: 3 }

/**
 * Flatten a goal list into depth-first render order (parents before their
 * children, siblings ordered company→team→agent→task then alphabetically by
 * id-stable title where available). Orphaned parentIds (pointing at a goal
 * outside the list) are treated as roots so nothing silently disappears.
 * Cycles are broken by the visited set.
 */
export function buildGoalTree<T extends { id: string; parentId: string | null; level: string; title?: string }>(
  goals: T[]
): Array<GoalNode<T>> {
  const byId = new Map(goals.map((g) => [g.id, g]))
  const children = new Map<string, T[]>()
  const roots: T[] = []

  for (const g of goals) {
    if (g.parentId && byId.has(g.parentId)) {
      const list = children.get(g.parentId) ?? []
      list.push(g)
      children.set(g.parentId, list)
    } else {
      roots.push(g)
    }
  }

  const sortGroup = (list: T[]) =>
    [...list].sort(
      (a, b) =>
        (GOAL_LEVEL_ORDER[a.level] ?? 9) - (GOAL_LEVEL_ORDER[b.level] ?? 9) ||
        (a.title ?? '').localeCompare(b.title ?? '')
    )

  const out: Array<GoalNode<T>> = []
  const visited = new Set<string>()
  const walk = (nodes: T[], depth: number) => {
    for (const g of sortGroup(nodes)) {
      if (visited.has(g.id)) continue
      visited.add(g.id)
      out.push({ goal: g, depth })
      walk(children.get(g.id) ?? [], depth + 1)
    }
  }
  walk(roots, 0)
  // A pure parentId cycle (a→b→a) leaves every member out of `roots`; sweep
  // up anything unvisited so cyclic subgraphs still render (at depth 0).
  for (const g of goals) {
    if (!visited.has(g.id)) walk([g], 0)
  }
  return out
}

/** Goal status-change options offered in the drawer (wire vocabulary). */
export const GOAL_STATUS_OPTIONS: Array<{ status: string; label: string }> = [
  { status: 'planned', label: 'Planned' },
  { status: 'active', label: 'Active' },
  { status: 'achieved', label: 'Achieved' },
  { status: 'cancelled', label: 'Cancelled' },
]

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
