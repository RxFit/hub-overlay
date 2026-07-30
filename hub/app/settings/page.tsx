'use client'

import React, { useState, useEffect, useCallback, useRef } from 'react'
import { useSession, signOut, signIn } from 'next-auth/react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { InfoPopover } from '@/app/components/InfoPopover'
import { ChatSpacesSettings } from '@/app/settings/components/ChatSpacesSettings'
import { AnalyticsSettings } from '@/app/settings/components/AnalyticsSettings'
import { ScheduledReportsSettings } from '@/app/settings/components/ScheduledReportsSettings'
import { FocusPreferencesSettings } from '@/app/settings/components/FocusPreferencesSettings'
import { useCompanies } from '@/app/hooks/useCompanies'
import type { Company } from '@/types'

/* ── Types ── */

/* ── Onboarding Users Types ── */

interface OnboardingUser {
  email: string
  role: string
  assignedProjects: string[]
  assignedAt: string
  assignedBy: string
}

interface OnboardingUserRowState extends OnboardingUser {
  pendingRole: string
  pendingProjects: string[]   // projects selected before promote
  saving: boolean
  error: string | null
}

/* ── OnboardingUsersCard Component ── */

const ONBOARDING_ROLE_LABELS: Record<string, string> = {
  staff: 'Staff',
  admin: 'Admin',
}

function OnboardingUsersCard({ callerRole }: { callerRole: string }) {
  const [users, setUsers] = useState<OnboardingUserRowState[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [lastRefresh, setLastRefresh] = useState<Date | null>(null)
  const [registerEmail, setRegisterEmail] = useState('')
  const [registering, setRegistering] = useState(false)
  const [registerMsg, setRegisterMsg] = useState<{ type: 'ok' | 'err'; text: string } | null>(null)

  // Live company list for project assignment
  const { companies } = useCompanies()

  const fetchOnboardingUsers = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch('/api/admin/roles')
      if (!res.ok) throw new Error(`Failed to load users (${res.status})`)
      const data: { users: OnboardingUser[] } = await res.json()
      const onboarding = data.users.filter(u => u.role === 'onboarding')
      setUsers(onboarding.map(u => ({
        ...u,
        pendingRole: 'staff',
        pendingProjects: [],
        saving: false,
        error: null,
      })))
      setLastRefresh(new Date())
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    fetchOnboardingUsers()
  }, [fetchOnboardingUsers])

  // Manually register a user by email (admin writes their onboarding row)
  const handleRegisterByEmail = useCallback(async () => {
    const email = registerEmail.trim().toLowerCase()
    if (!email || !email.includes('@')) return
    setRegistering(true)
    setRegisterMsg(null)
    try {
      const res = await fetch('/api/admin/roles', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, role: 'onboarding', assignedProjects: [] }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || `Failed (${res.status})`)
      setRegisterMsg({ type: 'ok', text: `${email} added — refresh to see them below` })
      setRegisterEmail('')
      // Refresh the list after a short delay
      setTimeout(fetchOnboardingUsers, 800)
    } catch (err) {
      setRegisterMsg({ type: 'err', text: err instanceof Error ? err.message : 'Failed' })
    } finally {
      setRegistering(false)
    }
  }, [registerEmail, fetchOnboardingUsers])

  const handlePromote = async (email: string) => {
    const user = users.find(u => u.email === email)
    if (!user) return

    // admin role gets '*' wildcard; staff gets selected projects
    const projectsToAssign = user.pendingRole === 'admin' ? ['*'] : user.pendingProjects

    setUsers(prev => prev.map(u => u.email === email ? { ...u, saving: true, error: null } : u))

    try {
      const res = await fetch('/api/admin/roles', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, role: user.pendingRole, assignedProjects: projectsToAssign }),
      })
      if (!res.ok) {
        const data = await res.json()
        throw new Error(data.error || `Save failed (${res.status})`)
      }
      // Remove user from list on successful promote
      setUsers(prev => prev.filter(u => u.email !== email))
    } catch (err) {
      setUsers(prev => prev.map(u =>
        u.email === email
          ? { ...u, saving: false, error: err instanceof Error ? err.message : 'Failed' }
          : u
      ))
    }
  }

  // Toggle a project on/off for a pending user
  const togglePendingProject = (email: string, companyId: string) => {
    setUsers(prev => prev.map(u => {
      if (u.email !== email) return u
      const has = u.pendingProjects.includes(companyId)
      return {
        ...u,
        pendingProjects: has
          ? u.pendingProjects.filter(p => p !== companyId)
          : [...u.pendingProjects, companyId],
      }
    }))
  }

  // Role options scoped by caller's role
  const roleOptions = callerRole === 'superadmin'
    ? ['staff', 'admin'] as const
    : ['staff'] as const

  const isSuperadmin = callerRole === 'superadmin'

  return (
    <section className="settings-section" aria-label="Onboarding users">
      <h2 className="settings-section-title">
        <span className="rx-comment-label">03 //</span>{' '}
        Onboarding Users
        {users.length > 0 && (
          <span style={{
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            marginLeft: '10px',
            background: 'var(--warning, #f59e0b)',
            color: '#000',
            borderRadius: '20px',
            fontSize: '0.6rem',
            fontWeight: 700,
            padding: '2px 8px',
            verticalAlign: 'middle',
          }}>
            {users.length} waiting
          </span>
        )}
      </h2>
      <p className="settings-section-desc">
        {isSuperadmin
          ? "Users across all workspaces who have signed in but haven't been assigned a role yet."
          : "Users in your organization who have signed in but haven't been assigned a role yet."}
      </p>

      {/* Refresh row */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '12px' }}>
        {isSuperadmin && (
          <span style={{
            fontSize: 'var(--text-xs)',
            color: '#d4b572',
            fontFamily: 'var(--font-mono)',
            textTransform: 'uppercase',
            letterSpacing: '0.06em',
          }}>
            ⬡ All Workspaces
          </span>
        )}
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginLeft: 'auto' }}>
          {lastRefresh && (
            <span style={{ fontSize: '0.65rem', color: 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}>
              Updated {lastRefresh.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
            </span>
          )}
          <button
            id="settings-refresh-onboarding-btn"
            onClick={fetchOnboardingUsers}
            disabled={loading}
            style={{
              background: 'none',
              border: '1px solid var(--border)',
              color: 'var(--text-secondary)',
              borderRadius: '6px',
              padding: '4px 10px',
              fontSize: '0.7rem',
              cursor: loading ? 'wait' : 'pointer',
              fontFamily: 'var(--font-mono)',
              transition: 'all 0.15s ease',
            }}
          >
            {loading ? '⏳' : '↻'} Refresh
          </button>
        </div>
      </div>

      {/* Error */}
      {error && (
        <div className="settings-test-result settings-test-result--error" style={{ marginBottom: '12px' }}>
          ⚠️ {error}
        </div>
      )}

      {/* Register by email — admin manually adds a user who couldn't self-register */}
      <div style={{ marginBottom: '16px' }}>
        <label style={{
          display: 'block',
          fontSize: 'var(--text-xs)',
          color: 'var(--text-muted)',
          fontFamily: 'var(--font-mono)',
          textTransform: 'uppercase',
          letterSpacing: '0.06em',
          marginBottom: '6px',
        }}>
          Add user by email
        </label>
        <div style={{ display: 'flex', gap: '8px' }}>
          <input
            id="settings-register-email-input"
            type="email"
            placeholder="colleague@company.com"
            value={registerEmail}
            onChange={e => { setRegisterEmail(e.target.value); setRegisterMsg(null) }}
            onKeyDown={e => { if (e.key === 'Enter') handleRegisterByEmail() }}
            disabled={registering}
            style={{
              flex: 1,
              background: 'var(--surface-2, rgba(255,255,255,0.04))',
              border: '1px solid var(--border)',
              borderRadius: '6px',
              padding: '6px 10px',
              color: 'var(--text-primary)',
              fontSize: '0.8rem',
              fontFamily: 'var(--font-mono)',
              outline: 'none',
            }}
          />
          <button
            id="settings-register-email-btn"
            onClick={handleRegisterByEmail}
            disabled={registering || !registerEmail.trim()}
            style={{
              background: 'var(--accent)',
              color: 'var(--btn-text, #000)',
              border: 'none',
              borderRadius: '6px',
              padding: '6px 14px',
              fontSize: '0.75rem',
              fontWeight: 700,
              cursor: registering || !registerEmail.trim() ? 'not-allowed' : 'pointer',
              opacity: registering || !registerEmail.trim() ? 0.5 : 1,
              transition: 'opacity 0.15s ease',
              whiteSpace: 'nowrap',
            }}
          >
            {registering ? '…' : '+ Add'}
          </button>
        </div>
        {registerMsg && (
          <div style={{
            marginTop: '6px',
            fontSize: '0.72rem',
            color: registerMsg.type === 'ok' ? 'var(--accent)' : 'var(--danger)',
            fontFamily: 'var(--font-mono)',
          }}>
            {registerMsg.type === 'ok' ? '✓' : '⚠️'} {registerMsg.text}
          </div>
        )}
      </div>

      {/* Loading skeleton */}
      {loading && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
          {[1, 2].map(i => (
            <div key={i} style={{
              height: '54px',
              borderRadius: '8px',
              background: 'var(--surface-2, rgba(255,255,255,0.04))',
              animation: 'pulse 1.5s ease-in-out infinite',
            }} />
          ))}
        </div>
      )}

      {/* Empty state */}
      {!loading && !error && users.length === 0 && (
        <div className="settings-empty" style={{ padding: '20px 0', textAlign: 'center' }}>
          <div style={{ fontSize: '1.5rem', marginBottom: '8px' }}>✓</div>
          <div>No users waiting for role assignment.</div>
        </div>
      )}


      {/* User list */}
      {!loading && users.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', marginBottom: '16px' }}>
          {users.map(user => (
            <div
              key={user.email}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '12px',
                padding: '10px 14px',
                borderRadius: '8px',
                background: 'var(--surface-2, rgba(255,255,255,0.04))',
                border: '1px solid var(--border)',
                flexWrap: 'wrap',
              }}
            >
              {/* Avatar */}
              <div style={{
                width: '32px',
                height: '32px',
                borderRadius: '50%',
                background: 'rgba(107,114,128,0.2)',
                color: '#6b7280',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                fontSize: '0.75rem',
                fontWeight: 700,
                flexShrink: 0,
              }}>
                {user.email[0].toUpperCase()}
              </div>

              {/* Info */}
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 'var(--text-sm)', fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {user.email}
                </div>
                <div style={{ fontSize: '0.65rem', color: 'var(--text-muted)', fontFamily: 'var(--font-mono)', marginTop: '2px' }}>
                  {user.assignedAt
                    ? `Signed in ${new Date(user.assignedAt).toLocaleDateString()}`
                    : 'Recently signed in'}
                </div>
              </div>

              {/* Role selector */}
              <select
                className="admin-role-select"
                value={user.pendingRole}
                onChange={e => setUsers(prev => prev.map(u => u.email === user.email ? { ...u, pendingRole: e.target.value, pendingProjects: [] } : u))}
                disabled={user.saving}
                aria-label={`Assign role for ${user.email}`}
                style={{ height: '34px', borderRadius: '6px', fontSize: 'var(--text-xs)', minWidth: '90px' }}
              >
                {roleOptions.map(r => (
                  <option key={r} value={r}>{ONBOARDING_ROLE_LABELS[r]}</option>
                ))}
              </select>

              {/* Project access — shown for staff role only */}
              {user.pendingRole === 'staff' && companies.length > 0 && (
                <div style={{ width: '100%', paddingLeft: '44px', marginTop: '8px' }}>
                  <div style={{ fontSize: '0.62rem', color: 'var(--text-muted)', fontFamily: 'var(--font-mono)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: '6px' }}>
                    Project Access
                  </div>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px' }}>
                    {companies.map((c: Company) => {
                      const checked = user.pendingProjects.includes(c.id)
                      return (
                        <label
                          key={c.id}
                          style={{
                            display: 'inline-flex',
                            alignItems: 'center',
                            gap: '5px',
                            padding: '3px 9px',
                            borderRadius: '20px',
                            border: `1px solid ${checked ? 'var(--accent)' : 'var(--border)'}`,
                            background: checked ? 'rgba(197,160,89,0.12)' : 'rgba(255,255,255,0.03)',
                            fontSize: '0.7rem',
                            cursor: 'pointer',
                            transition: 'all 0.15s ease',
                            color: checked ? 'var(--accent)' : 'var(--text-secondary)',
                            userSelect: 'none',
                          }}
                        >
                          <input
                            type="checkbox"
                            checked={checked}
                            onChange={() => togglePendingProject(user.email, c.id)}
                            style={{ display: 'none' }}
                          />
                          {checked ? '✓ ' : ''}{c.identifier?.slice(0,2).toUpperCase() ?? c.id.slice(0,2).toUpperCase()} · {c.name}
                        </label>
                      )
                    })}
                  </div>
                  {user.pendingProjects.length === 0 && (
                    <div style={{ marginTop: '4px', fontSize: '0.65rem', color: 'var(--warn, #f59e0b)', fontFamily: 'var(--font-mono)' }}>
                      ⚠ No projects selected — staff won&apos;t see any data until assigned
                    </div>
                  )}
                </div>
              )}

              {/* Promote button */}
              <button
                id={`settings-promote-btn-${user.email.replace(/[@.]/g, '-')}`}
                onClick={() => handlePromote(user.email)}
                disabled={user.saving}
                style={{
                  padding: '6px 14px',
                  borderRadius: '6px',
                  border: 'none',
                  background: 'var(--accent, #C5A059)',
                  color: '#060d1f',
                  fontSize: '0.7rem',
                  fontWeight: 700,
                  fontFamily: 'var(--font-mono)',
                  cursor: user.saving ? 'wait' : 'pointer',
                  textTransform: 'uppercase',
                  letterSpacing: '0.06em',
                  transition: 'opacity 0.15s ease',
                  opacity: user.saving ? 0.6 : 1,
                  flexShrink: 0,
                }}
                aria-label={`Promote ${user.email} to ${user.pendingRole}`}
              >
                {user.saving ? '⏳' : '↑ Promote'}
              </button>

              {/* Error */}
              {user.error && (
                <span style={{ fontSize: '0.65rem', color: 'var(--error, #ef4444)', width: '100%', paddingLeft: '44px' }}>
                  ⚠️ {user.error}
                </span>
              )}
            </div>
          ))}
        </div>
      )}

      {/* Link to full admin panel */}
      <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
        <Link
          href="/admin"
          style={{
            fontSize: 'var(--text-xs)',
            color: 'var(--accent, #C5A059)',
            textDecoration: 'none',
            fontFamily: 'var(--font-mono)',
            display: 'inline-flex',
            alignItems: 'center',
            gap: '4px',
            opacity: 0.8,
            transition: 'opacity 0.15s ease',
          }}
          aria-label="Go to full admin role management panel"
        >
          Full Admin Panel →
        </Link>
      </div>
    </section>
  )
}

