'use client'

import { useState } from 'react'
import type { Project } from '@/types'
import { ROLE_RANK } from '@/lib/proxyAuthz'
import {
  availableWorkspaceActions,
  type WorkspaceInfo,
  type WorkspaceRuntimeAction,
} from '@/lib/execution-panel'
import {
  useProjectsPanel,
  useProjectWorkspaces,
  useWorkspaceRuntimeAction,
} from '@/app/hooks/useExecutionPanel'

/* ══════════════════════════════════════════════════════════════════════════════
   SPACES TAB (Phase 4) — projects and their execution workspaces.

   Read-heavy: project cards expand into their workspace list (repo, branch,
   primary badge, runtime state). The only writes are runtime-service
   start/stop/restart (admin-tier, enforced by the [...path] proxy — the role
   check here just hides the buttons).
   ══════════════════════════════════════════════════════════════════════════════ */

const RUNTIME_ACTION_LABELS: Record<WorkspaceRuntimeAction, string> = {
  start: 'Start services',
  stop: 'Stop',
  restart: 'Restart',
}

function WorkspaceRow({
  ws,
  projectId,
  canAct,
}: {
  ws: WorkspaceInfo
  projectId: string
  canAct: boolean
}) {
  const runtimeAction = useWorkspaceRuntimeAction(projectId)
  const [pending, setPending] = useState<WorkspaceRuntimeAction | null>(null)
  const actions = canAct ? availableWorkspaceActions(ws) : []

  const runAction = (action: WorkspaceRuntimeAction) => {
    if (runtimeAction.isPending) return
    setPending(action)
    runtimeAction.mutate({ workspaceId: ws.id, action }, { onSettled: () => setPending(null) })
  }

  const location = ws.repoUrl
    ? `${ws.repoUrl.replace(/^https?:\/\/(www\.)?/, '')}${ws.repoRef ? ` @ ${ws.repoRef}` : ''}`
    : ws.cwd ?? '—'

  return (
    <div className="workspace-row" data-ws-state={ws.desiredState || 'idle'}>
      <div className="workspace-row__head">
        <span className="workspace-row__name">
          {ws.name}
          {ws.isPrimary && <span className="workspace-row__primary">primary</span>}
        </span>
        <span className="exec-row__state" data-ws-state={ws.desiredState || 'idle'}>
          {ws.desiredState || ws.sourceType}
        </span>
      </div>
      <div className="workspace-row__location">{location}</div>
      {(actions.length > 0 || runtimeAction.error) && (
        <div className="agent-card__actions">
          {actions.map((action) => (
            <button
              key={action}
              className="feed-filter-btn"
              disabled={runtimeAction.isPending}
              onClick={() => runAction(action)}
            >
              {pending === action && runtimeAction.isPending ? '…' : RUNTIME_ACTION_LABELS[action]}
            </button>
          ))}
          {runtimeAction.error && (
            <span className="exec-error" role="alert">{(runtimeAction.error as Error).message}</span>
          )}
        </div>
      )}
    </div>
  )
}

function ProjectCard({
  project,
  canAct,
  onInjectChat,
}: {
  project: Project
  canAct: boolean
  onInjectChat: (msg: string) => void
}) {
  const [expanded, setExpanded] = useState(false)
  // Workspaces fetch only once a card is opened (enabled: !!projectId)
  const { workspaces, isLoading, error } = useProjectWorkspaces(expanded ? project.id : undefined)

  return (
    <div className="exec-row-wrap" data-project-status={project.status}>
      <button
        className={`exec-row ${expanded ? 'exec-row--expanded' : ''}`}
        onClick={() => setExpanded(!expanded)}
        aria-expanded={expanded}
      >
        <span className="exec-row__title">{project.name}</span>
        <span className="exec-row__state" data-project-status={project.status}>{project.status}</span>
      </button>

      {expanded && (
        <div className="exec-drawer">
          {project.description && (
            <p className="exec-drawer__desc">
              {project.description.length > 300 ? project.description.slice(0, 297) + '…' : project.description}
            </p>
          )}

          {isLoading ? (
            <div className="exec-muted">Loading workspaces…</div>
          ) : error ? (
            <div className="exec-error" role="alert">Unable to load workspaces</div>
          ) : workspaces.length === 0 ? (
            <div className="exec-muted">No workspaces attached — agents have nowhere to run file work for this project.</div>
          ) : (
            <div role="list" aria-label="Project workspaces">
              {workspaces.map((ws) => (
                <WorkspaceRow key={ws.id} ws={ws} projectId={project.id} canAct={canAct} />
              ))}
            </div>
          )}

          <button
            className="feed-filter-btn"
            style={{ alignSelf: 'flex-start' }}
            onClick={() => onInjectChat(`Give me a status report on the "${project.name}" project: open work, recent agent activity, and workspace health.`)}
          >
            Ask the assistant
          </button>
        </div>
      )}
    </div>
  )
}

export function SpacesTabView({
  orgId,
  userRole,
  onInjectChat,
}: {
  orgId?: string
  userRole?: string
  onInjectChat: (msg: string) => void
}) {
  const { projects, isLoading, error, refetch } = useProjectsPanel(orgId)
  const canAct = (ROLE_RANK[userRole ?? ''] ?? 0) >= ROLE_RANK.admin

  if (!orgId) {
    return <div className="exec-muted" style={{ padding: 'var(--space-3)' }}>Select a workspace to see its projects.</div>
  }

  return (
    <div className="exec-tab" role="tabpanel" aria-label="Spaces">
      {isLoading ? (
        <div className="exec-muted">Loading projects…</div>
      ) : error ? (
        <div className="feed-empty" role="alert">
          <div className="feed-empty__text">Unable to load projects</div>
          <button className="feed-filter-btn" onClick={() => refetch()} style={{ marginTop: 'var(--space-2)' }}>Retry</button>
        </div>
      ) : projects.length === 0 ? (
        <div className="exec-muted">No projects yet — deliverables and their workspaces land here.</div>
      ) : (
        <div role="list" aria-label="Project list">
          {projects.map((project) => (
            <ProjectCard key={project.id} project={project} canAct={canAct} onInjectChat={onInjectChat} />
          ))}
        </div>
      )}
    </div>
  )
}
