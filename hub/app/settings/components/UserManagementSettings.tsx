'use client'

import React, { useState, useEffect, useCallback } from 'react'
import Link from 'next/link'
import { useCompanies } from '@/app/hooks/useCompanies'
import type { Company } from '@/types'

/* ── Types ── */

export interface OnboardingUser {
  email: string
  role: string
  assignedProjects: string[]
  assignedAt: string
  assignedBy: string
}

export interface OnboardingUserRowState extends OnboardingUser {
  pendingRole: string
  pendingProjects: string[]   // projects selected before promote
  saving: boolean
  error: string | null
}

export const ONBOARDING_ROLE_LABELS: Record<string, string> = {
  staff: 'Staff',
  admin: 'Admin',
}

/* ── UserManagementSettings Component ── */

export function UserManagementSettings({ callerRole }: { callerRole: string }) {
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
