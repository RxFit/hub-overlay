'use client'

import React, { useState, useEffect, useCallback, useRef } from 'react'
import { useSession, signOut, signIn } from 'next-auth/react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { useSpaces, setPinnedSpaces, getPinnedSpaces } from '@/app/hooks/useGoogleChat'
import type { ChatSpace } from '@/app/hooks/useGoogleChat'
import { InfoPopover } from '@/app/components/InfoPopover'

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

    setUsers(prev => prev.map(u => u.email === email ? { ...u, saving: true, error: null } : u))

    try {
      const res = await fetch('/api/admin/roles', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, role: user.pendingRole, assignedProjects: [] }),
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
                onChange={e => setUsers(prev => prev.map(u => u.email === user.email ? { ...u, pendingRole: e.target.value } : u))}
                disabled={user.saving}
                aria-label={`Assign role for ${user.email}`}
                style={{ height: '34px', borderRadius: '6px', fontSize: 'var(--text-xs)', minWidth: '90px' }}
              >
                {roleOptions.map(r => (
                  <option key={r} value={r}>{ONBOARDING_ROLE_LABELS[r]}</option>
                ))}
              </select>

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
                No live data yet.{isAdmin ? <> Add <code style={{ background: 'rgba(255,255,255,0.06)', padding: '1px 4px', borderRadius: '3px' }}>GA4_PROPERTY_ID</code>, <code style={{ background: 'rgba(255,255,255,0.06)', padding: '1px 4px', borderRadius: '3px' }}>STRIPE_SECRET_KEY</code>, <code style={{ background: 'rgba(255,255,255,0.06)', padding: '1px 4px', borderRadius: '3px' }}>GSC_SITE_URL</code> to Railway, then click <strong>⟳ Sync Now</strong>.</> : ' Contact your admin.'}
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
                            <input style={inputStyle} placeholder="Label" value={editDraft.label ?? kpi.label} onChange={e => setEditDraft(p => ({ ...p, label: e.target.value }))} />
                            <input style={inputStyle} placeholder="Value" value={editDraft.value ?? kpi.value} onChange={e => setEditDraft(p => ({ ...p, value: e.target.value }))} />
                            <input style={inputStyle} placeholder="Trend" value={editDraft.trend ?? (kpi.trend || '')} onChange={e => setEditDraft(p => ({ ...p, trend: e.target.value }))} />
                          </div>
                          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '6px' }}>
                            <select style={selectStyle} value={editDraft.trendDirection ?? (kpi.trendDirection || 'neutral')} onChange={e => setEditDraft(p => ({ ...p, trendDirection: e.target.value as KpiDraft['trendDirection'] }))}>{DIRECTION_OPTS.map(o => <option key={o.v} value={o.v}>{o.l}</option>)}</select>
                            <input style={inputStyle} placeholder="Unit" value={editDraft.unit ?? (kpi.unit || '')} onChange={e => setEditDraft(p => ({ ...p, unit: e.target.value }))} />
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
                    <input id="kpi-new-label" style={inputStyle} placeholder="Label (e.g. Monthly Revenue)" value={newDraft.label} onChange={e => setNewDraft(p => ({ ...p, label: e.target.value }))} onKeyDown={e => { if (e.key === 'Enter') handleAdd() }} />
                    <input id="kpi-new-value" style={inputStyle} placeholder="Value (e.g. $42k)" value={newDraft.value} onChange={e => setNewDraft(p => ({ ...p, value: e.target.value }))} />
                    <input id="kpi-new-trend" style={inputStyle} placeholder="Trend (e.g. +12%)" value={newDraft.trend} onChange={e => setNewDraft(p => ({ ...p, trend: e.target.value }))} />
                  </div>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr auto', gap: '6px', alignItems: 'center' }}>
                    <select id="kpi-new-direction" style={selectStyle} value={newDraft.trendDirection} onChange={e => setNewDraft(p => ({ ...p, trendDirection: e.target.value as KpiDraft['trendDirection'] }))}>{DIRECTION_OPTS.map(o => <option key={o.v} value={o.v}>{o.l}</option>)}</select>
                    <input id="kpi-new-unit" style={inputStyle} placeholder="Unit (% / $)" value={newDraft.unit} onChange={e => setNewDraft(p => ({ ...p, unit: e.target.value }))} />
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

  /* ── Google Chat Spaces state (must be above early returns — Rules of Hooks) ── */
  const { allSpaces, isLoading: spacesLoading, missingScope } = useSpaces()
  const [pinnedSpaces, setPinnedSpacesState] = useState<string[] | null>(null)
  const [chatSaveStatus, setChatSaveStatus] = useState<'idle' | 'saved'>('idle')

  useEffect(() => {
    const current = getPinnedSpaces()
    setPinnedSpacesState(current)
  }, [])

  useEffect(() => {
    if (allSpaces.length > 0 && pinnedSpaces === null) {
      setPinnedSpacesState(allSpaces.map(s => s.name))
    }
  }, [allSpaces, pinnedSpaces])

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

  const toggleChatSpace = (spaceName: string) => {
    setChatSaveStatus('idle')
    setPinnedSpacesState(prev => {
      const current = prev ?? allSpaces.map(s => s.name)
      return current.includes(spaceName)
        ? current.filter(n => n !== spaceName)
        : [...current, spaceName]
    })
  }

  const handleSaveChatSpaces = () => {
    if (pinnedSpaces !== null) {
      setPinnedSpaces(pinnedSpaces)
      setChatSaveStatus('saved')
      setTimeout(() => setChatSaveStatus('idle'), 2000)
    }
  }

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



      {/* ── Google Chat Spaces ── */}
      <section className="settings-section" aria-label="Google Chat spaces">
        <h2 className="settings-section-title">
          <span className="rx-comment-label">01.5 //</span> Google Chat Spaces
        </h2>
        <p className="settings-section-desc">Choose which spaces appear in your Chat panel.</p>

        {missingScope ? (
          <div className="settings-scope-warning">
            <span style={{ fontSize: '1.5rem' }}>🔐</span>
            <div>
              <strong>Google Chat not yet authorized.</strong>
              <p style={{ margin: '4px 0 12px 0', fontSize: 'var(--text-xs)', color: 'var(--text-secondary)' }}>To view and send messages to your Google Chat spaces, please grant Chat permissions.</p>
              <button
                className="settings-auth-btn"
                onClick={() => signIn('google', { callbackUrl: '/settings' }, { prompt: 'consent' })}
              >
                Authorize Google Chat
              </button>
            </div>
          </div>
        ) : spacesLoading ? (
          <div className="settings-spaces-loading" role="status">
            {[1,2,3].map(i => <div key={i} className="settings-space-skeleton" />)}
          </div>
        ) : allSpaces.length === 0 ? (
          <p className="settings-empty">No Google Chat spaces found.</p>
        ) : (
          <>
            <div className="settings-spaces-actions">
              <button className="settings-link-btn" onClick={() => { setChatSaveStatus('idle'); setPinnedSpacesState(allSpaces.map(s => s.name)) }}>Show all</button>
              <button className="settings-link-btn" onClick={() => { setChatSaveStatus('idle'); setPinnedSpacesState([]) }}>Hide all</button>
            </div>
            <details
              className="settings-collapsible"
              open={(() => { try { return localStorage.getItem('hub-settings-spaces-open') === 'true' } catch { return false } })()}
              onToggle={(e: React.SyntheticEvent<HTMLDetailsElement>) => {
                try { localStorage.setItem('hub-settings-spaces-open', String((e.target as HTMLDetailsElement).open)) } catch {}
              }}
            >
              <summary className="settings-collapsible__trigger">
                <span className="settings-collapsible__arrow">▶</span>
                {allSpaces.length} spaces · {(pinnedSpaces ?? allSpaces.map(s => s.name)).length} visible
              </summary>
              <div className="settings-spaces-list" role="list">
                {allSpaces.map((space: ChatSpace) => {
                  const isPinned = (pinnedSpaces ?? allSpaces.map(s => s.name)).includes(space.name)
                  const label = space.displayName || space.name.split('/')[1]
                  const isDM = space.type === 'DM'
                  return (
                    <label key={space.name} className="settings-space-row">
                      <div className="settings-space-row__info">
                        <span className="settings-space-row__icon" aria-hidden="true">{isDM ? '👤' : '#'}</span>
                        <span className="settings-space-row__name">{label}</span>
                      </div>
                      <div
                        role="switch"
                        aria-checked={isPinned}
                        tabIndex={0}
                        className={`settings-toggle ${isPinned ? 'settings-toggle--on' : ''}`}
                        onClick={() => toggleChatSpace(space.name)}
                        onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleChatSpace(space.name) } }}
                        aria-label={`${isPinned ? 'Hide' : 'Show'} ${label}`}
                      >
                        <span className="settings-toggle__thumb" />
                      </div>
                    </label>
                  )
                })}
              </div>
            </details>
            <div className="settings-save-row">
              <button
                id="settings-save-chat-btn"
                className="settings-save-btn"
                onClick={handleSaveChatSpaces}
                disabled={chatSaveStatus === 'saved'}
              >
                {chatSaveStatus === 'saved' ? '✓ Saved' : 'Save Chat Preferences'}
              </button>
            </div>
          </>
        )}
      </section>

      {/* ── Onboarding Users (admin + superadmin only) ── */}
      {isAdmin && (
        <OnboardingUsersCard callerRole={userRole ?? 'admin'} />
      )}

    </div>
  )
}

