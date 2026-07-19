'use client'

import { useMemo, useState } from 'react'
import type { Issue } from '@/types'
import { ROLE_RANK } from '@/lib/proxyAuthz'
import {
  ISSUE_STATE_OPTIONS,
  wireStatusForState,
} from '@/lib/execution-panel'
import {
  useIssuesPanel,
  useIssueComments,
  useAddComment,
  useUpdateIssueStatus,
} from '@/app/hooks/useExecutionPanel'

/* ══════════════════════════════════════════════════════════════════════════════
   ISSUES TAB (Phase 2) — native issue triage in the right panel.

   Writes: add comment (staff+, @-mentions wake the assignee) and change state
   (admin+). Both route through the [...path] proxy where the real role gate
   lives — the role checks here only decide what to render.
   ══════════════════════════════════════════════════════════════════════════════ */

type StateFilter = 'all' | 'open' | 'active' | 'blocked' | 'done'

const STATE_FILTERS: Array<{ id: StateFilter; label: string }> = [
  { id: 'all', label: 'All' },
  { id: 'open', label: 'Open' },
  { id: 'active', label: 'Active' },
  { id: 'blocked', label: 'Blocked' },
  { id: 'done', label: 'Done' },
]

function matchesFilter(issue: Issue, filter: StateFilter): boolean {
  const group = issue.state?.group
  const name = issue.state?.name?.toLowerCase() ?? ''
  switch (filter) {
    case 'all': return true
    case 'open': return group === 'backlog' || group === 'unstarted'
    case 'active': return group === 'started' && name !== 'blocked'
    case 'blocked': return name === 'blocked'
    case 'done': return group === 'completed' || group === 'cancelled'
  }
}

function relTime(iso?: string): string {
  if (!iso) return ''
  try {
    const diffMs = Date.now() - new Date(iso).getTime()
    const mins = Math.floor(diffMs / 60_000)
    if (mins < 1) return 'now'
    if (mins < 60) return `${mins}m`
    const hours = Math.floor(mins / 60)
    if (hours < 24) return `${hours}h`
    return `${Math.floor(hours / 24)}d`
  } catch {
    return ''
  }
}

function IssueDrawer({
  issue,
  orgId,
  canChangeState,
  onInjectChat,
}: {
  issue: Issue
  orgId?: string
  canChangeState: boolean
  onInjectChat: (msg: string) => void
}) {
  const { comments, isLoading: commentsLoading } = useIssueComments(issue.id)
  const addComment = useAddComment(orgId)
  const updateStatus = useUpdateIssueStatus(orgId)
  const [draft, setDraft] = useState('')

  const submitComment = () => {
    const body = draft.trim()
    if (!body || addComment.isPending) return
    addComment.mutate({ issueId: issue.id, body }, { onSuccess: () => setDraft('') })
  }

  const actionError = addComment.error ?? updateStatus.error

  return (
    <div className="exec-drawer">
      {issue.description && (
        <p className="exec-drawer__desc">{issue.description.length > 400 ? issue.description.slice(0, 397) + '…' : issue.description}</p>
      )}

      <div className="exec-drawer__meta">
        {issue.assigneeName && <span>→ {issue.assigneeName}</span>}
        <span>{issue.priority}</span>
        <span>updated {relTime(issue.updatedAt)} ago</span>
      </div>

      {canChangeState && (
        <div className="exec-drawer__row">
          <label className="exec-drawer__label" htmlFor={`state-${issue.id}`}>State</label>
          <select
            id={`state-${issue.id}`}
            className="exec-select"
            value={wireStatusForState(issue.state)}
            disabled={updateStatus.isPending}
            onChange={(e) => updateStatus.mutate({ issueId: issue.id, status: e.target.value })}
          >
            {ISSUE_STATE_OPTIONS.map((o) => (
              <option key={o.status} value={o.status}>{o.label}</option>
            ))}
          </select>
        </div>
      )}

      <div className="exec-drawer__comments">
        {commentsLoading ? (
          <div className="exec-muted">Loading comments…</div>
        ) : comments.length === 0 ? (
          <div className="exec-muted">No comments yet</div>
        ) : (
          comments.slice(-5).map((c) => (
            <div key={c.id} className="exec-comment">
              <span className="exec-comment__author" data-author-type={c.authorType}>{c.authorName}</span>
              <span className="exec-comment__body">{c.body.length > 240 ? c.body.slice(0, 237) + '…' : c.body}</span>
            </div>
          ))
        )}
      </div>

      <div className="exec-drawer__composer">
        <input
          className="exec-input"
          type="text"
          placeholder="Comment (@-mention wakes the agent)…"
          value={draft}
          maxLength={2000}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') submitComment() }}
        />
        <button
          className="feed-filter-btn"
          onClick={submitComment}
          disabled={!draft.trim() || addComment.isPending}
        >
          {addComment.isPending ? 'Sending…' : 'Send'}
        </button>
      </div>

      {actionError && (
        <div className="exec-error" role="alert">{(actionError as Error).message}</div>
      )}

      <button
        className="feed-filter-btn"
        onClick={() => onInjectChat(`Tell me about issue ${issue.identifier || issue.title}: current state, recent activity, and anything blocking it.`)}
      >
        Ask the assistant
      </button>
    </div>
  )
}

