'use client'

import { useState, useEffect, useCallback } from 'react'

interface VertexStatus {
  tenant: { id: string; name: string }
  vertex: {
    engineId: string | null
    gcpProject: string | null
    workspaceDomain: string | null
    status: string
    health: 'healthy' | 'degraded' | 'unavailable'
    healthDetails: string
  }
}

interface TestResult {
  success: boolean
  query?: string
  resultCount?: number
  durationMs?: number
  error?: string
  results?: Array<{
    title: string
    snippet: string
    uri?: string
  }>
}

const STATUS_COLORS: Record<string, string> = {
  active: '#22c55e',
  pending: '#eab308',
  error: '#ef4444',
  disabled: '#6b7280',
}

const HEALTH_COLORS: Record<string, string> = {
  healthy: '#22c55e',
  degraded: '#eab308',
  unavailable: '#ef4444',
}

export default function VertexStatusCard() {
  const [status, setStatus] = useState<VertexStatus | null>(null)
  const [loading, setLoading] = useState(true)
  const [testQuery, setTestQuery] = useState('')
  const [testResult, setTestResult] = useState<TestResult | null>(null)
  const [testing, setTesting] = useState(false)

  const fetchStatus = useCallback(async () => {
    try {
      const res = await fetch('/api/admin/vertex-status')
      if (res.ok) {
        setStatus(await res.json())
      }
    } catch {
      // Silent fail
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    fetchStatus()
  }, [fetchStatus])

  const runTestSearch = async () => {
    if (!testQuery.trim()) return
    setTesting(true)
    setTestResult(null)

    try {
      const res = await fetch('/api/admin/vertex-test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: testQuery.trim() }),
      })
      setTestResult(await res.json())
    } catch (err) {
      setTestResult({ success: false, error: String(err) })
    } finally {
      setTesting(false)
    }
  }

  if (loading) {
    return (
      <div style={{ padding: '1.5rem', color: '#9ca3af', fontStyle: 'italic' }}>
        Loading Vertex AI status...
      </div>
    )
  }

  if (!status) {
    return (
      <div style={{ padding: '1.5rem', color: '#ef4444' }}>
        Failed to load Vertex AI status
      </div>
    )
  }

  const v = status.vertex

  return (
    <div style={{ padding: '0 1.5rem 1.5rem' }}>
      {/* Config Grid */}
      <div style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))',
        gap: '1rem',
        marginBottom: '1.5rem',
      }}>
        <ConfigItem label="Engine ID" value={v.engineId ?? 'Not configured'} />
        <ConfigItem label="GCP Project" value={v.gcpProject ?? 'Not configured'} />
        <ConfigItem label="Workspace Domain" value={v.workspaceDomain ?? 'Not configured'} />
        <ConfigItem
          label="Status"
          value={v.status.toUpperCase()}
          color={STATUS_COLORS[v.status] ?? '#6b7280'}
        />
        <ConfigItem
          label="Health"
          value={v.health.toUpperCase()}
          color={HEALTH_COLORS[v.health] ?? '#6b7280'}
        />
      </div>

      {v.healthDetails && (
        <div style={{
          padding: '0.75rem 1rem',
          background: 'rgba(255,255,255,0.03)',
          borderRadius: '8px',
          border: '1px solid rgba(255,255,255,0.06)',
          fontSize: '0.8rem',
          color: '#9ca3af',
          marginBottom: '1.5rem',
        }}>
          {v.healthDetails}
        </div>
      )}

      {/* Test Search */}
      <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', marginBottom: '1rem' }}>
        <input
          type="text"
          placeholder="Test search query..."
          value={testQuery}
          onChange={e => setTestQuery(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && runTestSearch()}
          style={{
            flex: 1,
            padding: '0.5rem 0.75rem',
            borderRadius: '6px',
            border: '1px solid rgba(255,255,255,0.1)',
            background: 'rgba(255,255,255,0.05)',
            color: '#e5e7eb',
            fontSize: '0.85rem',
          }}
        />
        <button
          onClick={runTestSearch}
          disabled={testing || !testQuery.trim()}
          style={{
            padding: '0.5rem 1rem',
            borderRadius: '6px',
            background: testing ? '#374151' : '#C5A059',
            color: '#fff',
            border: 'none',
            cursor: testing ? 'wait' : 'pointer',
            fontSize: '0.85rem',
            fontWeight: 600,
            opacity: !testQuery.trim() ? 0.5 : 1,
          }}
        >
          {testing ? 'Searching...' : 'Test Search'}
        </button>
      </div>

      {/* Test Results */}
      {testResult && (
        <div style={{
          padding: '1rem',
          borderRadius: '8px',
          background: testResult.success ? 'rgba(34,197,94,0.05)' : 'rgba(239,68,68,0.05)',
          border: `1px solid ${testResult.success ? 'rgba(34,197,94,0.15)' : 'rgba(239,68,68,0.15)'}`,
        }}>
          {testResult.success ? (
            <>
              <div style={{ fontSize: '0.8rem', color: '#9ca3af', marginBottom: '0.5rem' }}>
                {testResult.resultCount} results in {testResult.durationMs}ms
              </div>
              {testResult.results?.map((r, i) => (
                <div key={i} style={{
                  padding: '0.75rem',
                  borderBottom: i < (testResult.results?.length ?? 0) - 1 ? '1px solid rgba(255,255,255,0.05)' : 'none',
                }}>
                  <div style={{ fontWeight: 600, color: '#e5e7eb', fontSize: '0.85rem' }}>{r.title}</div>
                  {r.uri && (
                    <div style={{ fontSize: '0.75rem', color: '#C5A059', marginTop: '2px' }}>{r.uri}</div>
                  )}
                  <div style={{ fontSize: '0.8rem', color: '#9ca3af', marginTop: '4px', lineHeight: 1.5 }}>
                    {r.snippet}
                  </div>
                </div>
              ))}
            </>
          ) : (
            <div style={{ color: '#ef4444', fontSize: '0.85rem' }}>
              ❌ {testResult.error}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function ConfigItem({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <div>
      <div style={{ fontSize: '0.7rem', textTransform: 'uppercase', color: '#6b7280', letterSpacing: '0.05em', marginBottom: '4px' }}>
        {label}
      </div>
      <div style={{ fontSize: '0.85rem', color: color ?? '#e5e7eb', fontWeight: color ? 600 : 400, fontFamily: 'monospace' }}>
        {value}
      </div>
    </div>
  )
}
