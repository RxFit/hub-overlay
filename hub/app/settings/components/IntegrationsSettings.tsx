'use client'

import React, { useState, useEffect, useCallback } from 'react'
import { useCompanies } from '@/app/hooks/useCompanies'

/* ── Types ── */

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

/* ── IntegrationsSettings Component ── */

export function IntegrationsSettings() {
  const { companies } = useCompanies()
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
