import type { Company, Issue, Run, Agent, Project } from '@/types'
import { getPaperclipAuthHeaders, clearPaperclipSession } from '@/lib/paperclipSession'
import { PAPERCLIP_BASE_URL } from '@/lib/paperclipConfig'
import { createLogger } from '@/lib/logger'
import { breaker } from '@/lib/circuit-breaker'
import { withRetry } from '@/lib/retry'
import { loopDetector } from '@/lib/loop-detector'
import { getTenantId } from './tenant-context'
import { isProtectedCompany } from '@/lib/protected-workspaces'
import crypto from 'crypto'
import {
  CompaniesResponseSchema,
  CompanySchema,
  IssuesResponseSchema,
  IssueResponseSchema,
  AgentsResponseSchema,
  AgentResponseSchema,
  ProjectsResponseSchema,
  RunsResponseSchema,
} from '@/lib/zod-schemas'
import type { ZodType } from 'zod'

const log = createLogger('paperclip')
const PAPERCLIP_BASE = PAPERCLIP_BASE_URL

/**
 * Thrown when a Paperclip *list* response fails schema validation.
 *
 * List helpers previously logged a warning and returned the raw, unvalidated
 * payload on a schema mismatch; `pickArray` / per-issue catches then collapsed
 * that to `[]`, so a genuine fetch/parse failure was indistinguishable from a
 * legitimately empty list. Throwing this typed error makes a wrong-SHAPE
 * response (expected array, got object; required field missing/wrong type) an
 * observable failure. Unknown EXTRA fields still pass via `.passthrough()`.
 *
 * Callers that must degrade gracefully in the UI catch this and fall back to
 * `[]` at the call site — the throw exists so the failure is not swallowed
 * silently inside `paperclipFetch`.
 */
export class PaperclipSchemaError extends Error {
  readonly path: string
  readonly issues: unknown
  constructor(path: string, issues: unknown) {
    super(`Paperclip response schema mismatch for ${path}`)
    this.name = 'PaperclipSchemaError'
    this.path = path
    this.issues = issues
  }
}

/** True when `assigneeId` matches an agent belonging to the resolved company. */
export function isAgentMemberOfCompany(agents: Agent[], assigneeId: string): boolean {
  return agents.some((a) => a.id === assigneeId)
}

/* ══════════════════════════════════════════════════════════════════════════
   PAPERCLIP API CONTRACT NORMALIZATION

   The live Paperclip server (paperclipai / @paperclipai/server):
   - Returns BARE arrays/objects (not `{ issues: [...] }` wrappers)
   - Issues carry a flat `status` string
     (backlog | todo | in_progress | in_review | done | blocked | cancelled),
     NOT a Linear-style `state: { group, name }` object
   - Issue priorities are critical | high | medium | low (no urgent/none)
   - Assignee field is `assigneeAgentId` (not `assigneeId`)
   - Single-issue routes live at /api/issues/:id (NOT company-scoped)
   - Agent routes for update/delete live at /api/agents/:id
   - There is NO /api/companies/:id/runs endpoint — runs are per-issue
     at /api/issues/:id/runs

   The Hub's internal types (types/index.ts) predate this contract, so this
   module normalizes at the boundary: every helper tolerates BOTH the bare
   and wrapped response shapes, and maps Paperclip-native fields onto the
   Hub's internal Issue/Agent/Run shapes.
   ══════════════════════════════════════════════════════════════════════════ */

/** Tolerate both bare-array and `{ [key]: [...] }` wrapped responses. */
function pickArray<T>(data: unknown, key: string): T[] {
  if (Array.isArray(data)) return data as T[]
  if (data && typeof data === 'object') {
    const inner = (data as Record<string, unknown>)[key]
    if (Array.isArray(inner)) return inner as T[]
  }
  return []
}

