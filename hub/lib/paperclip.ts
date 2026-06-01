import type { Company, Issue, Run, Agent } from '@/types'
import { getPaperclipAuthHeaders, clearPaperclipSession } from '@/lib/paperclipSession'

const PAPERCLIP_BASE = process.env.PAPERCLIP_BASE_URL || 'https://rxfit-paperclip-11747747730.us-central1.run.app'

async function paperclipFetch<T>(path: string, opts?: RequestInit): Promise<T> {
  const url = `${PAPERCLIP_BASE}${path}`
  const authHeaders = await getPaperclipAuthHeaders()
  const res = await fetch(url, {
    ...opts,
    signal: AbortSignal.timeout(10_000), // 10s timeout — prevent indefinite hangs on cold starts
    headers: {
      'Content-Type': 'application/json',
      'Origin': PAPERCLIP_BASE, // Required by Paperclip CORS/auth
      ...authHeaders,
      ...opts?.headers,
    },
    next: { revalidate: 30 }, // ISR: refresh every 30s
  })

  if (!res.ok) {
    // If we get a 401, clear the session so next request re-authenticates
    if (res.status === 401) {
      clearPaperclipSession()
    }
    const body = await res.text().catch(() => 'Unknown error')
    throw new Error(`Paperclip API error ${res.status}: ${body}`)
  }

  return res.json()
}

/* ── Companies ── */

export async function getCompanies(): Promise<Company[]> {
  const data = await paperclipFetch<{ companies: Company[] } | Company[]>('/api/companies')
  // Handle both array and wrapped responses
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
  const res = await paperclipFetch<{ issue: Issue }>(`/api/companies/${companyId}/issues`, {
    method: 'POST',
    body: JSON.stringify(data),
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