/* ══════════════════════════════════════════════════════════════════════════════
   KPI EDITOR CARD (DB-backed)
   ══════════════════════════════════════════════════════════════════════════════ */

interface DbKPI {
  id: string
  label: string
  value: string
  trend: string | null
  trendDirection: string | null
  unit: string | null
  source: string | null
  scope: string | null
  visibility: string | null
  updatedAt: string | null
}

interface KpiDraft {
  label: string
  value: string
  trend: string
  trendDirection: 'up' | 'down' | 'neutral'
  unit: string
  visibility: 'public' | 'staff' | 'admin'
}

const BLANK_DRAFT: KpiDraft = {
  label: '',
  value: '',
  trend: '',
  trendDirection: 'neutral',
  unit: '',
  visibility: 'staff',
}

const SOURCE_BADGES: Record<string, { label: string; color: string; bg: string }> = {
  ga4:       { label: 'GA4',    color: '#e37400', bg: 'rgba(227,116,0,0.12)' },
  stripe:    { label: 'Stripe', color: '#635bff', bg: 'rgba(99,91,255,0.12)' },
  gsc:       { label: 'GSC',    color: '#34a853', bg: 'rgba(52,168,83,0.12)' },
  paperclip: { label: '\u2746 PC',   color: 'var(--accent)', bg: 'rgba(0,200,100,0.12)' },
  manual:    { label: 'Manual', color: 'var(--text-muted)', bg: 'rgba(255,255,255,0.05)' },
}