/** Tolerate both bare-object and `{ [key]: {...} }` wrapped responses. */
function pickItem<T>(data: unknown, key: string): T {
  if (data && typeof data === 'object' && !Array.isArray(data)) {
    const inner = (data as Record<string, unknown>)[key]
    if (inner && typeof inner === 'object') return inner as T
  }
  return data as T
}

/** Paperclip `status` → Hub IssueState (Linear-style group used across the UI). */
const STATUS_TO_STATE: Record<string, { group: Issue['state']['group']; name: string }> = {
  backlog:     { group: 'backlog',   name: 'Backlog' },
  todo:        { group: 'unstarted', name: 'Todo' },
  in_progress: { group: 'started',   name: 'In Progress' },
  in_review:   { group: 'started',   name: 'In Review' },
  blocked:     { group: 'started',   name: 'Blocked' },
  done:        { group: 'completed', name: 'Done' },
  cancelled:   { group: 'cancelled', name: 'Cancelled' },
}

/** Hub state-group / friendly names → Paperclip `status` values. */
const STATE_TO_STATUS: Record<string, string> = {
  backlog: 'backlog',
  unstarted: 'todo', todo: 'todo', open: 'todo',
  started: 'in_progress', in_progress: 'in_progress',
  in_review: 'in_review', review: 'in_review',
  blocked: 'blocked',
  completed: 'done', done: 'done',
  cancelled: 'cancelled', canceled: 'cancelled',
}

/** Hub priority vocabulary → Paperclip (`urgent`→`critical`, `none`→`low`). */
const PRIORITY_TO_PAPERCLIP: Record<string, string> = {
  urgent: 'critical', critical: 'critical',
  high: 'high', medium: 'medium', low: 'low', none: 'low',
}

/** Paperclip priority → Hub vocabulary (`critical`→`urgent`). */
const PRIORITY_FROM_PAPERCLIP: Record<string, Issue['priority']> = {
  critical: 'urgent', urgent: 'urgent',
  high: 'high', medium: 'medium', low: 'low', none: 'none',
}

/** Map a raw Paperclip issue onto the Hub's internal Issue shape. */
function normalizeIssue(raw: Record<string, unknown>): Issue {
  const status = typeof raw.status === 'string' ? raw.status : undefined
  const existingState = raw.state as Issue['state'] | undefined
  const mapped = status ? STATUS_TO_STATE[status] : undefined
  const state: Issue['state'] = existingState?.group
    ? existingState
    : {
        id: status ?? 'unknown',
        name: mapped?.name ?? (status ?? 'Unknown'),
        group: mapped?.group ?? 'backlog',
        color: '#999999',
      }
  const rawPriority = typeof raw.priority === 'string' ? raw.priority : 'medium'
  // Paperclip distinguishes agent assignment (assigneeAgentId) from human/board
  // assignment (assigneeUserId). Capturing only the agent id meant human-assigned
  // issues showed no assignee (audit P1-3).
  const assigneeAgentId = (raw.assigneeAgentId as string | null) ?? (raw.assigneeId as string | null) ?? null
  const assigneeUserId = (raw.assigneeUserId as string | null) ?? null
  return {
    ...(raw as unknown as Issue),
    identifier: (raw.identifier as string) ?? String(raw.id ?? '').slice(0, 8),
    priority: PRIORITY_FROM_PAPERCLIP[rawPriority] ?? 'medium',
    state,
    assigneeId: assigneeAgentId ?? assigneeUserId,
    assigneeUserId,
    assigneeType: assigneeAgentId ? 'agent' : assigneeUserId ? 'user' : null,
    assigneeName: (raw.assigneeName as string | null) ?? null,
  }
}

/** Paperclip agent statuses → the Hub's 3-state model. */
const AGENT_STATUS_MAP: Record<string, Agent['status']> = {
  active: 'active', running: 'active',
  idle: 'inactive', paused: 'inactive', pending_approval: 'inactive',
  terminated: 'inactive', inactive: 'inactive',
  error: 'error',
}

