'use client'

import { useMemo, useState } from 'react'
import type { Agent, Run } from '@/types'
import { ROLE_RANK } from '@/lib/proxyAuthz'
import {
  AGENT_ACTION_LABELS,
  availableAgentActions,
  type AgentLifecycleAction,
} from '@/lib/execution-panel'
import { useAgentsRoster, useAgentRuns, useAgentAction } from '@/app/hooks/useExecutionPanel'

/* ══════════════════════════════════════════════════════════════════════════════
   AGENTS TAB (Phase 2) — the roster + triage loop.

   Replaces the mobile Paperclip triage flow: see a failed run → read the
   outcome → clear the error → wake the agent, all in the panel. Lifecycle
   actions (wake/pause/resume/clear-error) are admin-tier; the [...path] proxy
   enforces that server-side, the role check here only hides the buttons.
   ══════════════════════════════════════════════════════════════════════════════ */

function relTime(iso?: string | null): string {
  if (!iso) return 'never'
  try {
    const diffMs = Date.now() - new Date(iso).getTime()
    const mins = Math.floor(diffMs / 60_000)
    if (mins < 1) return 'just now'
    if (mins < 60) return `${mins}m ago`
    const hours = Math.floor(mins / 60)
    if (hours < 24) return `${hours}h ago`
    return `${Math.floor(hours / 24)}d ago`
  } catch {
    return ''
  }
}

function statusLabel(agent: Agent): string {
  return (agent.rawStatus ?? agent.status).replace(/_/g, ' ')
}

function AgentRuns({ runs }: { runs: Run[] }) {
  if (runs.length === 0) return <div className="exec-muted">No recent runs</div>
  return (
    <div className="exec-runs" role="list" aria-label="Recent runs">
      {runs.slice(0, 5).map((run) => (
        <div key={run.id} className="exec-run" role="listitem" data-run-status={run.status}>
          <span className="exec-run__status">{run.status}</span>
          <span className="exec-run__issue">{run.issueIdentifier}</span>
          <span className="exec-run__time">
            {relTime(run.completedAt ?? run.startedAt)}
            {run.durationMs != null && ` · ${Math.round(run.durationMs / 1000)}s`}
          </span>
        </div>
      ))}
    </div>
  )
}

function AgentCard({
  agent,
  runs,
  canAct,
  orgId,
  onInjectChat,
}: {
  agent: Agent
  runs: Run[]
  canAct: boolean
  orgId?: string
  onInjectChat: (msg: string) => void
}) {
  const [expanded, setExpanded] = useState(false)
  const agentAction = useAgentAction(orgId)
  const [pendingAction, setPendingAction] = useState<AgentLifecycleAction | null>(null)

  const actions = canAct ? availableAgentActions(agent) : []
  const agentRuns = useMemo(() => runs.filter((r) => r.agentId === agent.id), [runs, agent.id])
  const lastFailed = agentRuns.find((r) => r.status === 'failed')

  const runAction = (action: AgentLifecycleAction) => {
    if (agentAction.isPending) return
    setPendingAction(action)
    agentAction.mutate({ agentId: agent.id, action }, { onSettled: () => setPendingAction(null) })
  }

  return (
    <div className="agent-card" data-agent-status={agent.status}>
      <button className="agent-card__head" onClick={() => setExpanded(!expanded)} aria-expanded={expanded}>
        <span className="agent-card__name">{agent.name}</span>
        <span className="agent-card__status" data-agent-status={agent.status}>{statusLabel(agent)}</span>
        <span className="agent-card__beat">♥ {relTime(agent.lastHeartbeat)}</span>
      </button>

      {lastFailed && !expanded && (
        <div className="agent-card__alert">last run failed on {lastFailed.issueIdentifier}</div>
      )}

      {expanded && (
        <div className="agent-card__body">
          {agent.description && <p className="exec-drawer__desc">{agent.description}</p>}
          <div className="exec-drawer__meta">
            <span>{agent.adapter}</span>
            <span>heartbeat {relTime(agent.lastHeartbeat)}</span>
          </div>

          <AgentRuns runs={agentRuns} />

          <div className="agent-card__actions">
            {actions.map((action) => (
              <button
                key={action}
                className="feed-filter-btn"
                disabled={agentAction.isPending}
                onClick={() => runAction(action)}
              >
                {pendingAction === action && agentAction.isPending ? '…' : AGENT_ACTION_LABELS[action]}
              </button>
            ))}
            <button
              className="feed-filter-btn"
              onClick={() => onInjectChat(`Give me a detailed status on the ${agent.name} agent: what it's working on, its recent runs, and any failures.`)}
            >
              Ask the assistant
            </button>
          </div>

          {agentAction.error && (
            <div className="exec-error" role="alert">{(agentAction.error as Error).message}</div>
          )}
        </div>
      )}
    </div>
  )
}

export function AgentsTabView({
  orgId,
  userRole,
  onInjectChat,
}: {
  orgId?: string
  userRole?: string
  onInjectChat: (msg: string) => void
}) {
  const { agents, isLoading, error, refetch } = useAgentsRoster(orgId)
  const { runs } = useAgentRuns(orgId)

  const canAct = (ROLE_RANK[userRole ?? ''] ?? 0) >= ROLE_RANK.admin

  // Errored agents float to the top — the triage targets.
  const sorted = useMemo(
    () =>
      [...agents].sort((a, b) => {
        const rank = (x: Agent) => (x.status === 'error' ? 0 : x.status === 'active' ? 1 : 2)
        return rank(a) - rank(b) || a.name.localeCompare(b.name)
      }),
    [agents]
  )

  if (!orgId) {
    return <div className="exec-muted" style={{ padding: 'var(--space-3)' }}>Select a workspace to see its agents.</div>
  }

  return (
    <div className="exec-tab" role="tabpanel" aria-label="Agents">
      {isLoading ? (
        <div className="exec-muted">Loading agents…</div>
      ) : error ? (
        <div className="feed-empty" role="alert">
          <div className="feed-empty__text">Unable to load agents</div>
          <button className="feed-filter-btn" onClick={() => refetch()} style={{ marginTop: 'var(--space-2)' }}>Retry</button>
        </div>
      ) : sorted.length === 0 ? (
        <div className="exec-muted">No agents in this workspace</div>
      ) : (
        <div role="list" aria-label="Agent roster">
          {sorted.map((agent) => (
            <AgentCard
              key={agent.id}
              agent={agent}
              runs={runs}
              canAct={canAct}
              orgId={orgId}
              onInjectChat={onInjectChat}
            />
          ))}
        </div>
      )}
    </div>
  )
}
