'use client'

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { Agent, Issue, Run } from '@/types'
import type { Goal, Project, Routine } from '@/types'
import {
  normalizeComments,
  normalizeRoutineRuns,
  normalizeWorkspaces,
  type AgentLifecycleAction,
  type IssueComment,
  type RoutineRun,
  type WorkspaceInfo,
  type WorkspaceRuntimeAction,
} from '@/lib/execution-panel'

/* ══════════════════════════════════════════════════════════════════════════
   EXECUTION PANEL HOOKS — Issues & Agents tabs (Phase 2)

   Reads go through the normalized dedicated routes (/api/paperclip/issues,
   /api/paperclip/agents, /api/paperclip/runs). Writes go through the
   [...path] proxy, where the role gate, ownership pre-checks, idempotency,
   and loop detection live. Buttons are hidden client-side by role, but the
   proxy is the enforcement boundary.
   ══════════════════════════════════════════════════════════════════════════ */

async function fetcher<T>(url: string): Promise<T> {
  const res = await fetch(url)
  if (!res.ok) {
    const body = await res.text().catch(() => 'Unknown error')
    const err = new Error(`API error ${res.status}: ${body}`)
    ;(err as any).status = res.status
    throw err
  }
  return res.json()
}

async function writeJson<T>(url: string, method: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  if (!res.ok) {
    const text = await res.text().catch(() => 'Unknown error')
    // Surface the proxy's error message (role gate, loop detector) verbatim —
    // it is written for humans.
    let message = `Request failed (${res.status})`
    try {
      const parsed = JSON.parse(text)
      if (parsed?.error) message = parsed.error
    } catch {
      if (text) message = text
    }
    const err = new Error(message)
    ;(err as any).status = res.status
    throw err
  }
  return res.json().catch(() => ({}) as T)
}

/* ── Issues tab ── */

export function useIssuesPanel(orgId?: string, enabled: boolean = true) {
  const { data, error, isLoading, refetch } = useQuery<{ issues: Issue[] }>({
    queryKey: ['exec-panel', 'issues', orgId ?? 'none'],
    queryFn: () => fetcher(`/api/paperclip/issues?companyId=${encodeURIComponent(orgId!)}&limit=50`),
    enabled: enabled && !!orgId,
    refetchInterval: 60_000,
    refetchOnWindowFocus: false,
    staleTime: 30_000,
    retry: 2,
  })
  return { issues: data?.issues ?? [], isLoading, error: error ?? undefined, refetch }
}

export function useIssueComments(issueId?: string) {
  const { data, error, isLoading, refetch } = useQuery<IssueComment[]>({
    queryKey: ['exec-panel', 'comments', issueId ?? 'none'],
    queryFn: async () => {
      const raw = await fetcher<unknown>(`/api/paperclip/issues/${encodeURIComponent(issueId!)}/comments`)
      return normalizeComments(raw)
    },
    enabled: !!issueId,
    refetchOnWindowFocus: false,
    staleTime: 15_000,
    retry: 1,
  })
  return { comments: data ?? [], isLoading, error: error ?? undefined, refetch }
}

export function useAddComment(orgId?: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ issueId, body }: { issueId: string; body: string }) =>
      writeJson(`/api/paperclip/issues/${encodeURIComponent(issueId)}/comments`, 'POST', { body }),
    onSuccess: (_data, { issueId }) => {
      qc.invalidateQueries({ queryKey: ['exec-panel', 'comments', issueId] })
      qc.invalidateQueries({ queryKey: ['exec-panel', 'issues', orgId ?? 'none'] })
    },
  })
}

export function useUpdateIssueStatus(orgId?: string) {
  const qc = useQueryClient()
  return useMutation({
    // `status` uses Paperclip's wire vocabulary (see ISSUE_STATE_OPTIONS) —
    // this PATCH goes through the [...path] proxy verbatim (admin-gated).
    mutationFn: ({ issueId, status }: { issueId: string; status: string }) =>
      writeJson(`/api/paperclip/issues/${encodeURIComponent(issueId)}`, 'PATCH', { status }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['exec-panel', 'issues', orgId ?? 'none'] })
      qc.invalidateQueries({ queryKey: ['execution-dashboard'] })
    },
  })
}

/* ── Agents tab ── */

export function useAgentsRoster(orgId?: string, enabled: boolean = true) {
  const { data, error, isLoading, refetch } = useQuery<{ agents: Agent[] }>({
    queryKey: ['exec-panel', 'agents', orgId ?? 'none'],
    queryFn: () => fetcher(`/api/paperclip/agents?companyId=${encodeURIComponent(orgId!)}`),
    enabled: enabled && !!orgId,
    refetchInterval: 60_000,
    refetchOnWindowFocus: false,
    staleTime: 30_000,
    retry: 2,
  })
  return { agents: data?.agents ?? [], isLoading, error: error ?? undefined, refetch }
}

export function useAgentRuns(orgId?: string, enabled: boolean = true) {
  const { data, error, isLoading } = useQuery<{ runs: Run[] }>({
    queryKey: ['exec-panel', 'runs', orgId ?? 'none'],
    queryFn: () => fetcher(`/api/paperclip/runs?companyId=${encodeURIComponent(orgId!)}&limit=50`),
    enabled: enabled && !!orgId,
    refetchInterval: 60_000,
    refetchOnWindowFocus: false,
    staleTime: 30_000,
    retry: 2,
  })
  return { runs: data?.runs ?? [], isLoading, error: error ?? undefined }
}

