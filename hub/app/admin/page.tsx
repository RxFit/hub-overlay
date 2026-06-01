'use client'

import { useState, useEffect, useCallback } from 'react'
import { useSession, signOut } from 'next-auth/react'
import { useRouter } from 'next/navigation'
import { getTenantConfig } from '@/lib/tenant'

const tenant = getTenantConfig()

type RoleOption = 'onboarding' | 'staff' | 'admin' | 'superadmin'

interface UserRow {
  email: string
  role: string
  assignedProjects: string[]
  assignedAt: string
  assignedBy: string
}

interface RowState extends UserRow {
  pendingRole: string
  pendingProjects: string[]
  saving: boolean
  saved: boolean
  error: string | null
}

const ROLE_LABELS: Record<string, string> = {
  superadmin: 'Super Admin',
  admin: 'Admin',
  staff: 'Staff',
  onboarding: 'Onboarding',
}

const ROLE_COLORS: Record<string, string> = {
  superadmin: '#d4b572',
  admin: '#C5A059',
  staff: '#4A6FA5',
  onboarding: '#6b7280',
}

export default function AdminPage() {
  const { data: session, status } = useSession()
  const router = useRouter()
  const callerRole = (session?.user as Record<string, unknown>)?.role as string

  const [rows, setRows] = useState<RowState[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  // Redirect non-admins
  useEffect(() => {
    if (status === 'authenticated' && callerRole !== 'admin' && callerRole !== 'superadmin') {
      router.replace('/')
    }
  }, [status, callerRole, router])

  const fetchUsers = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch('/api/admin/roles')
      if (!res.ok) throw new Error(`Failed to load users: ${res.status}`)
      const data: { users: UserRow[] } = await res.json()
      setRows(
        data.users.map(u => ({
          ...u,
          pendingRole: u.role,
          pendingProjects: [...u.assignedProjects],
          saving: false,
          saved: false,
          error: null,
        }))
      )
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (status === 'authenticated' && (callerRole === 'admin' || callerRole === 'superadmin')) {
      fetchUsers()
    }
  }, [status, callerRole, fetchUsers])

  const handleSave = async (email: string) => {
    const row = rows.find(r => r.email === email)
    if (!row) return

    setRows(prev => prev.map(r => r.email === email ? { ...r, saving: true, error: null } : r))

    try {
      const res = await fetch('/api/admin/roles', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: row.email,
          role: row.pendingRole,
          assignedProjects: row.pendingProjects,
        }),
      })
      if (!res.ok) {
        const data = await res.json()
        throw new Error(data.error || `Save failed: ${res.status}`)
      }
      setRows(prev => prev.map(r =>
        r.email === email
          ? { ...r, saving: false, saved: true, role: r.pendingRole, assignedProjects: r.pendingProjects }
          : r
      ))
      setTimeout(() => {
        setRows(prev => prev.map(r => r.email === email ? { ...r, saved: false } : r))
      }, 2500)
    } catch (err) {
      setRows(prev => prev.map(r =>
        r.email === email
          ? { ...r, saving: false, error: err instanceof Error ? err.message : 'Save failed' }
          : r
      ))
    }
  }

  // Available role options based on caller's role
  const roleOptions: RoleOption[] = callerRole === 'superadmin'
    ? ['onboarding', 'staff', 'admin']
    : ['onboarding', 'staff']

  const onboardingUsers = rows.filter(r => r.role === 'onboarding')
  const assignedUsers = rows.filter(r => r.role !== 'onboarding')

  if (status === 'loading' || loading) {
    return (
      <div className="admin-shell">
        <div className="admin-loading">
          <div className="admin-loading__spinner" />
          <span>Loading role management…</span>
        </div>
      </div>
    )
  }

  return (
    <div className="admin-shell">
      {/* Header */}
      <header className="admin-header">
        <div className="admin-header__left">
          <button className="admin-back-btn" onClick={() => router.push('/')} aria-label="Back to Hub">
            ← Hub
          </button>
          <div className="admin-header__title">
            <span className="admin-header__accent">{tenant.logoText}</span>
            {' '}Role Management
          </div>
        </div>
        <div className="admin-header__right">
          <span className="admin-role-badge" style={{ color: ROLE_COLORS[callerRole] }}>
            {ROLE_LABELS[callerRole] ?? callerRole}
          </span>
          <span className="admin-header__email">{session?.user?.email}</span>
          <button className="admin-signout-btn" onClick={() => signOut({ callbackUrl: '/login' })}>
            Sign out
          </button>
        </div>
      </header>

      <main className="admin-main">
        {error && (
          <div className="admin-error" role="alert">
            <span>⚠️ {error}</span>
            <button onClick={fetchUsers} className="admin-retry-btn">Retry</button>
          </div>
        )}

        {/* Superadmin: New Workspace Provisioner */}
        {callerRole === 'superadmin' && (
          <WorkspaceProvisioner />
        )}

        {/* Pending Assignment */}
        {onboardingUsers.length > 0 && (
          <section className="admin-section">
            <div className="admin-section__header">
              <h2 className="admin-section__title">
                <span className="admin-section__dot admin-section__dot--pending" />
                Pending Assignment
                <span className="admin-section__count">{onboardingUsers.length}</span>
              </h2>
              <p className="admin-section__sub">These users have signed in but have not been assigned a role yet.</p>
            </div>
            <UserTable
              rows={onboardingUsers}
              roleOptions={roleOptions}
              callerRole={callerRole}
              projects={tenant.projects}
              onRoleChange={(email, role) => setRows(prev => prev.map(r => r.email === email ? { ...r, pendingRole: role } : r))}
              onProjectToggle={(email, pid) => setRows(prev => prev.map(r => {
                if (r.email !== email) return r
                const has = r.pendingProjects.includes(pid)
                return { ...r, pendingProjects: has ? r.pendingProjects.filter(p => p !== pid) : [...r.pendingProjects, pid] }
              }))}
              onSave={handleSave}
            />
          </section>
        )}

        {/* Assigned Users */}
        <section className="admin-section">
          <div className="admin-section__header">
            <h2 className="admin-section__title">
              <span className="admin-section__dot admin-section__dot--active" />
              Assigned Users
              <span className="admin-section__count">{assignedUsers.length}</span>
            </h2>
          </div>
          {assignedUsers.length === 0 ? (
            <div className="admin-empty">No assigned users yet.</div>
          ) : (
            <UserTable
              rows={assignedUsers}
              roleOptions={roleOptions}
              callerRole={callerRole}
              projects={tenant.projects}
              onRoleChange={(email, role) => setRows(prev => prev.map(r => r.email === email ? { ...r, pendingRole: role } : r))}
              onProjectToggle={(email, pid) => setRows(prev => prev.map(r => {
                if (r.email !== email) return r
                const has = r.pendingProjects.includes(pid)
                return { ...r, pendingProjects: has ? r.pendingProjects.filter(p => p !== pid) : [...r.pendingProjects, pid] }
              }))}
              onSave={handleSave}
            />
          )}
        </section>
      </main>
    </div>
  )
}

