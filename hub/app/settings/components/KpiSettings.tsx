'use client'

import React, { useState, useEffect, useCallback, useRef } from 'react'
import { swallow } from '@/lib/swallow'

/* ── Types ── */

export interface DbKPI {
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

export interface KpiDraft {
  label: string
  value: string
  trend: string
  trendDirection: 'up' | 'down' | 'neutral'
  unit: string
  visibility: 'public' | 'staff' | 'admin'
}

export const BLANK_DRAFT: KpiDraft = {
  label: '',
  value: '',
  trend: '',
  trendDirection: 'neutral',
  unit: '',
  visibility: 'staff',
}

export const SOURCE_BADGES: Record<string, { label: string; color: string; bg: string }> = {
  ga4:       { label: 'GA4',    color: '#e37400', bg: 'rgba(227,116,0,0.12)' },
  stripe:    { label: 'Stripe', color: '#635bff', bg: 'rgba(99,91,255,0.12)' },
  gsc:       { label: 'GSC',    color: '#34a853', bg: 'rgba(52,168,83,0.12)' },
  paperclip: { label: '\u2746 PC',   color: 'var(--accent)', bg: 'rgba(0,200,100,0.12)' },
  manual:    { label: 'Manual', color: 'var(--text-muted)', bg: 'rgba(255,255,255,0.05)' },
}

export function SourceBadge({ source }: { source: string | null }) {
  const cfg = SOURCE_BADGES[source ?? 'manual'] ?? SOURCE_BADGES.manual
  return (
    <span style={{ fontSize: '0.6rem', fontWeight: 700, fontFamily: 'var(--font-mono)', textTransform: 'uppercase', letterSpacing: '0.08em', padding: '2px 6px', borderRadius: '4px', color: cfg.color, background: cfg.bg, flexShrink: 0 }}>
      {cfg.label}
    </span>
  )
}

export function relativeTime(iso: string | null): string {
  if (!iso) return 'never'
  const diff = Date.now() - new Date(iso).getTime()
  const mins = Math.floor(diff / 60_000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  return `${Math.floor(hrs / 24)}d ago`
}

export interface SyncStatus {
  syncing: boolean
  result: null | { synced: number; sources: Record<string, { ok: boolean; count: number; error?: string }>; syncedAt: string }
  error: string | null
}

/* ── KpiSettings Component ── */

export function KpiSettings({ isAdmin }: { isAdmin: boolean }) {
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
      const d = await res.json().catch((err: unknown) => { swallow(err, { module: 'KpiSettings', op: 'parseDeleteResponseBody' }); return ({}) })
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