export function IssuesTabView({
  orgId,
  userRole,
  onInjectChat,
}: {
  orgId?: string
  userRole?: string
  onInjectChat: (msg: string) => void
}) {
  const { issues, isLoading, error, refetch } = useIssuesPanel(orgId)
  const [filter, setFilter] = useState<StateFilter>('all')
  const [expandedId, setExpandedId] = useState<string | null>(null)

  const canChangeState = (ROLE_RANK[userRole ?? ''] ?? 0) >= ROLE_RANK.admin

  const filtered = useMemo(
    () => issues.filter((i) => matchesFilter(i, filter)),
    [issues, filter]
  )

  if (!orgId) {
    return <div className="exec-muted" style={{ padding: 'var(--space-3)' }}>Select a workspace to see its issues.</div>
  }

  return (
    <div className="exec-tab" role="tabpanel" aria-label="Issues">
      <div className="feed-filter-bar" role="tablist" aria-label="Issue state filters">
        {STATE_FILTERS.map((f) => (
          <button
            key={f.id}
            className={`feed-filter-btn ${filter === f.id ? 'active' : ''}`}
            role="tab"
            aria-selected={filter === f.id}
            onClick={() => setFilter(f.id)}
          >
            {f.label}
          </button>
        ))}
      </div>

      {isLoading ? (
        <div className="exec-muted">Loading issues…</div>
      ) : error ? (
        <div className="feed-empty" role="alert">
          <div className="feed-empty__text">Unable to load issues</div>
          <button className="feed-filter-btn" onClick={() => refetch()} style={{ marginTop: 'var(--space-2)' }}>Retry</button>
        </div>
      ) : filtered.length === 0 ? (
        <div className="exec-muted">No {filter === 'all' ? '' : `${filter} `}issues</div>
      ) : (
        <div role="list" aria-label="Issue list">
          {filtered.map((issue) => {
            const expanded = expandedId === issue.id
            return (
              <div key={issue.id} className="exec-row-wrap" role="listitem">
                <button
                  className={`exec-row ${expanded ? 'exec-row--expanded' : ''}`}
                  onClick={() => setExpandedId(expanded ? null : issue.id)}
                  aria-expanded={expanded}
                >
                  <span className="exec-row__id">{issue.identifier}</span>
                  <span className="exec-row__title">{issue.title}</span>
                  <span className="exec-row__state" data-state-group={issue.state?.group} data-state-name={issue.state?.name?.toLowerCase()}>
                    {issue.state?.name}
                  </span>
                </button>
                {expanded && (
                  <IssueDrawer
                    issue={issue}
                    orgId={orgId}
                    canChangeState={canChangeState}
                    onInjectChat={onInjectChat}
                  />
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
