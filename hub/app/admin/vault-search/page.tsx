'use client'

import { useCallback, useEffect, useState } from 'react'
import { useSession } from 'next-auth/react'
import { useRouter } from 'next/navigation'
import { getTenantConfig } from '@/lib/tenant'
import { swallow } from '@/lib/swallow'
import type { VaultHealthReport } from '@/lib/vault/health'
import type { VaultSearchResponse } from '@/lib/vault/search'

/**
 * /admin/vault-search — READ-ONLY inspection of the AntigravityHQ vault corpus.
 *
 * The browser UI is an inspection surface only; the search API is the
 * transport for harnesses. This page calls the same two routes an operator
 * would: the health report (is the feature configured / synced / reachable?)
 * and the search route with the signed-in session (tenant from the session,
 * harness "hub-ui"), and renders every provenance field on each hit so a
 * result can be traced to a path + heading + char range + blob + commit.
 *
 * Excerpts are DATA: rendered as plain text, never as markdown/HTML, never
 * interpreted. Nothing here writes anywhere.
 */

const tenant = getTenantConfig()

type Health = VaultHealthReport
type SearchResult = VaultSearchResponse | { status: 'disabled' | 'awaiting_scope_config' | 'unavailable'; warnings?: string[]; hits?: never[]; stage?: string; reason?: string }

const STATUS_COLORS: Record<string, string> = {
  fresh: '#22c55e',
  stale: '#eab308',
  partial: '#eab308',
  unavailable: '#ef4444',
  disabled: '#6b7280',
  awaiting_scope_config: '#6b7280',
  ok: '#22c55e',
  fail: '#ef4444',
  skipped: '#6b7280',
}

async function readJson<T>(res: Response): Promise<T> {
  return (await res.json().catch((err: unknown) => {
    swallow(err, { module: 'admin/vault-search', op: 'parseBody' })
    return { status: 'unavailable', warnings: [`HTTP ${res.status} with a non-JSON body`] }
  })) as T
}