/** Map a raw Paperclip agent onto the Hub's internal Agent shape. */
function normalizeAgent(raw: Record<string, unknown>): Agent {
  const rawStatus = typeof raw.status === 'string' ? raw.status : 'inactive'
  return {
    ...(raw as unknown as Agent),
    adapter: (raw.adapter as string) ?? (raw.adapterType as string) ?? 'unknown',
    status: AGENT_STATUS_MAP[rawStatus] ?? 'inactive',
    lastHeartbeat: (raw.lastHeartbeat as string | null)
      ?? (raw.lastHeartbeatAt as string | null)
      ?? null,
  }
}

/** Paperclip heartbeat-run statuses → the Hub's Run status model. */
const RUN_STATUS_MAP: Record<string, Run['status']> = {
  queued: 'queued', scheduled_retry: 'queued',
  running: 'running',
  succeeded: 'completed', completed: 'completed',
  failed: 'failed', timed_out: 'failed',
  cancelled: 'cancelled',
}

/**
 * Shared Paperclip fetch wrapper.
 * - Session-based auth via paperclipSession.ts
 * - Auto-retry once on 401 (re-authenticates then retries)
 * - Circuit breaker prevents hammering a down API
 * - Retry with exponential backoff on transient errors
 * - Zod schema validation on responses
 * - 10s timeout on all requests
 */
export async function paperclipFetch<T>(
  path: string,
  opts?: RequestInit,
  schema?: ZodType<T>,
  scope?: string,
  // List endpoints pass `true`: a schema mismatch throws PaperclipSchemaError
  // instead of returning raw data, so a parse failure is a real (observable)
  // error rather than a silently-empty list. Detail endpoints keep the
  // lenient default so a slightly-off-but-successful mutation response is not
  // turned into a failure.
  strictSchema = false,
): Promise<T> {
  const url = `${PAPERCLIP_BASE}${path}`
  const method = opts?.method || 'GET'
  const body = opts?.body

  // 1. Loop detection: Throw error and block sequential redundant writes
  // ARCHITECTURAL DECISION (2026-06-14):
  // The `scope` parameter is caller-provided. In the proxy route (route.ts),
  // scope = session.user.email (per-user isolation). Here in the server-side
  // path, scope comes from the caller — if omitted, defaults to '__global__'.
  // This is intentional: server-side calls (e.g. agent orchestration) are not
  // user-scoped, so they share a global loop detection window. If a future
  // caller needs per-tenant loop isolation, pass `tenantId` as the scope.
  loopDetector.detectAndRecord(method, path, body, scope)

  // 2. Idempotency headers: Attach unique key for writes to prevent duplicate execution on retry
  let finalOpts = opts
  if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(method.toUpperCase())) {
    const headers = new Headers(opts?.headers)
    if (!headers.has('Idempotency-Key')) {
      headers.set('Idempotency-Key', crypto.randomUUID())
    }
    finalOpts = {
      ...opts,
      headers: Object.fromEntries(headers.entries()),
    }
  }

  const execute = async () => {
    // First attempt
    let res = await doPaperclipFetch(url, finalOpts)

    // F4 fix: On 401, clear session, re-authenticate, and retry once
    if (res.status === 401) {
      log.warn({ path, status: 401 }, 'Auth expired, re-authenticating')
      clearPaperclipSession()
      res = await doPaperclipFetch(url, finalOpts)
    }

    if (!res.ok) {
      const bodyText = await res.text().catch(() => 'Unknown error')
      throw new Error(`Paperclip API error ${res.status}: ${bodyText}`)
    }

    const json = await res.json()

    // Validate response against Zod schema when provided
    if (schema) {
      const result = schema.safeParse(json)
      if (!result.success) {
        if (strictSchema) {
          // List boundary: a wrong-shape payload is a real error, not an
          // empty list. Throw so callers can distinguish empty from failure.
          log.error(
            { path, errors: result.error.issues },
            'Paperclip list response failed schema validation — rejecting',
          )
          throw new PaperclipSchemaError(path, result.error.issues)
        }
        log.warn(
          { path, errors: result.error.issues },
          'Paperclip response schema mismatch — using raw data',
        )
        // Return raw data instead of crashing — graceful degradation
        return json as T
      }
      return result.data
    }

    return json as T
  }

  const tenantId = getTenantId()
  return breaker.execute(`${tenantId}:paperclip-api`, () => withRetry(execute))
}

