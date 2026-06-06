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
  RunsResponseSchema,
  AgentsResponseSchema,
  AgentResponseSchema,
  ProjectsResponseSchema,
} from '@/lib/zod-schemas'
import type { ZodType } from 'zod'

const log = createLogger('paperclip')
const PAPERCLIP_BASE = PAPERCLIP_BASE_URL

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
  if (Array.isArray(data)) return data
  return data.companies ?? []
}

export async function getCompany(companyId: string): Promise<Company> {
  return paperclipFetch(`/api/companies/${companyId}`, undefined, CompanySchema)
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
  if (opts?.stateGroup) params.set('state_group', opts.stateGroup)
  const qs = params.toString() ? `?${params}` : ''
  const data = await paperclipFetch(
    `/api/companies/${companyId}/issues${qs}`,
    undefined,
    IssuesResponseSchema,
  )
  return data.issues ?? []
}

export async function getIssue(companyId: string, issueId: string): Promise<Issue> {
  const data = await paperclipFetch(
    `/api/companies/${companyId}/issues/${issueId}`,
    undefined,
    IssueResponseSchema,
  )
  return data.issue
}

export async function createIssue(
  companyId: string,
  data: { title: string; description?: string; priority?: string; assigneeId?: string }
): Promise<Issue> {
  // Paperclip API expects `assigneeAgentId`, not `assigneeId`
  const { assigneeId, ...rest } = data
  const payload = assigneeId ? { ...rest, assigneeAgentId: assigneeId } : rest
  const res = await paperclipFetch(`/api/companies/${companyId}/issues`, {
    method: 'POST',
    body: JSON.stringify(payload),
  }, IssueResponseSchema)
  return res.issue
}

export async function updateIssue(
  companyId: string,
  issueId: string,
  data: { state?: string; priority?: string; assigneeId?: string; title?: string }
): Promise<Issue> {
  const res = await paperclipFetch(
    `/api/companies/${companyId}/issues/${issueId}`,
    {
      method: 'PATCH',
      body: JSON.stringify(data),
    },
    IssueResponseSchema,
  )
  return res.issue
}

/* ── Runs ── */

export async function getRuns(
  companyId: string,
  opts?: { limit?: number }
): Promise<Run[]> {
  const params = new URLSearchParams()
  if (opts?.limit) params.set('limit', String(opts.limit))
  const qs = params.toString() ? `?${params}` : ''
  const data = await paperclipFetch(
    `/api/companies/${companyId}/runs${qs}`,
    undefined,
    RunsResponseSchema,
  )
  return data.runs ?? []
}

/* ── Projects ── */

export async function getProjects(companyId: string): Promise<Project[]> {
  const data = await paperclipFetch(
    `/api/companies/${companyId}/projects`,
    undefined,
    ProjectsResponseSchema,
  )
  return data.projects ?? []
}

/* ── Agents ── */

export async function getAgents(companyId: string): Promise<Agent[]> {
  const data = await paperclipFetch(
    `/api/companies/${companyId}/agents`,
    undefined,
    AgentsResponseSchema,
  )
  return data.agents ?? []
}

export async function getAgent(companyId: string, agentId: string): Promise<Agent> {
  const data = await paperclipFetch(
    `/api/companies/${companyId}/agents/${agentId}`,
    undefined,
    AgentResponseSchema,
  )
  return data.agent
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
  return res.agent
}

export async function updateAgent(
  companyId: string,
  agentId: string,
  data: { name?: string; instructions?: string; status?: string }
): Promise<Agent> {
  const res = await paperclipFetch(
    `/api/companies/${companyId}/agents/${agentId}`,
    {
      method: 'PATCH',
      body: JSON.stringify(data),
    },
    AgentResponseSchema,
  )
  return res.agent
}

export async function deleteAgent(companyId: string, agentId: string): Promise<void> {
  await paperclipFetch<unknown>(
    `/api/companies/${companyId}/agents/${agentId}`,
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
