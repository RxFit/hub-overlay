'use client'

import { useEffect, useState } from 'react'
import { useSession } from 'next-auth/react'
import { useRouter } from 'next/navigation'
import { useQuery } from '@tanstack/react-query'
import { getTenantConfig } from '@/lib/tenant'
import type { AiHealth, ProviderConfig } from '@/lib/ai-health'
import { swallow } from '@/lib/swallow'
import './ai-health.css'

const tenant = getTenantConfig()

/** Whitelisted query windows — mirrors the API route's WINDOW_MS keys. */
const WINDOWS = ['1h', '24h', '7d'] as const
type Window = (typeof WINDOWS)[number]

interface AiHealthResponse extends AiHealth {
  window: string
  generatedAt: string
  /** Optional so a page deployed ahead of the API degrades gracefully. */
  providerConfig?: ProviderConfig
}

/** One provider-key presence badge: configured ✓ / missing ✗ (critical). */
function ProviderBadge({ name, configured }: { name: string; configured: boolean }) {
  return (
    <span className={`aih-provider-badge ${configured ? 'aih-provider-badge--ok' : 'aih-provider-badge--missing'}`}>
      {name}: {configured ? '✓ configured' : '✗ key missing'}
    </span>
  )
}

async function fetchAiHealth(window: Window): Promise<AiHealthResponse> {
  const res = await fetch(`/api/admin/ai-health?window=${window}`)
  if (!res.ok) {
    // A non-JSON error body (HTML 502 page, empty body) must not mask the
    // real HTTP status — fall back to {} so the status-based message is thrown.
    const data = await res
      .json()
      .catch((err: unknown) => {
        swallow(err, { module: 'admin/ai-health', op: 'parseErrorBody' })
        return {}
      })
    throw new Error(data.error || `API error ${res.status}`)
  }
  return res.json()
}

function pct(rate: number | null): string {
  return rate === null ? '—' : `${(rate * 100).toFixed(1)}%`
}

function ms(v: number | null): string {
  return v === null ? '—' : `${Math.round(v).toLocaleString()} ms`
}