/** Build and execute a single fetch to Paperclip with current auth. */
async function doPaperclipFetch(url: string, opts?: RequestInit): Promise<Response> {
  const authHeaders = await getPaperclipAuthHeaders()
  return fetch(url, {
    ...opts,
    signal: AbortSignal.timeout(10_000),
    headers: {
      'Content-Type': 'application/json',
      Origin: PAPERCLIP_BASE,
      ...authHeaders,
      ...opts?.headers,
    },
    next: { revalidate: 30 },
  })
}

/* ── Companies ── */

export async function getCompanies(): Promise<Company[]> {
  const data = await paperclipFetch('/api/companies', undefined, CompaniesResponseSchema, undefined, true)
  return pickArray<Company>(data, 'companies')
}

export async function getCompany(companyId: string): Promise<Company> {
  const data = await paperclipFetch(`/api/companies/${companyId}`, undefined, CompanySchema)
  return pickItem<Company>(data, 'company')
}

export async function createCompany(data: {
  name: string
  description?: string
}, scope?: string): Promise<Company> {
  return paperclipFetch<Company>('/api/companies', {
    method: 'POST',
    body: JSON.stringify(data),
  }, undefined, scope)
}

export async function deleteCompany(companyId: string, scope?: string): Promise<void> {
  // SAFETY (defense in depth): protected workspaces are load-bearing and must
  // never be deleted. The proxy DELETE handler is the primary guard; this throw
  // protects any server-side caller of the helper too.
  if (isProtectedCompany(companyId)) {
    throw new Error('This workspace is protected and cannot be deleted.')
  }
  await paperclipFetch<unknown>(`/api/companies/${companyId}`, { method: 'DELETE' }, undefined, scope)
}

/* ── Issues ── */

export async function getIssues(
  companyId: string,
  opts?: { limit?: number; stateGroup?: string }
): Promise<Issue[]> {
  const params = new URLSearchParams()
  if (opts?.limit) params.set('limit', String(opts.limit))
  // Paperclip filters by `status` (comma-separated), not Linear's `state_group`
  if (opts?.stateGroup) {
    const status = STATE_TO_STATUS[opts.stateGroup.toLowerCase()]
    if (status) {
      params.set(
        'status',
        opts.stateGroup === 'started' ? 'in_progress,in_review,blocked' : status,
      )
    }
  }
  const qs = params.toString() ? `?${params}` : ''
  const data = await paperclipFetch(
    `/api/companies/${companyId}/issues${qs}`,
    undefined,
    IssuesResponseSchema,
    undefined,
    true,
  )
  return pickArray<Record<string, unknown>>(data, 'issues').map(normalizeIssue)
}

// Single-issue routes are NOT company-scoped in Paperclip (/api/issues/:id).
// companyId is kept in the signature for call-site compatibility.
export async function getIssue(_companyId: string, issueId: string): Promise<Issue> {
  const data = await paperclipFetch(
    `/api/issues/${issueId}`,
    undefined,
    IssueResponseSchema,
  )
  return normalizeIssue(pickItem<Record<string, unknown>>(data, 'issue'))
}

