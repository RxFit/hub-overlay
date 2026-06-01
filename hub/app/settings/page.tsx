'use client'

import { useState, useEffect, useCallback } from 'react'
import { useSession, signOut, signIn } from 'next-auth/react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { useSpaces, setPinnedSpaces, getPinnedSpaces } from '@/app/hooks/useGoogleChat'
import type { ChatSpace } from '@/app/hooks/useGoogleChat'
import { InfoPopover } from '@/app/components/InfoPopover'

/* ── Types ── */

interface KPIRowConfig {
  label: string
  value: string
  trend: string
  direction: 'up' | 'down'
  visible: boolean
  order: number
}

interface KPISettings {
  sheetId: string
  tabName: string
  cellRange: string
  rows: KPIRowConfig[]
}

const DEFAULT_SETTINGS: KPISettings = {
  sheetId: process.env.NEXT_PUBLIC_KPI_SHEET_ID || '',
  tabName: 'KPIs',
  cellRange: 'A2:D10',
  rows: [],
}

const STORAGE_KEY = 'hub-kpi-settings'

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
   SETTINGS PAGE
   ══════════════════════════════════════════════════════════════════════════════ */

export default function SettingsPage() {
  const { data: session, status } = useSession()
  const router = useRouter()

  const [settings, setSettings] = useState<KPISettings>(DEFAULT_SETTINGS)
  const [testStatus, setTestStatus] = useState<'idle' | 'loading' | 'success' | 'error'>('idle')
  const [testData, setTestData] = useState<string[][] | null>(null)
  const [testError, setTestError] = useState<string | null>(null)
  const [saveStatus, setSaveStatus] = useState<'idle' | 'saved'>('idle')
  const [dragIndex, setDragIndex] = useState<number | null>(null)
  const [dragOverIndex, setDragOverIndex] = useState<number | null>(null)

  // Redirect unauthenticated users
  useEffect(() => {
    if (status === 'unauthenticated') {
      router.push('/login')
    }
  }, [status, router])

  // Load saved settings from localStorage
  useEffect(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEY)
      if (saved) {
        const parsed = JSON.parse(saved) as KPISettings
        setSettings({
          ...DEFAULT_SETTINGS,
          ...parsed,
          sheetId: parsed.sheetId || DEFAULT_SETTINGS.sheetId,
        })
      }
    } catch {
      // ignore
    }
  }, [])

  /* ── Test Connection ── */
  const handleTestConnection = useCallback(async () => {
    setTestStatus('loading')
    setTestData(null)
    setTestError(null)

    const range = `${settings.tabName}!${settings.cellRange}`
    try {
      const res = await fetch(
        `/api/google/sheets?spreadsheetId=${encodeURIComponent(settings.sheetId)}&range=${encodeURIComponent(range)}`
      )
      if (!res.ok) {
        const body = await res.json().catch(() => ({ error: `HTTP ${res.status}` }))
        throw new Error(body.error || `HTTP ${res.status}`)
      }
      const data = await res.json()
      const values: string[][] = data.values || []
      setTestData(values)

      // Auto-populate KPI rows from sheet data
      if (values.length > 0) {
        const rows: KPIRowConfig[] = values.map((row, i) => ({
          label: row[0] || `KPI ${i + 1}`,
          value: row[1] || '—',
          trend: row[2] || '—',
          direction: (row[3]?.toLowerCase() === 'down' ? 'down' : 'up') as 'up' | 'down',
          visible: true,
          order: i,
        }))
        setSettings(prev => ({ ...prev, rows }))
      }

      setTestStatus('success')
    } catch (err) {
      setTestError(err instanceof Error ? err.message : 'Connection failed')
      setTestStatus('error')
    }
  }, [settings.sheetId, settings.tabName, settings.cellRange])

  /* ── Row operations ── */
  const toggleRowVisibility = useCallback((index: number) => {
    setSettings(prev => ({
      ...prev,
      rows: prev.rows.map((r, i) =>
        i === index ? { ...r, visible: !r.visible } : r
      ),
    }))
  }, [])

  const moveRow = useCallback((index: number, direction: 'up' | 'down') => {
    setSettings(prev => {
      const rows = [...prev.rows]
      const targetIndex = direction === 'up' ? index - 1 : index + 1
      if (targetIndex < 0 || targetIndex >= rows.length) return prev
      ;[rows[index], rows[targetIndex]] = [rows[targetIndex], rows[index]]
      // Update order fields
      rows.forEach((r, i) => { r.order = i })
      return { ...prev, rows }
    })
  }, [])

  const addRow = useCallback(() => {
    setSettings(prev => ({
      ...prev,
      rows: [
        ...prev.rows,
        {
          label: `KPI ${prev.rows.length + 1}`,
          value: '—',
          trend: '—',
          direction: 'up' as const,
          visible: true,
          order: prev.rows.length,
        },
      ],
    }))
  }, [])

  const updateRowField = useCallback(
    (index: number, field: keyof KPIRowConfig, value: string | boolean) => {
      setSettings(prev => ({
        ...prev,
        rows: prev.rows.map((r, i) =>
          i === index ? { ...r, [field]: value } : r
        ),
      }))
    },
    []
  )

  const removeRow = useCallback((index: number) => {
    setSettings(prev => ({
      ...prev,
      rows: prev.rows.filter((_, i) => i !== index).map((r, i) => ({ ...r, order: i })),
    }))
  }, [])

  /* ── E6: Drag-to-reorder ── */
  const handleDragStart = useCallback((index: number) => {
    setDragIndex(index)
  }, [])

  const handleDragOver = useCallback((e: React.DragEvent, index: number) => {
    e.preventDefault()
    setDragOverIndex(index)
  }, [])

  const handleDrop = useCallback((index: number) => {
    if (dragIndex === null || dragIndex === index) {
      setDragIndex(null)
      setDragOverIndex(null)
      return
    }
    setSettings(prev => {
      const rows = [...prev.rows]
      const [dragged] = rows.splice(dragIndex, 1)
      rows.splice(index, 0, dragged)
      rows.forEach((r, i) => { r.order = i })
      return { ...prev, rows }
    })
    setDragIndex(null)
    setDragOverIndex(null)
  }, [dragIndex])

  const handleDragEnd = useCallback(() => {
    setDragIndex(null)
    setDragOverIndex(null)
  }, [])

  /* ── Save ── */
  const handleSave = useCallback(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(settings))
      setSaveStatus('saved')
      setTimeout(() => setSaveStatus('idle'), 2000)
    } catch {
      // ignore
    }
  }, [settings])

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

  const visibleRows = settings.rows.filter(r => r.visible)

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

      {/* ── Business KPIs (Google Sheet) ── */}
      <section className="settings-section">
        <h2 className="settings-section-title">
          <span className="rx-comment-label">01 //</span> Business KPIs (Google Sheet)
        </h2>
        <p className="settings-section-desc">
          Operational KPIs are automatically derived from Paperclip. Use this section for revenue and custom business metrics only.
        </p>

        <div className="settings-input-group">
          <label className="settings-label" htmlFor="sheet-id">
            Sheet ID
            <InfoPopover
              content={
                <>
                  <p>The unique identifier of your Google Sheet.</p>
                  <p>You can find this in your spreadsheet URL:</p>
                  <code>https://docs.google.com/spreadsheets/d/<b>[SHEET_ID]</b>/edit</code>
                </>
              }
            />
          </label>
          <span className="rx-comment-label" style={{ fontSize: '10px', marginBottom: '8px', display: 'block' }}>// Extract ID from the URL of your Google Sheet</span>
          <input
            id="sheet-id"
            type="text"
            className="settings-input settings-input--mono"
            value={settings.sheetId}
            onChange={e => setSettings(prev => ({ ...prev, sheetId: e.target.value }))}
            placeholder="1BxiM..."
          />
        </div>

        <div className="settings-input-row">
          <div className="settings-input-group">
            <label className="settings-label" htmlFor="tab-name">
              Tab Name
              <InfoPopover
                content={
                  <>
                    <p>The name of the sheet tab containing your data.</p>
                    <p>Examples: <code>KPIs</code>, <code>Sheet1</code>, or <code>Metrics</code>.</p>
                    <p>Make sure this matches the tab name exactly (case-sensitive).</p>
                  </>
                }
              />
            </label>
            <span className="rx-comment-label" style={{ fontSize: '10px', marginBottom: '8px', display: 'block' }}>// Tab/sheet name (case-sensitive)</span>
            <input
              id="tab-name"
              type="text"
              className="settings-input settings-input--mono"
              value={settings.tabName}
              onChange={e => setSettings(prev => ({ ...prev, tabName: e.target.value }))}
              placeholder="KPIs"
            />
          </div>
          <div className="settings-input-group">
            <label className="settings-label" htmlFor="cell-range">
              Cell Range
              <InfoPopover
                content={
                  <>
                    <p>The cell bounds enclosing your KPI rows.</p>
                    <p>Expects a 4-column table format:</p>
                    <code>Label | Value | Trend | Direction</code>
                    <p>Example: <code>A2:D10</code></p>
                  </>
                }
              />
            </label>
            <span className="rx-comment-label" style={{ fontSize: '10px', marginBottom: '8px', display: 'block' }}>// Table boundaries (e.g. A2:D10)</span>
            <input
              id="cell-range"
              type="text"
              className="settings-input settings-input--mono"
              value={settings.cellRange}
              onChange={e => setSettings(prev => ({ ...prev, cellRange: e.target.value }))}
              placeholder="A2:D10"
            />
          </div>
        </div>

        <button
          className="settings-test-btn"
          onClick={handleTestConnection}
          disabled={testStatus === 'loading' || !settings.sheetId}
        >
          {testStatus === 'loading' ? '⏳ Testing...' : '🔗 Test Connection'}
        </button>

        {/* Test result */}
        {testStatus === 'success' && testData && (
          <div className="settings-test-result settings-test-result--success">
            <div className="settings-test-result-header">
              ✅ Connected — {testData.length} row{testData.length !== 1 ? 's' : ''} found
            </div>
            <div className="settings-test-preview-table">
              {testData.slice(0, 5).map((row, i) => (
                <div key={i} className="settings-test-preview-row">
                  {row.map((cell, j) => (
                    <span key={j} className="settings-test-preview-cell">{cell}</span>
                  ))}
                </div>
              ))}
              {testData.length > 5 && (
                <div className="settings-test-preview-more">
                  +{testData.length - 5} more rows
                </div>
              )}
            </div>
          </div>
        )}
        {testStatus === 'error' && (
          <div className="settings-test-result settings-test-result--error">
            ❌ {testError}
          </div>
        )}
      </section>

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

      {/* ── KPI Row Editor ── */}
      <section className="settings-section">
        <h2 className="settings-section-title">
          <span className="rx-comment-label">02 //</span> KPI Row Editor
        </h2>

        {settings.rows.length === 0 ? (
          <div className="settings-empty">
            No KPI rows configured. Use &ldquo;Test Connection&rdquo; to pull from your Sheet, or add rows manually.
          </div>
        ) : (
          <div className="settings-table" role="list">
            {settings.rows.map((row, index) => (
              <div
                key={`${row.label}-${index}`}
                className={`settings-table-row ${dragOverIndex === index ? 'settings-table-row--drag-over' : ''}`}
                role="listitem"
                draggable
                onDragStart={() => handleDragStart(index)}
                onDragOver={(e) => handleDragOver(e, index)}
                onDrop={() => handleDrop(index)}
                onDragEnd={handleDragEnd}
                style={{
                  opacity: dragIndex === index ? 0.4 : 1,
                  cursor: 'grab',
                }}>
                {/* Drag handle */}
                <span className="settings-row-drag-handle" aria-hidden="true">⠿</span>
                {/* Toggle */}
                <button
                  className={`settings-toggle ${row.visible ? 'settings-toggle--on' : ''}`}
                  onClick={() => toggleRowVisibility(index)}
                  aria-label={`${row.visible ? 'Hide' : 'Show'} ${row.label}`}
                  title={row.visible ? 'Visible' : 'Hidden'}
                >
                  <span className="settings-toggle-knob" />
                </button>

                {/* Fields */}
                <div className="settings-row-fields">
                  <input
                    className="settings-row-input"
                    value={row.label}
                    onChange={e => updateRowField(index, 'label', e.target.value)}
                    placeholder="Label"
                    aria-label="KPI Label"
                  />
                  <input
                    className="settings-row-input settings-row-input--narrow"
                    value={row.value}
                    onChange={e => updateRowField(index, 'value', e.target.value)}
                    placeholder="Value"
                    aria-label="KPI Value"
                  />
                  <input
                    className="settings-row-input settings-row-input--narrow"
                    value={row.trend}
                    onChange={e => updateRowField(index, 'trend', e.target.value)}
                    placeholder="Trend"
                    aria-label="KPI Trend"
                  />
                  <select
                    className="settings-row-select"
                    value={row.direction}
                    onChange={e => updateRowField(index, 'direction', e.target.value)}
                    aria-label="Trend Direction"
                  >
                    <option value="up">↑ Up</option>
                    <option value="down">↓ Down</option>
                  </select>
                </div>

                {/* Reorder + remove */}
                <div className="settings-row-actions">
                  <button
                    className="settings-row-action-btn"
                    onClick={() => moveRow(index, 'up')}
                    disabled={index === 0}
                    aria-label="Move up"
                    title="Move up"
                  >
                    ▲
                  </button>
                  <button
                    className="settings-row-action-btn"
                    onClick={() => moveRow(index, 'down')}
                    disabled={index === settings.rows.length - 1}
                    aria-label="Move down"
                    title="Move down"
                  >
                    ▼
                  </button>
                  <button
                    className="settings-row-action-btn settings-row-action-btn--danger"
                    onClick={() => removeRow(index)}
                    aria-label={`Remove ${row.label}`}
                    title="Remove"
                  >
                    ✕
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}

        <button className="settings-add-btn" onClick={addRow}>
          + Add Row
        </button>
      </section>

      {/* ── Onboarding Users (admin + superadmin only) ── */}
      {isAdmin && (
        <OnboardingUsersCard callerRole={userRole ?? 'admin'} />
      )}

      {/* ── Preview ── */}
      {visibleRows.length > 0 && (
        <section className="settings-section">
          <h2 className="settings-section-title">
            <span className="rx-comment-label">04 //</span> Preview
          </h2>

          <div className="settings-preview">
            <div className="kpi-grid" role="list" aria-label="KPI preview">
              {visibleRows.map((kpi) => (
                <div
                  key={`preview-${kpi.label}-${kpi.order}`}
                  className="kpi-card"
                  role="listitem"
                >
                  <div className="kpi-label">{kpi.label}</div>
                  <div className="kpi-value">{kpi.value}</div>
                  <div className={`kpi-trend ${kpi.direction === 'up' ? 'kpi-trend-up' : 'kpi-trend-down'}`}>
                    <span aria-hidden="true" className="rx-star">✦</span> {kpi.trend}
                  </div>
                </div>
              ))}
            </div>
          </div>
        </section>
      )}

      {/* ── Save ── */}
      <div className="settings-footer">
        <button
          className="settings-save-btn"
          onClick={handleSave}
          disabled={saveStatus === 'saved'}
        >
          {saveStatus === 'saved' ? '✓ Saved' : 'Save Settings'}
        </button>
      </div>
    </div>
  )
}
