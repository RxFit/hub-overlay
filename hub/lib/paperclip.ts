import type { Company, Issue, Run, Agent } from '@/types'

const PAPERCLIP_BASE = process.env.PAPERCLIP_BASE_URL || 'https://rxfit-paperclip-11747747730.us-central1.run.app'
const PAPERCLIP_KEY = process.env.PAPERCLIP_API_KEY || ''

async function paperclipFetch<T>(path: string, opts?: RequestInit): Promise<T> {
  const url = `${PAPERCLIP_BASE}${path}`
  const res = await fetch(url, {
    ...opts,
    headers: {
      'Content-Type': 'application/json',
      ...(PAPERCLIP_KEY ? { 'Authorization': `Bearer ${PAPERCLIP_KEY}` } : {}),
      ...opts?.headers,
    },
    next: { revalidate: 30 }, // ISR: refresh every 30s
  })

  if (!res.ok) {
    const body = await res.text().catch(() => 'Unknown error')
    throw new Error(`Paperclip API error ${res.status}: ${body}`)
  }

  return res.json()
}

/* ── Companies ── */

export async function getCompanies(): Promise<Company[]> {
  const data = await paperclipFetch<{ companies: Company[] }>('/api/companies')
  return data.companies ?? []
}

export async function getCompany(companyId: string): Promise<Company> {
  return paperclipFetch<Company>(`/api/companies/${companyId}`)
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

/* ── Health Check ── */

export async function checkHealth(): Promise<boolean> {
  try {
    const res = await fetch(`${PAPERCLIP_BASE}/api/health`, { next: { revalidate: 60 } })
    return res.ok
  } catch {
    return false
  }
}