export async function createIssue(
  companyId: string,
  data: { title: string; description?: string; priority?: string; assigneeId?: string },
  scope?: string
): Promise<Issue> {
  // Paperclip API expects `assigneeAgentId` (not `assigneeId`) and the
  // critical|high|medium|low priority vocabulary (no urgent/none).
  const { assigneeId, priority, ...rest } = data
  const payload: Record<string, unknown> = { ...rest }
  if (assigneeId) payload.assigneeAgentId = assigneeId
  if (priority) payload.priority = PRIORITY_TO_PAPERCLIP[priority.toLowerCase()] ?? 'medium'
  const res = await paperclipFetch(`/api/companies/${companyId}/issues`, {
    method: 'POST',
    body: JSON.stringify(payload),
  }, IssueResponseSchema, scope)
  // The API returns the created issue as a bare object (201)
  return normalizeIssue(pickItem<Record<string, unknown>>(res, 'issue'))
}

export async function updateIssue(
  _companyId: string,
  issueId: string,
  data: { state?: string; priority?: string; assigneeId?: string; title?: string },
  scope?: string
): Promise<Issue> {
  // Translate the Hub's update vocabulary onto Paperclip's PATCH /api/issues/:id
  // contract: `status` (not `state`), `assigneeAgentId` (not `assigneeId`).
  const payload: Record<string, unknown> = {}
  if (data.title) payload.title = data.title
  if (data.state) payload.status = STATE_TO_STATUS[data.state.toLowerCase()] ?? data.state
  if (data.priority) payload.priority = PRIORITY_TO_PAPERCLIP[data.priority.toLowerCase()] ?? data.priority
  if (data.assigneeId) payload.assigneeAgentId = data.assigneeId
  const res = await paperclipFetch(
    `/api/issues/${issueId}`,
    {
      method: 'PATCH',
      body: JSON.stringify(payload),
    },
    IssueResponseSchema,
    scope
  )
  return normalizeIssue(pickItem<Record<string, unknown>>(res, 'issue'))
}

/* ── Runs ── */

/**
 * Paperclip has NO /api/companies/:id/runs endpoint — runs are per-issue at
 * /api/issues/:id/runs. This aggregates runs across the company's most
 * recently updated issues and maps them onto the Hub's Run shape.
 */
export async function getRuns(
  companyId: string,
  opts?: { limit?: number; issues?: Issue[]; agents?: Agent[] }
): Promise<Run[]> {
  const limit = opts?.limit ?? 20

  // Recent issues first (the API sorts by updated desc by default).
  //
  // Call-reduction (P1): a caller that already holds the company's issues/agents
  // (e.g. the KPI route fetches getIssues(limit:100) + getAgents) can pass them in
  // so getRuns doesn't re-fetch — cutting two redundant upstream Paperclip calls
  // per company. When omitted we fetch exactly as before (backward-compatible).
  // The top-8 slice below is unaffected: both a 100- and a 10-limit issue list are
  // sorted updated-desc, so their first 8 issues are identical → same runs.
  const [issues, agents] = await Promise.all([
    opts?.issues ?? getIssues(companyId, { limit: 10 }),
    opts?.agents ?? getAgents(companyId).catch(() => [] as Agent[]),
  ])
  if (issues.length === 0) return []

  const agentNames = new Map(agents.map(a => [a.id, a.name]))

  const runArrays = await Promise.all(
    issues.slice(0, 8).map(async (issue) => {
      try {
        const data = await paperclipFetch(
          `/api/issues/${issue.id}/runs`,
          undefined,
          RunsResponseSchema,
          undefined,
          true,
        )
        return pickArray<Record<string, unknown>>(data, 'runs').map((raw): Run => {
          const rawStatus = typeof raw.status === 'string' ? raw.status : 'queued'
          const startedAt = (raw.startedAt as string | null) ?? null
          const completedAt = (raw.completedAt as string | null)
            ?? (raw.finishedAt as string | null)
            ?? null
          const durationMs = (raw.durationMs as number | null)
            ?? (startedAt && completedAt
              ? new Date(completedAt).getTime() - new Date(startedAt).getTime()
              : null)
          const agentId = (raw.agentId as string) ?? ''
          return {
            id: (raw.id as string) ?? (raw.runId as string) ?? '',
            status: RUN_STATUS_MAP[rawStatus] ?? 'queued',
            agentId,
            agentName: (raw.agentName as string)
              ?? agentNames.get(agentId)
              ?? (raw.adapterType as string)
              ?? 'Unknown agent',
            issueId: issue.id,
            issueIdentifier: issue.identifier,
            model: (raw.model as string | null) ?? null,
            startedAt,
            completedAt,
            durationMs,
            companyId,
          }
        })
      } catch (err) {
        // Degrade this issue's runs to [] so one bad payload doesn't sink the
        // whole aggregation — but log it (PaperclipSchemaError included) so the
        // failure is observable rather than silently swallowed.
        log.warn({ issueId: issue.id, err }, 'Failed to fetch/parse runs for issue — skipping')
        return [] as Run[]
      }
    })
  )

  return runArrays
    .flat()
    .sort((a, b) => {
      const ta = a.startedAt ? new Date(a.startedAt).getTime() : 0
      const tb = b.startedAt ? new Date(b.startedAt).getTime() : 0
      return tb - ta
    })
    .slice(0, limit)
}