/* ── User Table Component ── */

function UserTable({
  rows,
  roleOptions,
  callerRole,
  projects,
  onRoleChange,
  onProjectToggle,
  onSave,
}: {
  rows: RowState[]
  roleOptions: RoleOption[]
  callerRole: string
  projects: { id: string; name: string; abbr: string; color: string }[]
  onRoleChange: (email: string, role: string) => void
  onProjectToggle: (email: string, projectId: string) => void
  onSave: (email: string) => void
}) {
  return (
    <div className="admin-table">
      {rows.map(row => {
        const isDirty = row.pendingRole !== row.role ||
          JSON.stringify([...row.pendingProjects].sort()) !== JSON.stringify([...row.assignedProjects].sort())
        const isSuperadmin = row.role === 'superadmin'

        return (
          <div key={row.email} className="admin-row">
            {/* User info */}
            <div className="admin-row__user">
              <div className="admin-row__avatar" style={{ background: ROLE_COLORS[row.role] + '22', color: ROLE_COLORS[row.role] }}>
                {row.email[0].toUpperCase()}
              </div>
              <div className="admin-row__info">
                <span className="admin-row__email">{row.email}</span>
                {row.assignedAt && (
                  <span className="admin-row__meta">
                    Assigned {new Date(row.assignedAt).toLocaleDateString()} by {row.assignedBy || 'system'}
                  </span>
                )}
              </div>
            </div>

            {/* Current role badge */}
            <div className="admin-row__current-role">
              <span className="admin-role-pill" style={{ color: ROLE_COLORS[row.role], borderColor: ROLE_COLORS[row.role] + '44' }}>
                {ROLE_LABELS[row.role] ?? row.role}
              </span>
            </div>

            {/* Role select */}
            <div className="admin-row__controls">
              {isSuperadmin ? (
                <span className="admin-row__locked" title="Super Admin role cannot be changed via this panel">
                  🔒 Super Admin
                </span>
              ) : (
                <select
                  className="admin-role-select"
                  value={row.pendingRole}
                  onChange={e => onRoleChange(row.email, e.target.value)}
                  aria-label={`Role for ${row.email}`}
                >
                  {roleOptions.map(r => (
                    <option key={r} value={r}>{ROLE_LABELS[r]}</option>
                  ))}
                </select>
              )}

              {/* Project assignment (shown for non-onboarding roles) */}
              {!isSuperadmin && row.pendingRole !== 'onboarding' && (
                <div className="admin-projects">
                  <span className="admin-projects__label">Projects:</span>
                  <div className="admin-projects__chips">
                    {projects.map(p => {
                      const selected = row.pendingProjects.includes(p.id) || row.pendingProjects.includes('*')
                      return (
                        <button
                          key={p.id}
                          className={`admin-project-chip ${selected ? 'admin-project-chip--active' : ''}`}
                          style={selected ? { borderColor: p.color, background: p.color + '22', color: p.color } : {}}
                          onClick={() => onProjectToggle(row.email, p.id)}
                          aria-pressed={selected}
                          aria-label={`${selected ? 'Remove' : 'Add'} ${p.name}`}
                        >
                          {p.abbr}
                        </button>
                      )
                    })}
                  </div>
                </div>
              )}
            </div>

            {/* Save button */}
            {!isSuperadmin && (
              <div className="admin-row__actions">
                {row.error && <span className="admin-row__error">⚠️ {row.error}</span>}
                {row.saved && <span className="admin-row__success">✓ Saved</span>}
                <button
                  className={`admin-save-btn ${isDirty ? 'admin-save-btn--dirty' : ''}`}
                  onClick={() => onSave(row.email)}
                  disabled={row.saving || !isDirty}
                  aria-label={`Save role for ${row.email}`}
                >
                  {row.saving ? '…' : isDirty ? 'Save' : 'Saved'}
                </button>
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}

/* ── Workspace Provisioner Component (superadmin only) ── */

interface ProvisionResult {
  success: boolean
  companyName?: string
  issuePrefix?: string
  company?: { id: string; name: string; identifier: string }
  agents?: { id: string; name: string; role: string }[]
  agentsCreated?: number
  errors?: string[]
  message?: string
  error?: string
}

function WorkspaceProvisioner() {
  const [companyName, setCompanyName]       = useState('')
  const [issuePrefix, setIssuePrefix]       = useState('')
  const [brandColor, setBrandColor]         = useState('#C5A059')
  const [agentTemplate, setAgentTemplate]   = useState<'csuite' | 'ceo-only'>('csuite')
  const [status, setStatus]                 = useState<'idle' | 'loading' | 'success' | 'error'>('idle')
  const [result, setResult]                 = useState<ProvisionResult | null>(null)
  const [expanded, setExpanded]             = useState(false)

  const handleProvision = useCallback(async () => {
    if (!companyName.trim() || !issuePrefix.trim()) return
    setStatus('loading')
    setResult(null)
    try {
      const res = await fetch('/api/admin/workspaces', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ companyName: companyName.trim(), issuePrefix: issuePrefix.trim().toUpperCase(), brandColor, agentTemplate }),
      })
      const data: ProvisionResult = await res.json()
      setResult(data)
      setStatus(data.success ? 'success' : 'error')
      if (data.success) {
        setCompanyName('')
        setIssuePrefix('')
        setBrandColor('#C5A059')
        setAgentTemplate('csuite')
      }
    } catch (err) {
      setResult({ success: false, error: err instanceof Error ? err.message : 'Network error' })
      setStatus('error')
    }
  }, [companyName, issuePrefix, brandColor, agentTemplate])

  return (
    <section className="admin-section admin-section--workspace" style={{ borderColor: '#d4b572' + '44' }}>
      <div className="admin-section__header">
        <h2 className="admin-section__title">
          <span style={{ color: '#d4b572' }}>⬡</span>
          {' '}New Workspace
          <span className="admin-section__badge" style={{ background: '#d4b57222', color: '#d4b572', border: '1px solid #d4b57244', fontSize: '0.65rem', padding: '2px 8px', borderRadius: '20px', marginLeft: '8px' }}>Superadmin</span>
        </h2>
        <button
          className="admin-section__toggle"
          onClick={() => setExpanded(e => !e)}
          aria-expanded={expanded}
          aria-label="Toggle workspace provisioner"
          style={{ background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', fontSize: '1.1rem', padding: '4px 8px' }}
        >
          {expanded ? '▲' : '▼'}
        </button>
      </div>
      <p className="admin-section__sub">Create a new Paperclip company workspace and seed the C-Suite agent hierarchy.</p>

      {expanded && (
        <div style={{ marginTop: '16px' }}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px', marginBottom: '12px' }}>
            {/* Company Name */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
              <label htmlFor="ws-company-name" style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)', fontFamily: 'var(--font-mono)', textTransform: 'uppercase', letterSpacing: '0.08em' }}>Company Name</label>
              <input
                id="ws-company-name"
                className="settings-input"
                type="text"
                value={companyName}
                onChange={e => setCompanyName(e.target.value)}
                placeholder="e.g. Rose Pop Parties"
                disabled={status === 'loading'}
              />
            </div>

            {/* Issue Prefix */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
              <label htmlFor="ws-issue-prefix" style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)', fontFamily: 'var(--font-mono)', textTransform: 'uppercase', letterSpacing: '0.08em' }}>Issue Prefix (2–5 letters)</label>
              <input
                id="ws-issue-prefix"
                className="settings-input settings-input--mono"
                type="text"
                value={issuePrefix}
                onChange={e => setIssuePrefix(e.target.value.toUpperCase().replace(/[^A-Z]/g, '').slice(0, 5))}
                placeholder="e.g. RPP"
                maxLength={5}
                disabled={status === 'loading'}
              />
            </div>

            {/* Brand Color */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
              <label htmlFor="ws-brand-color" style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)', fontFamily: 'var(--font-mono)', textTransform: 'uppercase', letterSpacing: '0.08em' }}>Brand Color</label>
              <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
                <input
                  id="ws-brand-color"
                  type="color"
                  value={brandColor}
                  onChange={e => setBrandColor(e.target.value)}
                  disabled={status === 'loading'}
                  style={{ width: '40px', height: '36px', border: 'none', cursor: 'pointer', borderRadius: '6px', background: 'none' }}
                />
                <input
                  className="settings-input settings-input--mono"
                  type="text"
                  value={brandColor}
                  onChange={e => setBrandColor(e.target.value)}
                  placeholder="#C5A059"
                  style={{ flex: 1 }}
                  disabled={status === 'loading'}
                />
              </div>
            </div>

            {/* Agent Template */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
              <label htmlFor="ws-agent-template" style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)', fontFamily: 'var(--font-mono)', textTransform: 'uppercase', letterSpacing: '0.08em' }}>Agent Template</label>
              <select
                id="ws-agent-template"
                className="admin-role-select"
                value={agentTemplate}
                onChange={e => setAgentTemplate(e.target.value as 'csuite' | 'ceo-only')}
                disabled={status === 'loading'}
                style={{ height: '36px', borderRadius: '6px' }}
              >
                <option value="csuite">Full C-Suite (CEO, CMO, CTO, CFO, COO)</option>
                <option value="ceo-only">CEO Only (minimal)</option>
              </select>
            </div>
          </div>

          {/* Action button */}
          <button
            className="settings-save-btn"
            onClick={handleProvision}
            disabled={status === 'loading' || !companyName.trim() || !issuePrefix.trim()}
            style={{ background: '#d4b572', color: '#060d1f', border: 'none' }}
          >
            {status === 'loading' ? '⏳ Provisioning...' : '⬡ Create Workspace'}
          </button>

          {/* Result */}
          {status === 'success' && result?.success && (
            <div className="settings-test-result settings-test-result--success" style={{ marginTop: '12px' }}>
              <div className="settings-test-result-header">✅ {result.message}</div>
              <div style={{ marginTop: '8px', fontFamily: 'var(--font-mono)', fontSize: '0.7rem', opacity: 0.8 }}>
                <div>Company ID: <strong>{(result.company as Record<string, string>)?.id}</strong></div>
                <div>Prefix: <strong>{result.issuePrefix}</strong></div>
                <div style={{ marginTop: '6px' }}>Agents created ({result.agentsCreated}):</div>
                {result.agents?.map((a: { id: string; name: string; role: string }) => (
                  <div key={a.id} style={{ paddingLeft: '12px' }}>• {a.name} — <span style={{ opacity: 0.6 }}>{a.id}</span></div>
                ))}
                {(result.errors?.length ?? 0) > 0 && (
                  <div style={{ marginTop: '6px', color: 'var(--warning)' }}>
                    Errors: {result.errors?.join(', ')}
                  </div>
                )}
              </div>
            </div>
          )}

          {status === 'error' && (
            <div className="settings-test-result settings-test-result--error" style={{ marginTop: '12px' }}>
              ❌ {result?.error ?? 'Provisioning failed'}
            </div>
          )}
        </div>
      )}
    </section>
  )
}