function SourceBadge({ source }: { source: string | null }) {
  const cfg = SOURCE_BADGES[source ?? 'manual'] ?? SOURCE_BADGES.manual
  return (
    <span style={{ fontSize: '0.6rem', fontWeight: 700, fontFamily: 'var(--font-mono)', textTransform: 'uppercase', letterSpacing: '0.08em', padding: '2px 6px', borderRadius: '4px', color: cfg.color, background: cfg.bg, flexShrink: 0 }}>
      {cfg.label}
    </span>
  )
}

function relativeTime(iso: string | null): string {
  if (!iso) return 'never'
  const diff = Date.now() - new Date(iso).getTime()
  const mins = Math.floor(diff / 60_000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  return `${Math.floor(hrs / 24)}d ago`
}

interface SyncStatus {
  syncing: boolean
  result: null | { synced: number; sources: Record<string, { ok: boolean; count: number; error?: string }>; syncedAt: string }
  error: string | null
}

function KPIEditorCard({ isAdmin }: { isAdmin: boolean }) {
  const [kpis, setKpis] = useState<DbKPI[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editDraft, setEditDraft] = useState<Partial<KpiDraft>>({})
  const [editError, setEditError] = useState<string | null>(null)
  const [newDraft, setNewDraft] = useState<KpiDraft>(BLANK_DRAFT)
  const [adding, setAdding] = useState(false)
  const addingRef = useRef(false)  // double-submit guard
  const [saving, setSaving] = useState<string | null>(null)
  const [deleting, setDeleting] = useState<string | null>(null)
  const [addError, setAddError] = useState<string | null>(null)
  const [syncStatus, setSyncStatus] = useState<SyncStatus>({ syncing: false, result: null, error: null })

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch('/api/settings/kpis')
      const d = await res.json()
      if (!res.ok) throw new Error(d.error || `HTTP ${res.status}`)
      setKpis(d.rows ?? [])
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load])

  const handleSync = async () => {
    setSyncStatus({ syncing: true, result: null, error: null })
    try {
      const res = await fetch('/api/kpis/sync', { method: 'POST' })
      const d = await res.json()
      if (!res.ok) throw new Error(d.error || `HTTP ${res.status}`)
      setSyncStatus({ syncing: false, result: d, error: null })
      await load()
    } catch (e) {
      setSyncStatus({ syncing: false, result: null, error: e instanceof Error ? e.message : 'Sync failed' })
    }
  }

  const handleAdd = async () => {
    if (!newDraft.label.trim()) return
    if (addingRef.current) return   // double-submit guard
    addingRef.current = true
    setAdding(true)
    setAddError(null)
    try {
      const res = await fetch('/api/settings/kpis', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(newDraft),
      })
      const d = await res.json()
      if (!res.ok) throw new Error(d.error || `HTTP ${res.status}`)
      setNewDraft(BLANK_DRAFT)
      await load()
    } catch (e) {
      setAddError(e instanceof Error ? e.message : 'Failed to add')
    } finally {
      setAdding(false)
      addingRef.current = false
    }
  }

  const handleSaveEdit = async (id: string) => {
    setSaving(id)
    try {
      const res = await fetch('/api/settings/kpis', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, ...editDraft }),
      })
      const d = await res.json()
      if (!res.ok) throw new Error(d.error)
      setEditingId(null)
      setEditDraft({})
      setEditError(null)
      await load()
    } catch (e) {
      setEditError(e instanceof Error ? e.message : 'Save failed')
    } finally {
      setSaving(null)
    }
  }

  const handleDelete = async (id: string) => {
    setDeleting(id)
    try {
      const res = await fetch(`/api/settings/kpis?id=${encodeURIComponent(id)}`, { method: 'DELETE' })
      const d = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(d.error || `HTTP ${res.status}`)
      await load()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Delete failed')
    } finally {
      setDeleting(null)
    }
  }

  const inputStyle: React.CSSProperties = {
    background: 'var(--surface-2, rgba(255,255,255,0.04))',
    border: '1px solid var(--border)',
    borderRadius: '5px',
    padding: '5px 8px',
    color: 'var(--text-primary)',
    fontSize: '0.78rem',
    fontFamily: 'var(--font-mono)',
    width: '100%',
    outline: 'none',
  }

  const selectStyle: React.CSSProperties = { ...inputStyle, cursor: 'pointer' }
  const DIRECTION_OPTS = [{ v: 'up', l: '↑ Up' }, { v: 'down', l: '↓ Down' }, { v: 'neutral', l: '→ Neutral' }]
  const VIS_OPTS = [{ v: 'public', l: 'Public' }, { v: 'staff', l: 'Staff' }, { v: 'admin', l: 'Admin' }]
  const autoKpis = kpis.filter(k => k.source && k.source !== 'manual')
  const manualKpis = kpis.filter(k => !k.source || k.source === 'manual')

  return (
    <section className="settings-section" aria-label="Business KPIs">
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '12px', flexWrap: 'wrap' }}>
        <div>
          <h2 className="settings-section-title"><span className="rx-comment-label">01 //</span> Business KPIs</h2>
          <p className="settings-section-desc" style={{ margin: 0 }}>Auto-synced from GA4 · Stripe · Search Console. Manual KPIs below for custom metrics.</p>
        </div>
        {isAdmin && (
          <button id="kpi-sync-btn" onClick={handleSync} disabled={syncStatus.syncing}
            style={{ background: syncStatus.syncing ? 'transparent' : 'var(--accent)', border: syncStatus.syncing ? '1px solid var(--border)' : 'none', borderRadius: '6px', color: syncStatus.syncing ? 'var(--text-muted)' : '#000', fontWeight: 700, fontSize: '0.72rem', fontFamily: 'var(--font-mono)', cursor: syncStatus.syncing ? 'wait' : 'pointer', padding: '6px 14px', whiteSpace: 'nowrap', transition: 'all 0.15s ease', flexShrink: 0 }}>
            {syncStatus.syncing ? '⟳ Syncing…' : '⟳ Sync Now'}
          </button>
        )}
      </div>

      {syncStatus.result && (
        <div style={{ marginTop: '10px', padding: '8px 12px', background: 'rgba(52,168,83,0.08)', border: '1px solid rgba(52,168,83,0.2)', borderRadius: '6px', fontSize: '0.7rem', fontFamily: 'var(--font-mono)', color: 'var(--text-muted)' }}>
          ✓ Synced {syncStatus.result.synced} KPIs at {new Date(syncStatus.result.syncedAt).toLocaleTimeString()} ·
          {Object.entries(syncStatus.result.sources).map(([src, s]) => (
            <span key={src} style={{ marginLeft: '8px', color: s.ok ? 'var(--accent)' : 'var(--danger)' }}>{src.toUpperCase()} {s.ok ? `✓ ${s.count}` : `✗ ${(s.error ?? '').slice(0, 30)}`}</span>
          ))}
        </div>
      )}
      {syncStatus.error && (
        <div style={{ marginTop: '10px', padding: '8px 12px', background: 'rgba(231,76,60,0.08)', border: '1px solid rgba(231,76,60,0.2)', borderRadius: '6px', fontSize: '0.7rem', fontFamily: 'var(--font-mono)', color: 'var(--danger)' }}>⚠️ {syncStatus.error}</div>
      )}
      {error && <div className="settings-test-result settings-test-result--error" style={{ marginTop: '10px' }}>⚠️ {error}</div>}

      {loading ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', marginTop: '14px' }}>
          {[1,2,3,4].map(i => <div key={i} style={{ height: '44px', borderRadius: '6px', background: 'var(--surface-2)', animation: 'pulse 1.5s ease-in-out infinite' }} />)}
        </div>
      ) : (
        <>
          <div style={{ marginTop: '14px' }}>
            <div style={{ fontSize: '0.62rem', color: 'var(--text-muted)', fontFamily: 'var(--font-mono)', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: '6px' }}>Auto-synced</div>
            {autoKpis.length === 0 ? (
              <div style={{ padding: '12px', background: 'rgba(255,255,255,0.02)', border: '1px dashed var(--border)', borderRadius: '7px', fontSize: '0.72rem', color: 'var(--text-muted)', fontFamily: 'var(--font-mono)', lineHeight: 1.6 }}>
                No live data yet.{isAdmin ? <> Pick your property and site under <strong>Analytics Sources</strong> below (and add <code style={{ background: 'rgba(255,255,255,0.06)', padding: '1px 4px', borderRadius: '3px' }}>STRIPE_SECRET_KEY</code> for revenue), then click <strong>⟳ Sync Now</strong>.</> : ' Contact your admin.'}
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '5px' }}>
                {autoKpis.map(kpi => (
                  <div key={kpi.id} style={{ display: 'flex', alignItems: 'center', gap: '10px', padding: '8px 12px', background: 'var(--surface-2, rgba(255,255,255,0.03))', border: '1px solid var(--border)', borderRadius: '7px', flexWrap: 'wrap' }}>
                    <SourceBadge source={kpi.source} />
                    <div style={{ flex: 1, minWidth: '100px', fontSize: '0.78rem', fontWeight: 600, color: 'var(--text-primary)' }}>{kpi.label}</div>
                    <div style={{ fontFamily: 'var(--font-mono)', fontSize: '0.8rem', fontWeight: 700, color: 'var(--text-primary)' }}>{kpi.value}{kpi.unit && kpi.unit !== '$' ? ` ${kpi.unit}` : ''}</div>
                    <div style={{ fontSize: '0.68rem', fontFamily: 'var(--font-mono)', color: kpi.trendDirection === 'up' ? 'var(--accent)' : kpi.trendDirection === 'down' ? 'var(--danger)' : 'var(--text-muted)' }}>{kpi.trend || '—'}</div>
                    <div style={{ fontSize: '0.6rem', color: 'var(--text-muted)', fontFamily: 'var(--font-mono)', whiteSpace: 'nowrap' }}>{relativeTime(kpi.updatedAt)}</div>
                    {isAdmin && <button onClick={() => handleDelete(kpi.id)} disabled={deleting === kpi.id} style={{ background: 'transparent', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', fontSize: '0.65rem', padding: '2px 6px', opacity: 0.5 }}>✕</button>}
                  </div>
                ))}
              </div>
            )}
          </div>

          {(manualKpis.length > 0 || isAdmin) && (
            <div style={{ marginTop: '16px' }}>
              <div style={{ fontSize: '0.62rem', color: 'var(--text-muted)', fontFamily: 'var(--font-mono)', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: '6px' }}>Manual</div>
              {manualKpis.length === 0 ? (
                <div className="settings-empty" style={{ marginBottom: '10px' }}>No manual KPIs. Use the form below to add custom metrics.</div>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '5px', marginBottom: '10px' }}>
                  {manualKpis.map(kpi => (
                    <div key={kpi.id} style={{ padding: '10px 12px', background: 'var(--surface-2, rgba(255,255,255,0.04))', border: '1px solid var(--border)', borderRadius: '8px' }}>
                      {editingId === kpi.id ? (
                        <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                          <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr 1fr', gap: '6px' }}>
                            <input style={inputStyle} placeholder="Label" maxLength={255} value={editDraft.label ?? kpi.label} onChange={e => setEditDraft(p => ({ ...p, label: e.target.value }))} />
                            <input style={inputStyle} placeholder="Value" maxLength={255} value={editDraft.value ?? kpi.value} onChange={e => setEditDraft(p => ({ ...p, value: e.target.value }))} />
                            <input style={inputStyle} placeholder="Trend" maxLength={255} value={editDraft.trend ?? (kpi.trend || '')} onChange={e => setEditDraft(p => ({ ...p, trend: e.target.value }))} />
                          </div>
                          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '6px' }}>
                            <select style={selectStyle} value={editDraft.trendDirection ?? (kpi.trendDirection || 'neutral')} onChange={e => setEditDraft(p => ({ ...p, trendDirection: e.target.value as KpiDraft['trendDirection'] }))}>{DIRECTION_OPTS.map(o => <option key={o.v} value={o.v}>{o.l}</option>)}</select>
                            <input style={inputStyle} placeholder="Unit" maxLength={50} value={editDraft.unit ?? (kpi.unit || '')} onChange={e => setEditDraft(p => ({ ...p, unit: e.target.value }))} />
                            <select style={selectStyle} value={editDraft.visibility ?? (kpi.visibility || 'staff')} onChange={e => setEditDraft(p => ({ ...p, visibility: e.target.value as KpiDraft['visibility'] }))}>{VIS_OPTS.map(o => <option key={o.v} value={o.v}>{o.l}</option>)}</select>
                          </div>
                          <div style={{ display: 'flex', gap: '6px', justifyContent: 'flex-end' }}>
                            <button onClick={() => { setEditingId(null); setEditDraft({}) }} style={{ background: 'transparent', border: '1px solid var(--border)', borderRadius: '5px', color: 'var(--text-muted)', cursor: 'pointer', padding: '4px 12px', fontSize: '0.72rem' }}>Cancel</button>
                            <button onClick={() => handleSaveEdit(kpi.id)} disabled={saving === kpi.id} style={{ background: 'var(--accent)', border: 'none', borderRadius: '5px', color: '#000', fontWeight: 700, cursor: saving === kpi.id ? 'wait' : 'pointer', padding: '4px 14px', fontSize: '0.72rem', opacity: saving === kpi.id ? 0.6 : 1 }}>{saving === kpi.id ? 'Saving…' : 'Save'}</button>
                          </div>
                        </div>
                      ) : (
                        <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }}>
                          <SourceBadge source="manual" />
                          <div style={{ flex: 1, minWidth: '120px' }}>
                            <div style={{ fontSize: '0.8rem', fontWeight: 600, color: 'var(--text-primary)' }}>{kpi.label}</div>
                            <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)', marginTop: '2px', fontFamily: 'var(--font-mono)' }}>{kpi.value}{kpi.unit ? ` ${kpi.unit}` : ''}{kpi.trend ? ` · ${kpi.trend}` : ''} · <span style={{ color: kpi.trendDirection === 'up' ? 'var(--accent)' : kpi.trendDirection === 'down' ? 'var(--danger)' : 'var(--text-muted)' }}>{kpi.trendDirection === 'up' ? '↑' : kpi.trendDirection === 'down' ? '↓' : '→'}</span></div>
                          </div>
                          {isAdmin && (
                            <div style={{ display: 'flex', gap: '6px', flexShrink: 0 }}>
                              <button onClick={() => { setEditingId(kpi.id); setEditDraft({}) }} style={{ background: 'transparent', border: '1px solid var(--border)', borderRadius: '5px', color: 'var(--text-muted)', cursor: 'pointer', padding: '3px 10px', fontSize: '0.68rem' }}>Edit</button>
                              <button onClick={() => handleDelete(kpi.id)} disabled={deleting === kpi.id} style={{ background: 'transparent', border: '1px solid var(--danger, #e74c3c)', borderRadius: '5px', color: 'var(--danger, #e74c3c)', cursor: deleting === kpi.id ? 'wait' : 'pointer', padding: '3px 10px', fontSize: '0.68rem', opacity: deleting === kpi.id ? 0.5 : 1 }}>{deleting === kpi.id ? '…' : '✕'}</button>
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}
              {isAdmin && (
                <div style={{ border: '1px dashed var(--border)', borderRadius: '8px', padding: '12px', marginTop: '4px' }}>
                  <div style={{ fontSize: '0.68rem', color: 'var(--text-muted)', fontFamily: 'var(--font-mono)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: '8px' }}>Add Manual KPI</div>
                  <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr 1fr', gap: '6px', marginBottom: '6px' }}>
                    <input id="kpi-new-label" style={inputStyle} placeholder="Label (e.g. Monthly Revenue)" maxLength={255} value={newDraft.label} onChange={e => setNewDraft(p => ({ ...p, label: e.target.value }))} onKeyDown={e => { if (e.key === 'Enter') handleAdd() }} />
                    <input id="kpi-new-value" style={inputStyle} placeholder="Value (e.g. $42k)" maxLength={255} value={newDraft.value} onChange={e => setNewDraft(p => ({ ...p, value: e.target.value }))} />
                    <input id="kpi-new-trend" style={inputStyle} placeholder="Trend (e.g. +12%)" maxLength={255} value={newDraft.trend} onChange={e => setNewDraft(p => ({ ...p, trend: e.target.value }))} />
                  </div>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr auto', gap: '6px', alignItems: 'center' }}>
                    <select id="kpi-new-direction" style={selectStyle} value={newDraft.trendDirection} onChange={e => setNewDraft(p => ({ ...p, trendDirection: e.target.value as KpiDraft['trendDirection'] }))}>{DIRECTION_OPTS.map(o => <option key={o.v} value={o.v}>{o.l}</option>)}</select>
                    <input id="kpi-new-unit" style={inputStyle} placeholder="Unit (% / $)" maxLength={50} value={newDraft.unit} onChange={e => setNewDraft(p => ({ ...p, unit: e.target.value }))} />
                    <select id="kpi-new-visibility" style={selectStyle} value={newDraft.visibility} onChange={e => setNewDraft(p => ({ ...p, visibility: e.target.value as KpiDraft['visibility'] }))}>{VIS_OPTS.map(o => <option key={o.v} value={o.v}>{o.l}</option>)}</select>
                    <button id="kpi-add-btn" onClick={handleAdd} disabled={adding || !newDraft.label.trim()} style={{ background: 'var(--accent)', border: 'none', borderRadius: '6px', color: '#000', fontWeight: 700, cursor: adding || !newDraft.label.trim() ? 'not-allowed' : 'pointer', padding: '6px 14px', fontSize: '0.75rem', opacity: adding || !newDraft.label.trim() ? 0.5 : 1, whiteSpace: 'nowrap', transition: 'opacity 0.15s ease' }}>{adding ? '…' : '+ Add'}</button>
                  </div>
                  {addError && <div style={{ marginTop: '6px', fontSize: '0.7rem', color: 'var(--danger)', fontFamily: 'var(--font-mono)' }}>⚠️ {addError}</div>}
                </div>
              )}
            </div>
          )}
        </>
      )}
    </section>
  )
}


/* ══════════════════════════════════════════════════════════════════════════════
   CONNECTED SERVICES CARD (API Key Management)
   Proxies to Paperclip's encrypted secrets store via /api/settings/keys
   ══════════════════════════════════════════════════════════════════════════════ */

interface ServiceBundle {
  id: string
  label: string
  icon: string
  description: string
  keys: { name: string; placeholder: string }[]
}

const SERVICE_BUNDLES: ServiceBundle[] = [
  {
    id: 'gbp',
    label: 'Google Business Profile',
    icon: '📍',
    description: 'Manage your Google Business Profile listings, reviews, and posts',
    keys: [
      { name: 'GBP_CLIENT_ID', placeholder: 'Google OAuth Client ID' },
      { name: 'GBP_CLIENT_SECRET', placeholder: 'Google OAuth Client Secret' },
      { name: 'GBP_REFRESH_TOKEN', placeholder: 'OAuth Refresh Token' },
    ],
  },
  {
    id: 'stripe',
    label: 'Stripe Payments',
    icon: '💳',
    description: 'Enable revenue tracking, payment processing, and financial reports',
    keys: [
      { name: 'STRIPE_SECRET_KEY', placeholder: 'sk_live_...' },
      { name: 'STRIPE_WEBHOOK_SECRET', placeholder: 'whsec_...' },
    ],
  },
  {
    id: 'wordpress',
    label: 'WordPress / CMS',
    icon: '📝',
    description: 'Publish SEO content and manage your website automatically',
    keys: [
      { name: 'WP_REST_URL', placeholder: 'https://yoursite.com/wp-json' },
      { name: 'WP_USER', placeholder: 'WordPress username' },
      { name: 'WP_APP_PASS', placeholder: 'Application password' },
    ],
  },
  {
    id: 'seo',
    label: 'SEO Tools',
    icon: '🔍',
    description: 'Run SEO audits, keyword tracking, and competitive analysis',
    keys: [
      { name: 'AHREFS_API_KEY', placeholder: 'Ahrefs API key' },
      { name: 'DATAFORSEO_BASE64', placeholder: 'DataForSEO base64 credentials' },
    ],
  },
]

interface SecretMeta {
  id: string
  name: string
  key: string
  status: string
  createdAt: string
  lastRotatedAt: string | null
}

function ConnectedServicesCard() {
  const { companies, isLoading: companiesLoading } = useCompanies()
  const [selectedCompanyId, setSelectedCompanyId] = useState<string>('')
  const [secrets, setSecrets] = useState<SecretMeta[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [expandedBundle, setExpandedBundle] = useState<string | null>(null)
  const [bundleDrafts, setBundleDrafts] = useState<Record<string, Record<string, string>>>({})
  const [saving, setSaving] = useState(false)
  const [saveResult, setSaveResult] = useState<{ type: 'ok' | 'err'; text: string } | null>(null)
  // Custom key
  const [customName, setCustomName] = useState('')
  const [customValue, setCustomValue] = useState('')
  const [customSaving, setCustomSaving] = useState(false)
  const [customMsg, setCustomMsg] = useState<{ type: 'ok' | 'err'; text: string } | null>(null)
  // Delete
  const [deleting, setDeleting] = useState<string | null>(null)

  // Auto-select first company when companies load
  useEffect(() => {
    if (companies.length > 0 && !selectedCompanyId) {
      setSelectedCompanyId(companies[0].id)
    }
  }, [companies, selectedCompanyId])

  const loadSecrets = useCallback(async () => {
    if (!selectedCompanyId) return
    setLoading(true)
    setError(null)
    try {
      const res = await fetch(`/api/settings/keys?companyId=${encodeURIComponent(selectedCompanyId)}`)
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`)
      setSecrets(data.secrets ?? [])
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load')
    } finally {
      setLoading(false)
    }
  }, [selectedCompanyId])

  useEffect(() => { loadSecrets() }, [loadSecrets])

  // Check which bundles are connected (all keys present)
  const isBundleConnected = (bundle: ServiceBundle) =>
    bundle.keys.every(k => secrets.some(s => s.name === k.name))

  const getBundlePartialCount = (bundle: ServiceBundle) =>
    bundle.keys.filter(k => secrets.some(s => s.name === k.name)).length

  // Save a bundle's keys
  const handleSaveBundle = async (bundle: ServiceBundle) => {
    const drafts = bundleDrafts[bundle.id] ?? {}
    const keysToSave = bundle.keys.filter(k =>
      drafts[k.name] && drafts[k.name].trim() && !secrets.some(s => s.name === k.name)
    )

    if (keysToSave.length === 0) {
      setSaveResult({ type: 'err', text: 'No new keys to save' })
      return
    }

    setSaving(true)
    setSaveResult(null)

    try {
      for (const key of keysToSave) {
        const res = await fetch('/api/settings/keys', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: key.name, value: drafts[key.name], companyId: selectedCompanyId }),
        })
        const data = await res.json()
        if (!res.ok) throw new Error(data.error || `Failed to save ${key.name}`)
      }
      setSaveResult({ type: 'ok', text: `${keysToSave.length} key${keysToSave.length > 1 ? 's' : ''} saved & encrypted` })
      setBundleDrafts(prev => ({ ...prev, [bundle.id]: {} }))
      setExpandedBundle(null)
      await loadSecrets()
    } catch (e) {
      setSaveResult({ type: 'err', text: e instanceof Error ? e.message : 'Save failed' })
    } finally {
      setSaving(false)
    }
  }

  // Save custom key
  const handleSaveCustom = async () => {
    if (!customName.trim() || !customValue.trim()) return
    setCustomSaving(true)
    setCustomMsg(null)

    try {
      const res = await fetch('/api/settings/keys', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: customName.toUpperCase().replace(/\s+/g, '_'), value: customValue, companyId: selectedCompanyId }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Failed to save')
      setCustomMsg({ type: 'ok', text: `${data.name} saved & encrypted` })
      setCustomName('')
      setCustomValue('')
      await loadSecrets()
    } catch (e) {
      setCustomMsg({ type: 'err', text: e instanceof Error ? e.message : 'Failed' })
    } finally {
      setCustomSaving(false)
    }
  }

  // Delete a key
  const handleDelete = async (secretId: string) => {
    setDeleting(secretId)
    try {
      const res = await fetch(`/api/settings/keys?id=${encodeURIComponent(secretId)}&companyId=${encodeURIComponent(selectedCompanyId)}`, { method: 'DELETE' })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error || 'Delete failed')
      await loadSecrets()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Delete failed')
    } finally {
      setDeleting(null)
    }
  }

  const updateDraft = (bundleId: string, keyName: string, value: string) => {
    setBundleDrafts(prev => ({
      ...prev,
      [bundleId]: { ...(prev[bundleId] ?? {}), [keyName]: value },
    }))
  }

  const cardBaseStyle: React.CSSProperties = {
    padding: '14px 16px',
    borderRadius: '10px',
    transition: 'all 0.2s ease',
    cursor: 'pointer',
  }

  const connectedStyle: React.CSSProperties = {
    ...cardBaseStyle,
    background: 'rgba(52,168,83,0.06)',
    border: '1px solid rgba(52,168,83,0.25)',
  }

  const disconnectedStyle: React.CSSProperties = {
    ...cardBaseStyle,
    background: 'rgba(255,255,255,0.02)',
    border: '1px dashed var(--border)',
  }

  const inputStyle: React.CSSProperties = {
    background: 'var(--surface-2, rgba(255,255,255,0.04))',
    border: '1px solid var(--border)',
    borderRadius: '6px',
    padding: '7px 10px',
    color: 'var(--text-primary)',
    fontSize: '0.78rem',
    fontFamily: 'var(--font-mono)',
    width: '100%',
    outline: 'none',
  }

  return (
    <section className="settings-section" id="api-keys" aria-label="Connected Services">
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '12px', flexWrap: 'wrap' }}>
        <div>
          <h2 className="settings-section-title">
            <span className="rx-comment-label">02 //</span>{' '}
            Connected Services
          </h2>
          <p className="settings-section-desc" style={{ margin: 0 }}>
            Connect your business accounts to unlock autonomous marketing, SEO, and revenue operations.
            Keys are encrypted and stored per-workspace.
          </p>
        </div>
        {/* Workspace Selector */}
        {companies.length > 1 && (
          <select
            id="api-keys-workspace-select"
            value={selectedCompanyId}
            onChange={e => {
              setSelectedCompanyId(e.target.value)
              setExpandedBundle(null)
              setSaveResult(null)
            }}
            style={{
              background: 'var(--surface-2, rgba(255,255,255,0.04))',
              border: '1px solid var(--border)',
              borderRadius: '6px',
              padding: '6px 10px',
              color: 'var(--text-primary)',
              fontSize: '0.75rem',
              fontFamily: 'var(--font-mono)',
              cursor: 'pointer',
              outline: 'none',
              flexShrink: 0,
              maxWidth: '220px',
            }}
            aria-label="Select workspace for API keys"
          >
            {companies.map(c => (
              <option key={c.id} value={c.id}>
                {c.name} ({c.identifier})
              </option>
            ))}
          </select>
        )}
        {companies.length === 1 && (
          <span style={{
            fontSize: '0.68rem',
            fontFamily: 'var(--font-mono)',
            color: 'var(--text-muted)',
            padding: '4px 10px',
            background: 'rgba(255,255,255,0.04)',
            borderRadius: '6px',
            border: '1px solid var(--border)',
            flexShrink: 0,
          }}>
            {companies[0].name}
          </span>
        )}
      </div>

      {error && (
        <div className="settings-test-result settings-test-result--error" style={{ marginBottom: '12px' }}>
          ⚠️ {error}
        </div>
      )}

      {loading ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
          {[1, 2, 3, 4].map(i => (
            <div key={i} style={{ height: '60px', borderRadius: '10px', background: 'var(--surface-2)', animation: 'pulse 1.5s ease-in-out infinite' }} />
          ))}
        </div>
      ) : (
        <>
          {/* Service Bundles */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', marginBottom: '16px' }}>
            {SERVICE_BUNDLES.map(bundle => {
              const connected = isBundleConnected(bundle)
              const partialCount = getBundlePartialCount(bundle)
              const isExpanded = expandedBundle === bundle.id
              const drafts = bundleDrafts[bundle.id] ?? {}

              return (
                <div key={bundle.id} style={connected ? connectedStyle : disconnectedStyle}>
                  {/* Summary Row */}
                  <div
                    style={{ display: 'flex', alignItems: 'center', gap: '12px' }}
                    onClick={() => {
                      setSaveResult(null)
                      setExpandedBundle(isExpanded ? null : bundle.id)
                    }}
                  >
                    <span style={{ fontSize: '1.3rem', flexShrink: 0 }} aria-hidden="true">{bundle.icon}</span>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: '0.85rem', fontWeight: 600, color: 'var(--text-primary)' }}>
                        {bundle.label}
                      </div>
                      <div style={{ fontSize: '0.68rem', color: 'var(--text-muted)', marginTop: '2px' }}>
                        {bundle.description}
                      </div>
                    </div>
                    <span style={{
                      fontSize: '0.65rem',
                      fontWeight: 700,
                      fontFamily: 'var(--font-mono)',
                      padding: '3px 10px',
                      borderRadius: '20px',
                      textTransform: 'uppercase',
                      letterSpacing: '0.06em',
                      flexShrink: 0,
                      ...(connected ? {
                        color: '#34a853',
                        background: 'rgba(52,168,83,0.12)',
                      } : partialCount > 0 ? {
                        color: 'var(--warn, #f59e0b)',
                        background: 'rgba(245,158,11,0.12)',
                      } : {
                        color: 'var(--text-muted)',
                        background: 'rgba(255,255,255,0.06)',
                      }),
                    }}>
                      {connected ? '✓ Connected' : partialCount > 0 ? `${partialCount}/${bundle.keys.length}` : 'Connect →'}
                    </span>
                  </div>

                  {/* Expanded Form */}
                  {isExpanded && (
                    <div style={{ marginTop: '14px', paddingTop: '14px', borderTop: '1px solid var(--border)' }}>
                      <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                        {bundle.keys.map(key => {
                          const existing = secrets.find(s => s.name === key.name)
                          return (
                            <div key={key.name}>
                              <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '4px' }}>
                                <label style={{
                                  fontSize: '0.65rem',
                                  fontFamily: 'var(--font-mono)',
                                  color: 'var(--text-muted)',
                                  textTransform: 'uppercase',
                                  letterSpacing: '0.06em',
                                  flex: 1,
                                }}>
                                  {key.name}
                                </label>
                                {existing && (
                                  <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                                    <span style={{ fontSize: '0.6rem', color: '#34a853', fontFamily: 'var(--font-mono)' }}>
                                      ✓ Set
                                    </span>
                                    <button
                                      onClick={(e) => { e.stopPropagation(); handleDelete(existing.id) }}
                                      disabled={deleting === existing.id}
                                      style={{
                                        background: 'transparent',
                                        border: '1px solid var(--danger, #e74c3c)',
                                        borderRadius: '4px',
                                        color: 'var(--danger, #e74c3c)',
                                        cursor: deleting === existing.id ? 'wait' : 'pointer',
                                        padding: '1px 6px',
                                        fontSize: '0.6rem',
                                        opacity: deleting === existing.id ? 0.5 : 1,
                                      }}
                                    >
                                      {deleting === existing.id ? '…' : '✕'}
                                    </button>
                                  </div>
                                )}
                              </div>
                              {!existing && (
                                <input
                                  type="password"
                                  style={inputStyle}
                                  placeholder={key.placeholder}
                                  value={drafts[key.name] ?? ''}
                                  onChange={e => updateDraft(bundle.id, key.name, e.target.value)}
                                  autoComplete="off"
                                />
                              )}
                            </div>
                          )
                        })}
                      </div>

                      {/* Save Result */}
                      {saveResult && expandedBundle === bundle.id && (
                        <div style={{
                          marginTop: '8px',
                          fontSize: '0.72rem',
                          fontFamily: 'var(--font-mono)',
                          color: saveResult.type === 'ok' ? 'var(--accent)' : 'var(--danger)',
                        }}>
                          {saveResult.type === 'ok' ? '✓' : '⚠️'} {saveResult.text}
                        </div>
                      )}

                      {/* Save Button */}
                      {bundle.keys.some(k => !secrets.some(s => s.name === k.name)) && (
                        <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: '10px' }}>
                          <button
                            onClick={(e) => { e.stopPropagation(); handleSaveBundle(bundle) }}
                            disabled={saving}
                            style={{
                              background: 'var(--accent)',
                              border: 'none',
                              borderRadius: '6px',
                              color: '#000',
                              fontWeight: 700,
                              cursor: saving ? 'wait' : 'pointer',
                              padding: '6px 18px',
                              fontSize: '0.75rem',
                              fontFamily: 'var(--font-mono)',
                              opacity: saving ? 0.6 : 1,
                              transition: 'opacity 0.15s ease',
                            }}
                          >
                            {saving ? 'Encrypting…' : '🔐 Save & Encrypt'}
                          </button>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )
            })}
          </div>

          {/* Existing Keys Summary */}
          {secrets.length > 0 && (
            <div style={{ marginBottom: '16px' }}>
              <div style={{
                fontSize: '0.62rem',
                color: 'var(--text-muted)',
                fontFamily: 'var(--font-mono)',
                textTransform: 'uppercase',
                letterSpacing: '0.08em',
                marginBottom: '6px',
              }}>
                All Keys ({secrets.length})
              </div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px' }}>
                {secrets.map(s => (
                  <span
                    key={s.id}
                    style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: '5px',
                      padding: '3px 9px',
                      borderRadius: '20px',
                      border: '1px solid rgba(52,168,83,0.2)',
                      background: 'rgba(52,168,83,0.06)',
                      fontSize: '0.65rem',
                      fontFamily: 'var(--font-mono)',
                      color: 'var(--text-secondary)',
                    }}
                  >
                    <span style={{ color: '#34a853', fontSize: '0.5rem' }}>●</span>
                    {s.name}
                    <button
                      onClick={() => handleDelete(s.id)}
                      disabled={deleting === s.id}
                      style={{
                        background: 'transparent',
                        border: 'none',
                        color: 'var(--text-muted)',
                        cursor: deleting === s.id ? 'wait' : 'pointer',
                        fontSize: '0.6rem',
                        padding: '0 2px',
                        opacity: 0.5,
                        transition: 'opacity 0.15s ease',
                      }}
                      aria-label={`Remove ${s.name}`}
                    >
                      ✕
                    </button>
                  </span>
                ))}
              </div>
            </div>
          )}

          {/* Custom Key */}
          <div style={{
            border: '1px dashed var(--border)',
            borderRadius: '10px',
            padding: '14px 16px',
          }}>
            <div style={{
              fontSize: '0.68rem',
              color: 'var(--text-muted)',
              fontFamily: 'var(--font-mono)',
              textTransform: 'uppercase',
              letterSpacing: '0.06em',
              marginBottom: '8px',
            }}>
              + Add Custom Key
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 2fr auto', gap: '8px', alignItems: 'end' }}>
              <div>
                <label style={{ fontSize: '0.6rem', fontFamily: 'var(--font-mono)', color: 'var(--text-muted)', display: 'block', marginBottom: '3px' }}>
                  KEY NAME
                </label>
                <input
                  id="settings-custom-key-name"
                  style={inputStyle}
                  placeholder="MY_API_KEY"
                  value={customName}
                  onChange={e => { setCustomName(e.target.value); setCustomMsg(null) }}
                  autoComplete="off"
                />
              </div>
              <div>
                <label style={{ fontSize: '0.6rem', fontFamily: 'var(--font-mono)', color: 'var(--text-muted)', display: 'block', marginBottom: '3px' }}>
                  VALUE
                </label>
                <input
                  id="settings-custom-key-value"
                  type="password"
                  style={inputStyle}
                  placeholder="Paste your secret key"
                  value={customValue}
                  onChange={e => { setCustomValue(e.target.value); setCustomMsg(null) }}
                  autoComplete="off"
                />
              </div>
              <button
                id="settings-custom-key-save-btn"
                onClick={handleSaveCustom}
                disabled={customSaving || !customName.trim() || !customValue.trim()}
                style={{
                  background: 'var(--accent)',
                  border: 'none',
                  borderRadius: '6px',
                  color: '#000',
                  fontWeight: 700,
                  cursor: customSaving || !customName.trim() || !customValue.trim() ? 'not-allowed' : 'pointer',
                  padding: '7px 14px',
                  fontSize: '0.75rem',
                  opacity: customSaving || !customName.trim() || !customValue.trim() ? 0.5 : 1,
                  whiteSpace: 'nowrap',
                  transition: 'opacity 0.15s ease',
                }}
              >
                {customSaving ? '…' : '+ Add'}
              </button>
            </div>
            {customMsg && (
              <div style={{
                marginTop: '6px',
                fontSize: '0.72rem',
                fontFamily: 'var(--font-mono)',
                color: customMsg.type === 'ok' ? 'var(--accent)' : 'var(--danger)',
              }}>
                {customMsg.type === 'ok' ? '✓' : '⚠️'} {customMsg.text}
              </div>
            )}
          </div>
        </>
      )}
    </section>
  )
}


/* ══════════════════════════════════════════════════════════════════════════════

   SETTINGS PAGE
   ══════════════════════════════════════════════════════════════════════════════ */

export default function SettingsPage() {
  const { data: session, status } = useSession()
  const router = useRouter()

  // Redirect unauthenticated users
  useEffect(() => {
    if (status === 'unauthenticated') {
      router.push('/login')
    }
  }, [status, router])

  /* ── Loading / Auth guard ── */
  if (status === 'loading') {
    return (
      <div className="settings-page">
        <div className="settings-loading">Loading...</div>
      </div>
    )
  }

  if (!session) return null

  const userRole = (session.user as Record<string, unknown>)?.role as string | undefined
  const isAdmin = userRole === 'admin' || userRole === 'superadmin'

  const userEmail = (session?.user as Record<string, unknown>)?.email as string ?? ''
  const userName = session?.user?.name ?? ''

  return (
    <div className="settings-page">
      {/* ── Header ── */}
      <header className="settings-header">
        <Link href="/" className="settings-back-btn" aria-label="Back to Hub">
          ← Back
        </Link>
        <h1 className="settings-title">Hub Settings</h1>
        <div className="settings-header-spacer" />
      </header>

      {/* ── Profile ── */}
      <section className="settings-section" aria-label="Profile">
        <h2 className="settings-section-title">
          <span className="rx-comment-label">00 //</span> Profile
        </h2>
        <div className="settings-profile-card">
          {session?.user?.image ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={session.user.image} alt={userName} className="settings-profile-avatar" width={40} height={40} />
          ) : (
            <div className="settings-profile-avatar settings-profile-avatar--initials" aria-hidden="true">
              {userName.split(' ').map((w: string) => w[0]).slice(0, 2).join('').toUpperCase() || '?'}
            </div>
          )}
          <div className="settings-profile-info">
            <div className="settings-profile-name">{userName}</div>
            <div className="settings-profile-email">{userEmail}</div>
          </div>
          <button
            id="settings-sign-out-btn"
            className="settings-sign-out-btn"
            onClick={() => signOut({ callbackUrl: '/login' })}
          >
            Sign out
          </button>
        </div>
      </section>

      {/* Admin-only warning */}
      {!isAdmin && (
        <div className="settings-section settings-warning">
          <p>⚠️ You do not have admin privileges. Changes may not persist across sessions.</p>
        </div>
      )}

      {/* ── Business KPIs (DB) ── */}
      <KPIEditorCard isAdmin={isAdmin} />



      {/* ── Google Chat Spaces (visibility, saved to your account) ── */}
      <ChatSpacesSettings />

      {/* ── Analytics sources (GA4 property + GSC site) — admin only; the
             component hides itself when the API answers 403 for staff ── */}
      <AnalyticsSettings />

      {/* ── Scheduled report cadence + recipients — admin only; same
             self-hiding 403 behavior as AnalyticsSettings above ── */}
      <ScheduledReportsSettings />

      {/* ── Email Focus Priorities (VIP list + goals) — every user ── */}
      <FocusPreferencesSettings />

      {/* ── Connected Services / API Keys (admin + superadmin) ── */}
      {isAdmin && (
        <ConnectedServicesCard />
      )}

      {/* ── Onboarding Users (admin + superadmin only) ── */}
      {isAdmin && (
        <OnboardingUsersCard callerRole={userRole ?? 'staff'} />
      )}

      {/* ── Team Members (admin + superadmin only) ── */}
      {isAdmin && (
        <TeamMembersCard callerRole={userRole ?? 'staff'} />
      )}
    </div>
  )
}

/* ───────────────────────────────────────────────────────────────────────────────
   TEAM MEMBERS CARD
   View and edit project assignments for active (non-onboarding) users.
─────────────────────────────────────────────────────────────────────────────── */

const TEAM_ROLE_LABELS: Record<string, string> = {
  superadmin: 'Super Admin',
  admin: 'Admin',
  staff: 'Staff',
}

interface TeamMember {
  email: string
  name?: string
  role: string
  assignedProjects: string[]
}

function TeamMembersCard({ callerRole }: { callerRole: string }) {
  const [members, setMembers] = useState<TeamMember[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [editingEmail, setEditingEmail] = useState<string | null>(null)
  const [editProjects, setEditProjects] = useState<string[]>([])
  const [editRole, setEditRole] = useState<string>('staff')
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)

  const { companies } = useCompanies()
  const isSuperadmin = callerRole === 'superadmin'

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch('/api/admin/roles')
      if (!res.ok) throw new Error(`Failed to load team (${res.status})`)
      const data: { users: TeamMember[] } = await res.json()
      // Show all non-onboarding users; superadmin sees everyone, admin sees non-superadmins
      const visible = data.users.filter(u => {
        if (u.role === 'onboarding') return false
        if (!isSuperadmin && u.role === 'superadmin') return false
        return true
      })
      setMembers(visible)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error')
    } finally {
      setLoading(false)
    }
  }, [isSuperadmin])

  useEffect(() => { load() }, [load])

  const startEdit = (m: TeamMember) => {
    setEditingEmail(m.email)
    setEditRole(m.role)
    setEditProjects(m.assignedProjects ?? [])
    setSaveError(null)
  }

  const cancelEdit = () => {
    setEditingEmail(null)
    setEditProjects([])
    setSaveError(null)
  }

  const handleSave = async (email: string) => {
    setSaving(true)
    setSaveError(null)
    const projectsToSave = editRole === 'admin' ? ['*'] : editProjects
    try {
      const res = await fetch('/api/admin/roles', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, role: editRole, assignedProjects: projectsToSave }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || `Failed (${res.status})`)
      setEditingEmail(null)
      await load()
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : 'Save failed')
    } finally {
      setSaving(false)
    }
  }

  const toggleProject = (companyId: string) => {
    setEditProjects(prev =>
      prev.includes(companyId) ? prev.filter(p => p !== companyId) : [...prev, companyId]
    )
  }

  // Roles that the caller can assign
  const editableRoles = isSuperadmin ? ['staff', 'admin'] : ['staff']

  return (
    <section className="settings-section" aria-label="Team members">
      <h2 className="settings-section-title">
        <span className="rx-comment-label">04 //</span> Team Members
      </h2>
      <p className="settings-section-desc">
        View and update project access for active team members.
      </p>

      {error && (
        <div className="settings-test-result settings-test-result--error" style={{ marginBottom: '12px' }}>
          ⚠️ {error}
        </div>
      )}

      {loading ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
          {[1, 2, 3].map(i => (
            <div key={i} style={{ height: '48px', borderRadius: '8px', background: 'var(--surface-2, rgba(255,255,255,0.04))', animation: 'pulse 1.5s ease-in-out infinite' }} />
          ))}
        </div>
      ) : members.length === 0 ? (
        <div className="settings-empty" style={{ padding: '20px 0', textAlign: 'center' }}>
          No active team members yet.
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
          {members.map(m => {
            const isEditing = editingEmail === m.email
            const hasAll = m.assignedProjects?.includes('*')
            const projectNames = hasAll
              ? 'All Projects'
              : m.assignedProjects?.length
                ? companies.filter(c => m.assignedProjects.includes(c.id)).map(c => c.name).join(', ') || m.assignedProjects.join(', ')
                : 'No projects'

            return (
              <div
                key={m.email}
                style={{
                  padding: '10px 14px',
                  borderRadius: '8px',
                  background: 'var(--surface-2, rgba(255,255,255,0.04))',
                  border: `1px solid ${isEditing ? 'var(--accent)' : 'var(--border)'}`,
                  transition: 'border-color 0.15s ease',
                }}
              >
                {/* Row summary */}
                <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }}>
                  <div style={{ width: '32px', height: '32px', borderRadius: '50%', background: 'rgba(197,160,89,0.15)', color: 'var(--accent)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '0.75rem', fontWeight: 700, flexShrink: 0 }}>
                    {(m.name || m.email)[0].toUpperCase()}
                  </div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 'var(--text-sm)', fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{m.email}</div>
                    <div style={{ fontSize: '0.65rem', color: 'var(--text-muted)', fontFamily: 'var(--font-mono)', marginTop: '2px' }}>
                      {TEAM_ROLE_LABELS[m.role] ?? m.role} &middot; {projectNames}
                    </div>
                  </div>
                  {/* Only editable if caller outranks member */}
                  {(isSuperadmin || m.role !== 'admin') && m.role !== 'superadmin' && (
                    isEditing ? (
                      <button
                        onClick={cancelEdit}
                        style={{ background: 'transparent', border: '1px solid var(--border)', borderRadius: '6px', color: 'var(--text-muted)', cursor: 'pointer', padding: '4px 10px', fontSize: '0.7rem' }}
                      >
                        Cancel
                      </button>
                    ) : (
                      <button
                        onClick={() => startEdit(m)}
                        style={{ background: 'transparent', border: '1px solid var(--border)', borderRadius: '6px', color: 'var(--text-secondary)', cursor: 'pointer', padding: '4px 10px', fontSize: '0.7rem', transition: 'all 0.15s ease' }}
                        aria-label={`Edit ${m.email}`}
                      >
                        Edit
                      </button>
                    )
                  )}
                </div>

                {/* Inline editor */}
                {isEditing && (
                  <div style={{ marginTop: '12px', paddingTop: '12px', borderTop: '1px solid var(--border)' }}>
                    {/* Role picker */}
                    <div style={{ marginBottom: '10px' }}>
                      <div style={{ fontSize: '0.62rem', color: 'var(--text-muted)', fontFamily: 'var(--font-mono)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: '5px' }}>Role</div>
                      <select
                        value={editRole}
                        onChange={e => { setEditRole(e.target.value); setEditProjects([]) }}
                        className="admin-role-select"
                        style={{ height: '32px', borderRadius: '6px', fontSize: 'var(--text-xs)' }}
                      >
                        {editableRoles.map(r => <option key={r} value={r}>{TEAM_ROLE_LABELS[r]}</option>)}
                      </select>
                    </div>

                    {/* Project checkboxes — staff only */}
                    {editRole === 'staff' && companies.length > 0 && (
                      <div style={{ marginBottom: '10px' }}>
                        <div style={{ fontSize: '0.62rem', color: 'var(--text-muted)', fontFamily: 'var(--font-mono)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: '6px' }}>Project Access</div>
                        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px' }}>
                          {companies.map((c: Company) => {
                            const checked = editProjects.includes(c.id)
                            return (
                              <label
                                key={c.id}
                                style={{
                                  display: 'inline-flex', alignItems: 'center', gap: '5px',
                                  padding: '3px 9px', borderRadius: '20px',
                                  border: `1px solid ${checked ? 'var(--accent)' : 'var(--border)'}`,
                                  background: checked ? 'rgba(197,160,89,0.12)' : 'rgba(255,255,255,0.03)',
                                  fontSize: '0.7rem', cursor: 'pointer', transition: 'all 0.15s ease',
                                  color: checked ? 'var(--accent)' : 'var(--text-secondary)',
                                  userSelect: 'none',
                                }}
                              >
                                <input type="checkbox" checked={checked} onChange={() => toggleProject(c.id)} style={{ display: 'none' }} />
                                {checked ? '✓ ' : ''}{c.identifier?.slice(0,2).toUpperCase() ?? c.id.slice(0,2).toUpperCase()} · {c.name}
                              </label>
                            )
                          })}
                        </div>
                        {editProjects.length === 0 && (
                          <div style={{ marginTop: '4px', fontSize: '0.65rem', color: 'var(--warn, #f59e0b)', fontFamily: 'var(--font-mono)' }}>
                            ⚠ No projects selected — staff won&apos;t see data until assigned
                          </div>
                        )}
                      </div>
                    )}

                    {saveError && (
                      <div style={{ marginBottom: '8px', fontSize: '0.7rem', color: 'var(--danger)', fontFamily: 'var(--font-mono)' }}>⚠️ {saveError}</div>
                    )}

                    <div style={{ display: 'flex', gap: '8px', justifyContent: 'flex-end' }}>
                      <button
                        onClick={cancelEdit}
                        style={{ background: 'transparent', border: '1px solid var(--border)', borderRadius: '6px', color: 'var(--text-muted)', cursor: 'pointer', padding: '5px 14px', fontSize: '0.72rem' }}
                      >
                        Cancel
                      </button>
                      <button
                        onClick={() => handleSave(m.email)}
                        disabled={saving}
                        style={{ background: 'var(--accent)', border: 'none', borderRadius: '6px', color: '#000', fontWeight: 700, cursor: saving ? 'wait' : 'pointer', padding: '5px 16px', fontSize: '0.72rem', opacity: saving ? 0.6 : 1, transition: 'opacity 0.15s ease' }}
                        aria-label={`Save changes for ${m.email}`}
                      >
                        {saving ? 'Saving…' : 'Save'}
                      </button>
                    </div>
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}
    </section>
  )
}