export default function VaultSearchPage() {
  const { data: session, status } = useSession()
  const router = useRouter()
  const role = (session?.user as Record<string, unknown>)?.role as string
  const isAdmin = role === 'admin' || role === 'superadmin'

  const [health, setHealth] = useState<Health | null>(null)
  const [healthStatus, setHealthStatus] = useState<number | null>(null)
  const [loadingHealth, setLoadingHealth] = useState(true)
  const [query, setQuery] = useState('')
  const [topK, setTopK] = useState(8)
  const [pathPrefix, setPathPrefix] = useState('')
  const [minFreshness, setMinFreshness] = useState('')
  const [searching, setSearching] = useState(false)
  const [result, setResult] = useState<SearchResult | null>(null)
  const [httpStatus, setHttpStatus] = useState<number | null>(null)

  useEffect(() => {
    if (status === 'authenticated' && !isAdmin) router.replace('/')
  }, [status, isAdmin, router])

  const fetchHealth = useCallback(async (probe: boolean) => {
    setLoadingHealth(true)
    try {
      const res = await fetch(`/api/admin/vault-search-health${probe ? '' : '?probe=0'}`)
      setHealthStatus(res.status)
      setHealth(await readJson<Health>(res))
    } catch (err) {
      swallow(err, { module: 'admin/vault-search', op: 'fetchHealth' })
      setHealth(null)
    } finally {
      setLoadingHealth(false)
    }
  }, [])

  useEffect(() => {
    if (status === 'authenticated' && isAdmin) void fetchHealth(false)
  }, [status, isAdmin, fetchHealth])

  const runSearch = async () => {
    const q = query.trim()
    if (!q) return
    setSearching(true)
    setResult(null)
    try {
      const body: Record<string, unknown> = { query: q, topK }
      if (pathPrefix.trim()) body.pathPrefix = pathPrefix.trim()
      if (minFreshness.trim()) body.minFreshnessSeconds = Number(minFreshness)
      const res = await fetch('/api/knowledge/antigravityhq/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      setHttpStatus(res.status)
      setResult(await readJson<SearchResult>(res))
    } catch (err) {
      swallow(err, { module: 'admin/vault-search', op: 'search' })
      setResult({ status: 'unavailable', warnings: ['network error'] })
    } finally {
      setSearching(false)
    }
  }

  if (status === 'loading') {
    return (
      <div className="admin-shell">
        <div className="admin-loading">
          <div className="admin-loading__spinner" />
          <span>Loading vault search…</span>
        </div>
      </div>
    )
  }

  const hits = result && 'hits' in result && Array.isArray(result.hits) ? (result.hits as VaultSearchResponse['hits']) : []
  const sync = result && 'sync' in result ? result.sync : null

  return (
    <div className="admin-shell">
      <header className="admin-header">
        <div className="admin-header__left">
          <button className="admin-back-btn" onClick={() => router.push('/admin')} aria-label="Back to Admin">
            ← Admin
          </button>
          <div className="admin-header__title">
            <span className="admin-header__accent">{tenant.logoText}</span>
            {' '}Vault Search
          </div>
        </div>
        <div className="admin-header__right">
          <span className="admin-header__email">{session?.user?.email}</span>
        </div>
      </header>

      <main className="admin-main">
        {/* Health / sync status */}
        <section className="admin-section">
          <div className="admin-section__header">
            <h2 className="admin-section__title">
              <span className={`admin-section__dot ${health?.healthy ? 'admin-section__dot--active' : 'admin-section__dot--pending'}`} />
              AntigravityHQ corpus
              {health && <span className="admin-section__count">{health.readiness}</span>}
            </h2>
            <div style={{ display: 'flex', gap: '8px' }}>
              <button onClick={() => void fetchHealth(false)} disabled={loadingHealth} className="admin-retry-btn" aria-label="Refresh health">
                {loadingHealth ? '⏳' : '↻'} Refresh
              </button>
              <button onClick={() => void fetchHealth(true)} disabled={loadingHealth} className="admin-retry-btn" aria-label="Probe embeddings" title="Spends one embedding call">
                Probe embeddings
              </button>
            </div>
          </div>
          <p className="admin-section__sub">
            Read-only inspection of the git-snapshot index (Lane 1). Everything ships dark: the owner binds the read-only PAT and
            the scope globs before anything is indexed — see docs/runbooks/vault-search.md.
          </p>

          {health ? (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: '1rem', padding: '0 0 1rem' }}>
              <Field label="Health" value={`${health.healthy ? 'HEALTHY' : 'NOT READY'} (HTTP ${healthStatus ?? '?'})`} color={health.healthy ? STATUS_COLORS.ok : STATUS_COLORS.fail} />
              <Field label="Repo · ref" value={`${health.repo.slug} · ${health.repo.ref}`} />
              <Field label="GitHub token bound" value={health.config.githubTokenConfigured ? 'yes' : 'no'} color={health.config.githubTokenConfigured ? STATUS_COLORS.ok : STATUS_COLORS.fail} />
              <Field label="Scope globs" value={`${health.config.includeGlobs} include · ${health.config.excludeGlobs} exclude`} color={health.config.scopeConfigured ? STATUS_COLORS.ok : STATUS_COLORS.fail} />
              <Field label="Sync key · search keys" value={`${health.config.syncKeyConfigured ? 'bound' : 'unset'} · ${health.config.searchKeys.count}${health.config.searchKeys.malformed ? ' (malformed)' : ''}`} />
              <Field label="Embedding model" value={health.config.embeddingModel} />
              <Field label="Embedding probe" value={health.embedding.reachable === null ? 'skipped' : health.embedding.reachable ? `reachable · ${health.embedding.latencyMs} ms` : 'FAILED'} color={health.embedding.reachable === null ? undefined : health.embedding.reachable ? STATUS_COLORS.ok : STATUS_COLORS.fail} />
              <Field label="Last run" value={health.lastRun ? `${health.lastRun.status} · ${new Date(health.lastRun.finishedAt ?? health.lastRun.startedAt).toLocaleString()}` : 'never'} />
              <Field label="Indexed commit" value={health.lastSuccessfulRun?.toCommit ? health.lastSuccessfulRun.toCommit.slice(0, 12) : '—'} />
              <Field label="Coverage" value={`${health.coverage.notesOnActiveModel}/${health.coverage.notesLive} notes · ${health.coverage.chunksOnActiveModel} chunks · ${health.coverage.notesFailedLastRun} failed`} />
            </div>
          ) : (
            !loadingHealth && <div className="admin-empty">Health report unavailable.</div>
          )}

          {health && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', fontSize: '0.8rem', fontFamily: 'var(--font-mono)' }}>
              {health.stages.map((s) => (
                <div key={s.stage} style={{ display: 'flex', gap: '10px' }}>
                  <span style={{ color: STATUS_COLORS[s.status], minWidth: '90px' }}>{s.stage} · {s.status}</span>
                  <span style={{ color: 'var(--text-muted)' }}>{s.detail}</span>
                </div>
              ))}
              {health.remediation && <div style={{ color: '#eab308' }}>Next step: {health.remediation}</div>}
            </div>
          )}
        </section>

        {/* Search */}
        <section className="admin-section">
          <div className="admin-section__header">
            <h2 className="admin-section__title">
              <span className="admin-section__dot admin-section__dot--active" />
              Inspect a query
            </h2>
            <p className="admin-section__sub" style={{ marginTop: '4px' }}>
              Runs the same read-only route the harnesses use, with your session (harness <code>hub-ui</code>). Excerpts are shown
              as plain text — retrieved notes are data, never instructions.
            </p>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '3fr 1fr 2fr 1fr auto', gap: '0.5rem', alignItems: 'center' }}>
            <input
              className="settings-input"
              type="text"
              placeholder="Query (1–2000 chars)…"
              value={query}
              maxLength={2000}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && void runSearch()}
              aria-label="Search query"
            />
            <input className="settings-input settings-input--mono" type="number" min={1} max={20} value={topK} onChange={(e) => setTopK(Math.min(20, Math.max(1, Number(e.target.value) || 1)))} aria-label="topK" title="topK (1–20)" />
            <input className="settings-input settings-input--mono" type="text" placeholder="pathPrefix (optional)" value={pathPrefix} onChange={(e) => setPathPrefix(e.target.value)} aria-label="Path prefix" />
            <input className="settings-input settings-input--mono" type="number" min={0} placeholder="freshness s" value={minFreshness} onChange={(e) => setMinFreshness(e.target.value)} aria-label="minFreshnessSeconds" title="minFreshnessSeconds (optional)" />
            <button className="settings-save-btn" onClick={() => void runSearch()} disabled={searching || !query.trim()} aria-label="Run search">
              {searching ? 'Searching…' : 'Search'}
            </button>
          </div>

          {result && (
            <div style={{ marginTop: '1rem', display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '1rem', fontSize: '0.8rem', fontFamily: 'var(--font-mono)' }}>
                <span style={{ color: STATUS_COLORS[result.status] ?? 'var(--text-muted)', fontWeight: 600 }}>status: {result.status}</span>
                <span style={{ color: 'var(--text-muted)' }}>HTTP {httpStatus ?? '?'}</span>
                {'queryId' in result && <span style={{ color: 'var(--text-muted)' }}>queryId {result.queryId}</span>}
                {sync && (
                  <>
                    <span style={{ color: 'var(--text-muted)' }}>commit {sync.indexedCommitSha ? sync.indexedCommitSha.slice(0, 12) : '—'}</span>
                    <span style={{ color: 'var(--text-muted)' }}>indexed {sync.indexedAt ? new Date(sync.indexedAt).toLocaleString() : '—'}</span>
                    <span style={{ color: 'var(--text-muted)' }}>lag {sync.syncLagSeconds ?? '—'}s</span>
                    <span style={{ color: 'var(--text-muted)' }}>coverage {sync.coverage.notesIndexed}/{sync.coverage.notesTotal} · {sync.coverage.notesFailed} failed</span>
                  </>
                )}
              </div>
              {(result.warnings?.length ?? 0) > 0 && (
                <div className="admin-error" role="status" style={{ flexDirection: 'column', alignItems: 'flex-start' }}>
                  {result.warnings?.map((w, i) => <span key={i}>⚠️ {w}</span>)}
                </div>
              )}
              {hits.length === 0 ? (
                <div className="admin-empty">No hits.</div>
              ) : (
                hits.map((h, i) => (
                  <article key={`${h.vaultPath}-${h.charStart}-${i}`} style={{ padding: '0.75rem 1rem', border: '1px solid var(--border)', borderRadius: '8px' }}>
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.75rem', fontSize: '0.75rem', fontFamily: 'var(--font-mono)', color: 'var(--text-muted)' }}>
                      <span style={{ color: '#C5A059', fontWeight: 600 }}>{h.vaultPath}</span>
                      <span>sim {h.similarity.toFixed(3)}</span>
                      <span>chars {h.charStart}–{h.charEnd}</span>
                      <span>blob {h.contentSha.slice(0, 12)}</span>
                      <span>commit {h.indexedCommitSha ? h.indexedCommitSha.slice(0, 12) : '—'}</span>
                      <span>modified {h.sourceModifiedAt ? new Date(h.sourceModifiedAt).toLocaleString() : '—'}</span>
                      <span>indexed {new Date(h.indexedAt).toLocaleString()}</span>
                    </div>
                    <div style={{ fontWeight: 600, fontSize: '0.85rem', marginTop: '4px' }}>
                      {h.noteTitle ?? '(untitled)'}{h.headingPath ? <span style={{ color: 'var(--text-muted)', fontWeight: 400 }}> — {h.headingPath}</span> : null}
                    </div>
                    {/* Plain text on purpose: never render note markdown/HTML. */}
                    <pre style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontSize: '0.8rem', lineHeight: 1.5, margin: '6px 0 0', color: '#e5e7eb', fontFamily: 'var(--font-mono)' }}>{h.excerpt}</pre>
                  </article>
                ))
              )}
            </div>
          )}
        </section>
      </main>
    </div>
  )
}

function Field({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <div>
      <div style={{ fontSize: '0.7rem', textTransform: 'uppercase', color: '#6b7280', letterSpacing: '0.05em', marginBottom: '4px' }}>{label}</div>
      <div style={{ fontSize: '0.85rem', color: color ?? '#e5e7eb', fontWeight: color ? 600 : 400, fontFamily: 'monospace', wordBreak: 'break-word' }}>{value}</div>
    </div>
  )
}