/* ── Routines tab ── */

export function useRoutinesPanel(orgId?: string, enabled: boolean = true) {
  const { data, error, isLoading, refetch } = useQuery<{ routines: Routine[] }>({
    queryKey: ['exec-panel', 'routines', orgId ?? 'none'],
    queryFn: () => fetcher(`/api/paperclip/routines?companyId=${encodeURIComponent(orgId!)}`),
    enabled: enabled && !!orgId,
    refetchInterval: 60_000,
    refetchOnWindowFocus: false,
    staleTime: 30_000,
    retry: 2,
  })
  return { routines: data?.routines ?? [], isLoading, error: error ?? undefined, refetch }
}

export function useRoutineRuns(routineId?: string) {
  const { data, error, isLoading } = useQuery<RoutineRun[]>({
    queryKey: ['exec-panel', 'routine-runs', routineId ?? 'none'],
    queryFn: async () => {
      const raw = await fetcher<unknown>(`/api/paperclip/routines/${encodeURIComponent(routineId!)}/runs?limit=10`)
      return normalizeRoutineRuns(raw)
    },
    enabled: !!routineId,
    refetchOnWindowFocus: false,
    staleTime: 30_000,
    retry: 1,
  })
  return { runs: data ?? [], isLoading, error: error ?? undefined }
}

export function useRoutineAction(orgId?: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ routineId, action }: { routineId: string; action: 'run' | 'pause' | 'resume' }) => {
      if (action === 'run') {
        return writeJson(`/api/paperclip/routines/${encodeURIComponent(routineId)}/run`, 'POST', { source: 'manual' })
      }
      return writeJson(`/api/paperclip/routines/${encodeURIComponent(routineId)}`, 'PATCH', {
        status: action === 'pause' ? 'paused' : 'active',
      })
    },
    onSuccess: (_data, { routineId }) => {
      qc.invalidateQueries({ queryKey: ['exec-panel', 'routines', orgId ?? 'none'] })
      qc.invalidateQueries({ queryKey: ['exec-panel', 'routine-runs', routineId] })
    },
  })
}

/* ── Goals tab ── */

export function useGoalsPanel(orgId?: string, enabled: boolean = true) {
  const { data, error, isLoading, refetch } = useQuery<{ goals: Goal[] }>({
    queryKey: ['exec-panel', 'goals', orgId ?? 'none'],
    queryFn: () => fetcher(`/api/paperclip/goals?companyId=${encodeURIComponent(orgId!)}`),
    enabled: enabled && !!orgId,
    refetchInterval: 60_000,
    refetchOnWindowFocus: false,
    staleTime: 30_000,
    retry: 2,
  })
  return { goals: data?.goals ?? [], isLoading, error: error ?? undefined, refetch }
}

export function useUpdateGoalStatus(orgId?: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ goalId, status }: { goalId: string; status: string }) =>
      writeJson(`/api/paperclip/goals/${encodeURIComponent(goalId)}`, 'PATCH', { status }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['exec-panel', 'goals', orgId ?? 'none'] })
    },
  })
}

/* ── Spaces tab (projects + workspaces) ── */

export function useProjectsPanel(orgId?: string, enabled: boolean = true) {
  const { data, error, isLoading, refetch } = useQuery<{ projects: Project[] }>({
    queryKey: ['exec-panel', 'projects', orgId ?? 'none'],
    queryFn: () => fetcher(`/api/paperclip/projects?companyId=${encodeURIComponent(orgId!)}`),
    enabled: enabled && !!orgId,
    refetchInterval: 60_000,
    refetchOnWindowFocus: false,
    staleTime: 30_000,
    retry: 2,
  })
  return { projects: data?.projects ?? [], isLoading, error: error ?? undefined, refetch }
}

export function useProjectWorkspaces(projectId?: string) {
  const { data, error, isLoading, refetch } = useQuery<WorkspaceInfo[]>({
    queryKey: ['exec-panel', 'workspaces', projectId ?? 'none'],
    queryFn: async () => {
      const raw = await fetcher<unknown>(`/api/paperclip/projects/${encodeURIComponent(projectId!)}/workspaces`)
      return normalizeWorkspaces(raw)
    },
    enabled: !!projectId,
    refetchOnWindowFocus: false,
    staleTime: 30_000,
    retry: 1,
  })
  return { workspaces: data ?? [], isLoading, error: error ?? undefined, refetch }
}

export function useWorkspaceRuntimeAction(projectId?: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ workspaceId, action }: { workspaceId: string; action: WorkspaceRuntimeAction }) =>
      writeJson(
        `/api/paperclip/projects/${encodeURIComponent(projectId!)}/workspaces/${encodeURIComponent(workspaceId)}/runtime-services/${action}`,
        'POST'
      ),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['exec-panel', 'workspaces', projectId ?? 'none'] })
    },
  })
}

export function useAgentAction(orgId?: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ agentId, action }: { agentId: string; action: AgentLifecycleAction }) =>
      writeJson(`/api/paperclip/agents/${encodeURIComponent(agentId)}/${action}`, 'POST', {}),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['exec-panel', 'agents', orgId ?? 'none'] })
      qc.invalidateQueries({ queryKey: ['exec-panel', 'runs', orgId ?? 'none'] })
      qc.invalidateQueries({ queryKey: ['execution-dashboard'] })
    },
  })
}
