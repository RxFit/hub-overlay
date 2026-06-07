'use client'

import React, { useState, useEffect, useCallback } from 'react'
import { useCompanies } from '@/app/hooks/useCompanies'
import type { Company } from '@/types'

/* ── Types ── */

export const TEAM_ROLE_LABELS: Record<string, string> = {
  superadmin: 'Super Admin',
  admin: 'Admin',
  staff: 'Staff',
}

export interface TeamMember {
  email: string
  name?: string
  role: string
  assignedProjects: string[]
}

/* ── ProfileSettings Component ── */

export function ProfileSettings({ callerRole }: { callerRole: string }) {
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
