'use client'

import { useCallback, useState } from 'react'
import { signIn } from 'next-auth/react'
import {
  useGooglePrefs,
  useGA4Properties,
  useGSCSites,
  useSaveGooglePrefs,
} from '@/app/hooks/useGoogleAnalyticsPrefs'

/**
 * AnalyticsSettings — picks which GA4 property and Search Console site this
 * tenant's numbers come from.
 *
 * Replaces the old instruction to "add GA4_PROPERTY_ID and GSC_SITE_URL to
 * Railway", which meant a deploy-time env change and a redeploy to point the
 * KPI board at a different property. Those env vars still work as a per-field
 * fallback, so nothing breaks for a deployment that never opens this section —
 * a saved value simply takes precedence.
 *
 * This is a TENANT-level setting (one business, one set of numbers), so it is
 * admin-gated: the API answers 403 for staff, and the section hides itself
 * rather than showing a form that cannot be submitted.
 */

type SaveStatus = 'idle' | 'saving' | 'saved' | 'error'

export function AnalyticsSettings() {
  const { prefs, isLoading, forbidden } = useGooglePrefs()
  const { save } = useSaveGooglePrefs()

  // The pickers cost two Google round trips, so they load only once the admin
  // opens the section rather than on every visit to Settings.
  const [open, setOpen] = useState(false)
  const ga4 = useGA4Properties(open)
  const gsc = useGSCSites(open)

  const [draftProperty, setDraftProperty] = useState<string | null>(null)
  const [draftSite, setDraftSite] = useState<string | null>(null)
  const [status, setStatus] = useState<SaveStatus>('idle')
  const [error, setError] = useState<string | null>(null)

  const currentProperty = draftProperty ?? prefs.ga4PropertyId ?? ''
  const currentSite = draftSite ?? prefs.gscSiteUrl ?? ''
  const dirty = draftProperty !== null || draftSite !== null

  const handleSave = useCallback(async () => {
    setStatus('saving')
    setError(null)
    const ok = await save({ ga4PropertyId: currentProperty, gscSiteUrl: currentSite })
    if (ok) {
      // Drop the local copy so the server-normalized values take over.
      setDraftProperty(null)
      setDraftSite(null)
      setStatus('saved')
      setTimeout(() => setStatus('idle'), 2000)
    } else {
      setStatus('error')
      setError('Could not save the analytics configuration — please try again.')
    }
  }, [save, currentProperty, currentSite])

  // Staff see a 403 from the settings API; that is expected, not an error.
  if (forbidden) return null

  const needsReconsent = ga4.missingScope || gsc.missingScope

  // "API not enabled" (Google 403 accessNotConfigured) is an operator/Console
  // problem. It must WIN over the authorize prompt: offering re-consent for it
  // just loops (sign in → consent → same 403 → sign-in button again), which is
  // exactly the bug this branch exists for. Show what actually fixes it.
  const apiNotEnabled = ga4.apiNotEnabled || gsc.apiNotEnabled
  const apiNotEnabledMessage =
    (ga4.apiNotEnabled ? ga4.error?.message : gsc.error?.message) ??
    "A Google API this section needs is not enabled for the Hub's Google Cloud project. An operator must enable it in the Google Cloud Console."
  const activationUrl = ga4.activationUrl ?? gsc.activationUrl

  return (
    <section className="settings-section" aria-label="Analytics sources">
      <h2 className="settings-section-title">
        <span className="rx-comment-label">01.6 //</span> Analytics Sources
      </h2>
      <p className="settings-section-desc">
        Which Google Analytics property and Search Console site the Hub reports on. Applies to the
        whole workspace — the KPI board, chat answers and scheduled reports all read from these.
      </p>

      <details
        className="settings-collapsible"
        onToggle={(e: React.SyntheticEvent<HTMLDetailsElement>) =>
          setOpen((e.target as HTMLDetailsElement).open)
        }
      >
        <summary className="settings-collapsible__trigger">
          <span className="settings-collapsible__arrow">▶</span>
          {isLoading
            ? 'Loading…'
            : prefs.ga4PropertyId || prefs.gscSiteUrl
              ? `GA4 ${prefs.ga4PropertyId || '—'} · ${prefs.gscSiteUrl || 'no site'}`
              : 'Not configured yet'}
        </summary>

        {apiNotEnabled ? (
          <div className="settings-scope-warning" data-testid="analytics-api-not-enabled">
            <span style={{ fontSize: '1.5rem' }}>🛠️</span>
            <div>
              <strong>A Google API needs to be enabled for the Hub.</strong>
              <p
                style={{
                  margin: '4px 0 12px 0',
                  fontSize: 'var(--text-xs)',
                  color: 'var(--text-secondary)',
                }}
              >
                {apiNotEnabledMessage}
              </p>
              {activationUrl && (
                <a
                  className="settings-auth-btn"
                  style={{ textDecoration: 'none' }}
                  href={activationUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  Enable it in the Google Cloud Console ↗
                </a>
              )}
            </div>
          </div>
        ) : needsReconsent ? (
          <div className="settings-scope-warning">
            <span style={{ fontSize: '1.5rem' }}>🔐</span>
            <div>
              <strong>Analytics access not yet authorized.</strong>
              <p
                style={{
                  margin: '4px 0 12px 0',
                  fontSize: 'var(--text-xs)',
                  color: 'var(--text-secondary)',
                }}
              >
                Granting Analytics and Search Console access lets the Hub list your properties here.
              </p>
              <button
                className="settings-auth-btn"
                onClick={() => signIn('google', { callbackUrl: '/settings' }, { prompt: 'consent' })}
              >
                Authorize Google Analytics
              </button>
            </div>
          </div>
        ) : (
          <div className="settings-analytics-fields">
            <div className="settings-input-group">
              <label className="settings-label" htmlFor="settings-ga4-property">
                Google Analytics property
              </label>
              {ga4.isLoading ? (
                <p className="settings-section-desc">Loading properties…</p>
              ) : (
                <select
                  id="settings-ga4-property"
                  className="settings-input"
                  value={currentProperty}
                  onChange={e => {
                    setStatus('idle')
                    setDraftProperty(e.target.value)
                  }}
                >
                  <option value="">— none —</option>
                  {/* Keep a configured-but-unlisted property selectable rather
                      than silently resetting it to none (e.g. an env-var value,
                      or a property this admin cannot enumerate). */}
                  {currentProperty &&
                    !ga4.properties.some(p => p.propertyId === currentProperty) && (
                      <option value={currentProperty}>{currentProperty} (current)</option>
                    )}
                  {ga4.properties.map(p => (
                    <option key={p.propertyId} value={p.propertyId}>
                      {p.displayName}
                      {p.accountName ? ` — ${p.accountName}` : ''} ({p.propertyId})
                    </option>
                  ))}
                </select>
              )}
              {ga4.error && !ga4.missingScope && (
                <p className="settings-error">Could not list properties: {ga4.error.message}</p>
              )}
            </div>

            <div className="settings-input-group">
              <label className="settings-label" htmlFor="settings-gsc-site">
                Search Console site
              </label>
              {gsc.isLoading ? (
                <p className="settings-section-desc">Loading sites…</p>
              ) : (
                <select
                  id="settings-gsc-site"
                  className="settings-input"
                  value={currentSite}
                  onChange={e => {
                    setStatus('idle')
                    setDraftSite(e.target.value)
                  }}
                >
                  <option value="">— none —</option>
                  {currentSite && !gsc.sites.some(s => s.siteUrl === currentSite) && (
                    <option value={currentSite}>{currentSite} (current)</option>
                  )}
                  {gsc.sites.map(s => (
                    <option key={s.siteUrl} value={s.siteUrl}>
                      {s.siteUrl}
                    </option>
                  ))}
                </select>
              )}
              {gsc.error && !gsc.missingScope && (
                <p className="settings-error">Could not list sites: {gsc.error.message}</p>
              )}
            </div>

            {error && (
              <p className="settings-error" role="alert">
                {error}
              </p>
            )}

            <div className="settings-save-row">
              <button
                id="settings-save-analytics-btn"
                className="settings-save-btn"
                onClick={handleSave}
                disabled={!dirty || status === 'saving'}
              >
                {status === 'saving' ? 'Saving…' : status === 'saved' ? '✓ Saved' : 'Save Analytics Sources'}
              </button>
            </div>
          </div>
        )}
      </details>
    </section>
  )
}
