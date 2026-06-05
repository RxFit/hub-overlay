import type { Company, Issue, Run, Agent } from '@/types'
import { getPaperclipAuthHeaders, clearPaperclipSession } from '@/lib/paperclipSession'
import { PAPERCLIP_BASE_URL } from '@/lib/paperclipConfig'

const PAPERCLIP_BASE = PAPERCLIP_BASE_URL

/**
 * Shared Paperclip fetch wrapper.
 * - Session-based auth via paperclipSession.ts
 * - Auto-retry once on 401 (re-authenticates then retries)
 * - 10s timeout on all requests
 */
async function paperclipFetch<T>(path: string, opts?: RequestInit): Promise<T> {
  const url = `${PAPERCLIP_BASE}${path}`

  // First attempt
  let res = await doPaperclipFetch(url, opts)

  // F4 fix: On 401, clear session, re-authenticate, and retry once
  if (res.status === 401) {
    clearPaperclipSession()
    res = await doPaperclipFetch(url, opts)
  }

  if (!res.ok) {
    const body = await res.text().catch(() => 'Unknown error')
    throw new Error(`Paperclip API error ${res.status}: ${body}`)
  }

  return res.json()
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
  const data = await paperclipFetch<{ companies: Company[] } | Company[]>('/api/companies')
  if (Array.isArray(data)) return data
  return data.companies ?? []
}

export async function getCompany(companyId: string): Promise<Company> {
  return paperclipFetch<Company>(`/api/companies/${companyId}`)
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
  const data = await paperclipFetch<{ issues: Issue[] }>(
    `/api/companies/${companyId}/issues${qs}`
  )
  return data.issues ?? []
}

export async function getIssue(companyId: string, issueId: string): Promise<Issue> {
  const data = await paperclipFetch<{ issue: Issue }>(
    `/api/companies/${companyId}/issues/${issueId}`
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
  const res = await paperclipFetch<{ issue: Issue }>(`/api/companies/${companyId}/issues`, {
    method: 'POST',
    body: JSON.stringify(payload),
  })
  return res.issue
}

export async function updateIssue(
  companyId: string,
  issueId: string,
  data: { state?: string; priority?: string; assigneeId?: string; title?: string }
): Promise<Issue> {
  const res = await paperclipFetch<{ issue: Issue }>(
    `/api/companies/${companyId}/issues/${issueId}`,
    {
      method: 'PATCH',
      body: JSON.stringify(data),
    }
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
  const data = await paperclipFetch<{ runs: Run[] }>(
    `/api/companies/${companyId}/runs${qs}`
  )
  return data.runs ?? []
}

/* ── Agents ── */

export async function getAgents(companyId: string): Promise<Agent[]> {
  const data = await paperclipFetch<{ agents: Agent[] }>(
    `/api/companies/${companyId}/agents`
  )
  return data.agents ?? []
}

export async function getAgent(companyId: string, agentId: string): Promise<Agent> {
  const data = await paperclipFetch<{ agent: Agent }>(
    `/api/companies/${companyId}/agents/${agentId}`
  )
  return data.agent
}

export async function createAgent(
  companyId: string,
  data: { name: string; role?: string; instructions?: string; adapterType?: string }
): Promise<Agent> {
  const res = await paperclipFetch<{ agent: Agent }>(
    `/api/companies/${companyId}/agents`,
    {
      method: 'POST',
      body: JSON.stringify(data),
    }
  )
  return res.agent
}

export async function updateAgent(
  companyId: string,
  agentId: string,
  data: { name?: string; instructions?: string; status?: string }
): Promise<Agent> {
  const res = await paperclipFetch<{ agent: Agent }>(
    `/api/companies/${companyId}/agents/${agentId}`,
    {
      method: 'PATCH',
      body: JSON.stringify(data),
    }
  )
  return res.agent
}

export async function deleteAgent(companyId: string, agentId: string): Promise<void> {
  await paperclipFetch<unknown>(
    `/api/companies/${companyId}/agents/${agentId}`,
    { method: 'DELETE' }
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