/* ── Projects ── */

export async function getProjects(companyId: string): Promise<Project[]> {
  const data = await paperclipFetch(
    `/api/companies/${companyId}/projects`,
    undefined,
    ProjectsResponseSchema,
    undefined,
    true,
  )
  return pickArray<Project>(data, 'projects')
}

/* ── Agents ── */

export async function getAgents(companyId: string): Promise<Agent[]> {
  const data = await paperclipFetch(
    `/api/companies/${companyId}/agents`,
    undefined,
    AgentsResponseSchema,
    undefined,
    true,
  )
  return pickArray<Record<string, unknown>>(data, 'agents').map(normalizeAgent)
}

// Single-agent routes are NOT company-scoped in Paperclip (/api/agents/:id).
// companyId is kept in the signature for call-site compatibility.
export async function getAgent(_companyId: string, agentId: string): Promise<Agent> {
  const data = await paperclipFetch(
    `/api/agents/${agentId}`,
    undefined,
    AgentResponseSchema,
  )
  return normalizeAgent(pickItem<Record<string, unknown>>(data, 'agent'))
}

export async function createAgent(
  companyId: string,
  data: { name: string; role?: string; instructions?: string; adapterType?: string },
  scope?: string
): Promise<Agent> {
  const res = await paperclipFetch(
    `/api/companies/${companyId}/agents`,
    {
      method: 'POST',
      body: JSON.stringify(data),
    },
    AgentResponseSchema,
    scope
  )
  return normalizeAgent(pickItem<Record<string, unknown>>(res, 'agent'))
}

export async function updateAgent(
  _companyId: string,
  agentId: string,
  data: { name?: string; instructions?: string; status?: string },
  scope?: string
): Promise<Agent> {
  const res = await paperclipFetch(
    `/api/agents/${agentId}`,
    {
      method: 'PATCH',
      body: JSON.stringify(data),
    },
    AgentResponseSchema,
    scope
  )
  return normalizeAgent(pickItem<Record<string, unknown>>(res, 'agent'))
}

export async function deleteAgent(_companyId: string, agentId: string, scope?: string): Promise<void> {
  await paperclipFetch<unknown>(
    `/api/agents/${agentId}`,
    { method: 'DELETE' },
    undefined,
    scope
  )
}

/* ── Health Check ── */

export async function checkHealth(): Promise<boolean> {
  try {
    const res = await fetch(`${PAPERCLIP_BASE}/api/health`, {
      signal: AbortSignal.timeout(10_000),
      next: { revalidate: 60 },
    })
    return res.ok
  } catch {
    return false
  }
}
