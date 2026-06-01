'use client'

import { useState, useEffect, useCallback } from 'react'
import { useSession, signOut } from 'next-auth/react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { useSpaces, setPinnedSpaces, getPinnedSpaces } from '@/app/hooks/useGoogleChat'
import type { ChatSpace } from '@/app/hooks/useGoogleChat'

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
  const isAdmin = userRole === 'admin'

  const visibleRows = settings.rows.filter(r => r.visible)

  /* ── Google Chat Spaces state ── */
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

      {/* ── Google Sheet Source ── */}
      <section className="settings-section">
        <h2 className="settings-section-title">
          <span className="rx-comment-label">01 //</span> Google Sheet Source
        </h2>

        <div className="settings-input-group">
          <label className="settings-label" htmlFor="sheet-id">Sheet ID</label>
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
            <label className="settings-label" htmlFor="tab-name">Tab Name</label>
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
            <label className="settings-label" htmlFor="cell-range">Cell Range</label>
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
            <span>🔐</span>
            <div>
              <strong>Google Chat not yet authorized.</strong>
              <p>Sign out and back in to grant Chat access permissions.</p>
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

      {/* ── Preview ── */}
      {visibleRows.length > 0 && (
        <section className="settings-section">
          <h2 className="settings-section-title">
            <span className="rx-comment-label">03 //</span> Preview
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
