import type { Company, Issue, Run, Agent, Project } from '@/types'
import { getPaperclipAuthHeaders, clearPaperclipSession } from '@/lib/paperclipSession'
import { PAPERCLIP_BASE_URL } from '@/lib/paperclipConfig'
import { createLogger } from '@/lib/logger'
import { breaker } from '@/lib/circuit-breaker'
import { withRetry } from '@/lib/retry'
import { loopDetector } from '@/lib/loop-detector'
import crypto from 'crypto'
import {
  CompaniesResponseSchema,
  CompanySchema,
  IssuesResponseSchema,
  IssueResponseSchema,
  AgentsResponseSchema,
  AgentResponseSchema,
  ProjectsResponseSchema,
} from '@/lib/zod-schemas'
import type { ZodType } from 'zod'

const log = createLogger('paperclip')
const PAPERCLIP_BASE = PAPERCLIP_BASE_URL

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
  return {
    ...(raw as unknown as Issue),
    identifier: (raw.identifier as string) ?? String(raw.id ?? '').slice(0, 8),
    priority: PRIORITY_FROM_PAPERCLIP[rawPriority] ?? 'medium',
    state,
    assigneeId: (raw.assigneeId as string | null)
      ?? (raw.assigneeAgentId as string | null)
      ?? null,
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
): Promise<T> {
  const url = `${PAPERCLIP_BASE}${path}`
  const method = opts?.method || 'GET'
  const body = opts?.body

  // 1. Loop detection: Throw error and block sequential redundant writes
  loopDetector.detectAndRecord(method, path, body)

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

  return breaker.execute('paperclip-api', () => withRetry(execute))
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
  const data = await paperclipFetch('/api/companies', undefined, CompaniesResponseSchema)
  return pickArray<Company>(data, 'companies')
}

export async function getCompany(companyId: string): Promise<Company> {
  const data = await paperclipFetch(`/api/companies/${companyId}`, undefined, CompanySchema)
  return pickItem<Company>(data, 'company')
}

export async function createCompany(data: {
  name: string
  description?: string
}): Promise<Company> {
  return paperclipFetch<Company>('/api/companies', {
    method: 'POST',
    body: JSON.stringify(data),
  })
}

export async function deleteCompany(companyId: string): Promise<void> {
  await paperclipFetch<unknown>(`/api/companies/${companyId}`, { method: 'DELETE' })
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
  data: { title: string; description?: string; priority?: string; assigneeId?: string }
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
  }, IssueResponseSchema)
  // The API returns the created issue as a bare object (201)
  return normalizeIssue(pickItem<Record<string, unknown>>(res, 'issue'))
}

export async function updateIssue(
  _companyId: string,
  issueId: string,
  data: { state?: string; priority?: string; assigneeId?: string; title?: string }
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
  opts?: { limit?: number }
): Promise<Run[]> {
  const limit = opts?.limit ?? 20

  // Recent issues first (the API sorts by updated desc by default)
  const [issues, agents] = await Promise.all([
    getIssues(companyId, { limit: 10 }),
    getAgents(companyId).catch(() => [] as Agent[]),
  ])
  if (issues.length === 0) return []

  const agentNames = new Map(agents.map(a => [a.id, a.name]))

  const runArrays = await Promise.all(
    issues.slice(0, 8).map(async (issue) => {
      try {
        const data = await paperclipFetch(`/api/issues/${issue.id}/runs`)
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
      } catch {
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
  )
  return pickArray<Project>(data, 'projects')
}

/* ── Agents ── */

export async function getAgents(companyId: string): Promise<Agent[]> {
  const data = await paperclipFetch(
    `/api/companies/${companyId}/agents`,
    undefined,
    AgentsResponseSchema,
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
  data: { name: string; role?: string; instructions?: string; adapterType?: string }
): Promise<Agent> {
  const res = await paperclipFetch(
    `/api/companies/${companyId}/agents`,
    {
      method: 'POST',
      body: JSON.stringify(data),
    },
    AgentResponseSchema,
  )
  return normalizeAgent(pickItem<Record<string, unknown>>(res, 'agent'))
}

export async function updateAgent(
  _companyId: string,
  agentId: string,
  data: { name?: string; instructions?: string; status?: string }
): Promise<Agent> {
  const res = await paperclipFetch(
    `/api/agents/${agentId}`,
    {
      method: 'PATCH',
      body: JSON.stringify(data),
    },
    AgentResponseSchema,
  )
  return normalizeAgent(pickItem<Record<string, unknown>>(res, 'agent'))
}

export async function deleteAgent(_companyId: string, agentId: string): Promise<void> {
  await paperclipFetch<unknown>(
    `/api/agents/${agentId}`,
    { method: 'DELETE' },
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