export default function AiHealthPage() {
  const { data: session, status } = useSession()
  const router = useRouter()
  const role = (session?.user as Record<string, unknown>)?.role as string
  const isAdmin = role === 'admin' || role === 'superadmin'

  const [timeWindow, setTimeWindow] = useState<Window>('24h')

  // Client-side access restriction (middleware already blocks the page; this
  // covers stale sessions — and the API refuses non-admins regardless).
  useEffect(() => {
    if (status === 'authenticated' && !isAdmin) {
      router.replace('/')
    }
  }, [status, isAdmin, router])

  const { data, error, isLoading, refetch } = useQuery<AiHealthResponse>({
    queryKey: ['admin', 'ai-health', timeWindow],
    queryFn: () => fetchAiHealth(timeWindow),
    refetchInterval: 60_000,
    enabled: status === 'authenticated' && isAdmin,
  })

  if (status === 'loading' || (isLoading && !data)) {
    return (
      <div className="admin-shell">
        <div className="admin-loading">
          <div className="admin-loading__spinner" />
          <span>Loading AI health…</span>
        </div>
      </div>
    )
  }

  const successRateClass =
    data?.successRate === null || data === undefined
      ? ''
      : data.successRate < 0.9
        ? 'aih-tile__value--bad'
        : 'aih-tile__value--good'
  const fallbackRateClass =
    data?.fallbackRate === null || data === undefined
      ? ''
      : data.fallbackRate > 0.5
        ? 'aih-tile__value--bad'
        : data.fallbackRate > 0.25
          ? 'aih-tile__value--warn'
          : ''

  return (
    <div className="admin-shell">
      {/* Header */}
      <header className="admin-header">
        <div className="admin-header__left">
          <button className="admin-back-btn" onClick={() => router.push('/admin')} aria-label="Back to Admin">
            ← Admin
          </button>
          <div className="admin-header__title">
            <span className="admin-header__accent">{tenant.logoText}</span>
            {' '}AI Health
          </div>
        </div>
        <div className="admin-header__right">
          <span className="admin-role-badge" style={{ color: '#C5A059' }}>
            {role === 'superadmin' ? 'Super Admin' : 'Admin'}
          </span>
          <span className="admin-header__email">{session?.user?.email}</span>
        </div>
      </header>

      <main className="admin-main">
        {error && (
          <div className="admin-error" role="alert" style={{ marginBottom: 'var(--space-4)' }}>
            <span>⚠️ {error instanceof Error ? error.message : 'Failed to load AI health'}</span>
            <button onClick={() => refetch()} className="admin-retry-btn">Retry</button>
          </div>
        )}

        {/* Window selector */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 'var(--space-3)', marginBottom: 'var(--space-4)' }}>
          <div className="aih-window-switch" role="group" aria-label="Aggregation window">
            {WINDOWS.map((w) => (
              <button
                key={w}
                className={`aih-window-btn ${timeWindow === w ? 'aih-window-btn--active' : ''}`}
                onClick={() => setTimeWindow(w)}
                aria-pressed={timeWindow === w}
              >
                {w}
              </button>
            ))}
          </div>
          {data && (
            <span style={{ fontSize: '0.7rem', color: 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}>
              Updated {new Date(data.generatedAt).toLocaleTimeString()} · auto-refresh 60s
            </span>
          )}
        </div>

        {data && (
          <>
            {/* Provider configuration — API-key PRESENCE on the runtime env
                (booleans only). A missing key here is the root cause of the
                chat "provider configuration" error bubble; see
                docs/runbooks/ai-provider-outage.md. */}
            {data.providerConfig && (
              <div className="aih-providers" role="status" aria-label="Provider configuration">
                <span className="aih-providers__label">Provider configuration</span>
                <ProviderBadge name="Gemini" configured={data.providerConfig.gemini} />
                <ProviderBadge name="Claude" configured={data.providerConfig.anthropic} />
              </div>
            )}

            {/* Alerts banner */}
            {data.alerts.length > 0 ? (
              <div className="aih-alerts" role="alert">
                {data.alerts.map((a) => (
                  <div key={a.id} className={`aih-alert aih-alert--${a.severity}`}>
                    <span className="aih-alert__badge">{a.severity}</span>
                    <span>{a.message}</span>
                  </div>
                ))}
              </div>
            ) : (
              <div className="aih-ok">✓ No active alerts in the last {timeWindow}</div>
            )}

            {/* Stat tiles */}
            <div className="aih-tiles">
              <div className="aih-tile">
                <span className="aih-tile__label">Requests</span>
                <span className="aih-tile__value">{data.requests}</span>
                <span className="aih-tile__sub">ai_complete + ai_error</span>
              </div>
              <div className="aih-tile">
                <span className="aih-tile__label">Success rate</span>
                <span className={`aih-tile__value ${successRateClass}`}>{pct(data.successRate)}</span>
                <span className="aih-tile__sub">critical below 90%</span>
              </div>
              <div className="aih-tile">
                <span className="aih-tile__label">Latency p50</span>
                <span className="aih-tile__value">{ms(data.latencyMs.p50)}</span>
                <span className="aih-tile__sub">from ai_complete</span>
              </div>
              <div className="aih-tile">
                <span className="aih-tile__label">Latency p95</span>
                <span className="aih-tile__value">{ms(data.latencyMs.p95)}</span>
                <span className="aih-tile__sub">nearest-rank</span>
              </div>
              <div className="aih-tile">
                <span className="aih-tile__label">Fallback rate</span>
                <span className={`aih-tile__value ${fallbackRateClass}`}>{pct(data.fallbackRate)}</span>
                <span className="aih-tile__sub">{data.fallbacks} fallback{data.fallbacks === 1 ? '' : 's'}</span>
              </div>
              <div className="aih-tile">
                <span className="aih-tile__label">Timeouts</span>
                <span className={`aih-tile__value ${data.timeouts > 0 ? 'aih-tile__value--warn' : ''}`}>{data.timeouts}</span>
                <span className="aih-tile__sub">warn at 5/h</span>
              </div>
              <div className="aih-tile">
                <span className="aih-tile__label">Rate-limited</span>
                <span className={`aih-tile__value ${data.rateLimited > 0 ? 'aih-tile__value--warn' : ''}`}>{data.rateLimited}</span>
                <span className="aih-tile__sub">warn above 10/h</span>
              </div>
              <div className="aih-tile">
                <span className="aih-tile__label">AI actions</span>
                <span className="aih-tile__value">{data.actions.total}</span>
                <span className="aih-tile__sub">
                  {data.actions.byStatus.success ?? 0} ok · {data.actions.byStatus.failed ?? 0} failed
                </span>
              </div>
            </div>

            {/* Breakdowns */}
            <div className="aih-grid-2">
              <div className="aih-panel">
                <h2>Errors by code</h2>
                {Object.keys(data.errorsByCode).length === 0 ? (
                  <div className="aih-empty">No AI errors in this window.</div>
                ) : (
                  <div className="aih-kv">
                    {Object.entries(data.errorsByCode)
                      .sort(([, a], [, b]) => b - a)
                      .map(([code, count]) => (
                        <div key={code} className="aih-kv__row">
                          <span className="aih-kv__key">{code}</span>
                          <span className="aih-kv__val">{count}</span>
                        </div>
                      ))}
                  </div>
                )}
              </div>
              <div className="aih-panel">
                <h2>Timeouts by layer</h2>
                {Object.keys(data.timeoutsByLayer).length === 0 ? (
                  <div className="aih-empty">No timeouts in this window.</div>
                ) : (
                  <div className="aih-kv">
                    {Object.entries(data.timeoutsByLayer)
                      .sort(([, a], [, b]) => b - a)
                      .map(([layer, count]) => (
                        <div key={layer} className="aih-kv__row">
                          <span className="aih-kv__key">{layer}</span>
                          <span className="aih-kv__val">{count}</span>
                        </div>
                      ))}
                  </div>
                )}
              </div>
              <div className="aih-panel">
                <h2>Actions by type</h2>
                {Object.keys(data.actions.byType).length === 0 ? (
                  <div className="aih-empty">No AI actions in this window.</div>
                ) : (
                  <div className="aih-kv">
                    {Object.entries(data.actions.byType)
                      .sort(([, a], [, b]) => b - a)
                      .map(([type, count]) => (
                        <div key={type} className="aih-kv__row">
                          <span className="aih-kv__key">{type}</span>
                          <span className="aih-kv__val">{count}</span>
                        </div>
                      ))}
                  </div>
                )}
              </div>
            </div>

            {/* Recent failures */}
            <div className="aih-panel">
              <h2>Recent failures (last 10)</h2>
              {data.recentFailures.length === 0 ? (
                <div className="aih-empty">No failures in this window. 🎉</div>
              ) : (
                <div className="aih-failures">
                  {data.recentFailures.map((f, i) => (
                    <div key={`${f.at}-${i}`} className="aih-failure">
                      <span className="aih-failure__time">{new Date(f.at).toLocaleString()}</span>
                      <span className="aih-failure__kind">{f.kind === 'ai_error' ? 'ai error' : 'action failed'}</span>
                      <span className="aih-failure__code">{f.code}</span>
                      {f.provider && <span className="aih-failure__meta">provider: {f.provider}</span>}
                      {f.actionType && <span className="aih-failure__meta">action: {f.actionType}</span>}
                    </div>
                  ))}
                </div>
              )}
            </div>
          </>
        )}
      </main>
    </div>
  )
}
