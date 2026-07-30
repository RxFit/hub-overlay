'use client'

import { useCallback, useMemo, useState } from 'react'
import { useGooglePrefs, useSaveGooglePrefs } from '@/app/hooks/useGoogleAnalyticsPrefs'
import {
  normalizeReports,
  DEFAULT_REPORTS,
  type ReportConfig,
  type ReportCadence,
  type ReportKind,
  type Weekday,
} from '@/lib/reports/config'
import {
  REPORT_KIND_LABELS,
  CADENCE_LABELS,
  WEEKDAY_OPTIONS,
  MONTH_DAY_OPTIONS,
  describeSchedule,
  describeDelivery,
  formatHour,
  newReport,
  applyCadence,
  parseRecipients,
  formatRecipients,
} from '@/lib/reports/editor'

/**
 * ScheduledReportsSettings — the editor for when reports go out and to whom.
 *
 * Closes the 7th finding of the #164 audit. The cadence has been per-tenant
 * data since #158 and the column became writable in #164, but nothing could
 * write it: the runner always fell back to the seeded defaults, so "editable
 * cadence" was true of the schema and false of the product.
 *
 * TENANT-level, so admin-gated — the API answers 403 for staff and this section
 * hides itself rather than showing a form that cannot be submitted, matching
 * AnalyticsSettings.
 */

type SaveStatus = 'idle' | 'saving' | 'saved' | 'error'

const HOURS = Array.from({ length: 24 }, (_, h) => h)

export function ScheduledReportsSettings() {
  const { prefs, isLoading, forbidden } = useGooglePrefs()
  const { save } = useSaveGooglePrefs()

  const [draft, setDraft] = useState<ReportConfig[] | null>(null)
  const [status, setStatus] = useState<SaveStatus>('idle')
  const [error, setError] = useState<string | null>(null)

  /**
   * Stored reports, hardened with the SAME normalizer the server uses.
   *
   * An empty stored array means "never configured", which the runner treats as
   * the seeded defaults — so the editor must show those defaults too. Showing
   * an empty list would tell the admin no reports are scheduled while two are
   * in fact going out every week.
   */
  const stored = useMemo(() => {
    const rows = normalizeReports(prefs.reports)
    return rows.length ? rows : DEFAULT_REPORTS
  }, [prefs.reports])

  const reports = draft ?? stored
  const dirty = draft !== null

  const edit = useCallback((next: ReportConfig[]) => {
    setStatus('idle')
    setError(null)
    setDraft(next)
  }, [])

  const update = useCallback((id: string, patch: Partial<ReportConfig>) => {
    edit(reports.map(r => (r.id === id ? { ...r, ...patch } : r)))
  }, [reports, edit])

  const handleSave = useCallback(async () => {
    if (!draft) return
    setStatus('saving')
    setError(null)
    // Posts ONLY `reports`. Safe because normalizePrefsInput keys on presence —
    // before that fix this would have wiped the tenant's GA4 property.
    const ok = await save({ reports: draft })
    if (ok) {
      setDraft(null)
      setStatus('saved')
      setTimeout(() => setStatus('idle'), 2000)
    } else {
      setStatus('error')
      setError('Could not save the report schedule — please try again.')
    }
  }, [draft, save])

  // Staff see a 403 from the settings API; that is expected, not an error.
  if (forbidden) return null

  const activeCount = reports.filter(r => r.enabled).length

  return (
    <section className="settings-section" aria-label="Scheduled reports">
      <h2 className="settings-section-title">
        <span className="rx-comment-label">01.7 //</span> Scheduled Reports
      </h2>
      <p className="settings-section-desc">
        When the analytics digest and business review go out, and who receives them. Times are in
        the workspace timezone{prefs.timezone ? ` (${prefs.timezone})` : ''}; the scheduler checks
        hourly, so delivery lands within the hour you pick.
      </p>

      {isLoading ? (
        <div className="settings-spaces-loading" role="status">
          {[1, 2].map(i => <div key={i} className="settings-space-skeleton" />)}
        </div>
      ) : (
        <details className="settings-collapsible">
          <summary className="settings-collapsible__trigger">
            <span className="settings-collapsible__arrow">▶</span>
            {reports.length} report{reports.length === 1 ? '' : 's'} · {activeCount} active
          </summary>

          <div className="settings-reports-list">
            {reports.map(report => (
              <div key={report.id} className="settings-report-card">
                <div className="settings-report-card__head">
                  <div className="settings-report-card__title">
                    <span className="settings-report-card__kind">
                      {REPORT_KIND_LABELS[report.kind]}
                    </span>
                    <span className="settings-report-card__schedule">
                      {describeSchedule(report, prefs.timezone)} · {describeDelivery(report)}
                    </span>
                  </div>

                  <div
                    role="switch"
                    aria-checked={report.enabled}
                    tabIndex={0}
                    aria-label={`${report.enabled ? 'Disable' : 'Enable'} ${REPORT_KIND_LABELS[report.kind]}`}
                    className={`settings-toggle ${report.enabled ? 'settings-toggle--on' : ''}`}
                    onClick={() => update(report.id, { enabled: !report.enabled })}
                    onKeyDown={e => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault()
                        update(report.id, { enabled: !report.enabled })
                      }
                    }}
                  >
                    <span className="settings-toggle__thumb" />
                  </div>
                </div>

                <div className="settings-report-card__fields">
                  <label className="settings-report-field">
                    <span>Report</span>
                    <select
                      value={report.kind}
                      onChange={e => update(report.id, { kind: e.target.value as ReportKind })}
                    >
                      {(Object.keys(REPORT_KIND_LABELS) as ReportKind[]).map(k => (
                        <option key={k} value={k}>{REPORT_KIND_LABELS[k]}</option>
                      ))}
                    </select>
                  </label>

                  <label className="settings-report-field">
                    <span>How often</span>
                    <select
                      value={report.cadence}
                      onChange={e => {
                        const next = applyCadence(report, e.target.value as ReportCadence)
                        edit(reports.map(r => (r.id === report.id ? next : r)))
                      }}
                    >
                      {(Object.keys(CADENCE_LABELS) as ReportCadence[]).map(c => (
                        <option key={c} value={c}>{CADENCE_LABELS[c]}</option>
                      ))}
                    </select>
                  </label>

                  {report.cadence === 'weekly' && (
                    <label className="settings-report-field">
                      <span>Day</span>
                      <select
                        value={typeof report.day === 'string' ? report.day : 'mon'}
                        onChange={e => update(report.id, { day: e.target.value as Weekday })}
                      >
                        {WEEKDAY_OPTIONS.map(d => (
                          <option key={d.value} value={d.value}>{d.label}</option>
                        ))}
                      </select>
                    </label>
                  )}

                  {report.cadence === 'monthly' && (
                    <label className="settings-report-field">
                      <span>Day of month</span>
                      <select
                        value={typeof report.day === 'number' ? report.day : 1}
                        onChange={e => update(report.id, { day: Number(e.target.value) })}
                      >
                        {MONTH_DAY_OPTIONS.map(d => (
                          <option key={d} value={d}>{d}</option>
                        ))}
                      </select>
                    </label>
                  )}

                  <label className="settings-report-field">
                    <span>Time</span>
                    <select
                      value={report.hourLocal}
                      onChange={e => update(report.id, { hourLocal: Number(e.target.value) })}
                    >
                      {HOURS.map(h => (
                        <option key={h} value={h}>{formatHour(h)}</option>
                      ))}
                    </select>
                  </label>

                  <label className="settings-report-field settings-report-field--wide">
                    <span>Recipients</span>
                    <input
                      type="text"
                      value={formatRecipients(report.delivery.email)}
                      placeholder="admins, someone@example.com"
                      onChange={e => {
                        const { emails } = parseRecipients(e.target.value)
                        update(report.id, { delivery: { ...report.delivery, email: emails } })
                      }}
                    />
                  </label>
                </div>

                <div className="settings-report-card__foot">
                  <button
                    className="settings-link-btn"
                    onClick={() => edit(reports.filter(r => r.id !== report.id))}
                  >
                    Remove
                  </button>
                </div>
              </div>
            ))}

            {reports.length === 0 && (
              <p className="settings-empty">
                No scheduled reports. Nothing will be sent until you add one.
              </p>
            )}
          </div>

          <div className="settings-spaces-actions">
            <button
              className="settings-link-btn"
              onClick={() => edit([...reports, newReport('ga4_gsc_digest', reports)])}
            >
              + Add digest
            </button>
            <button
              className="settings-link-btn"
              onClick={() => edit([...reports, newReport('business_review_deck', reports)])}
            >
              + Add review deck
            </button>
            {dirty && (
              <button className="settings-link-btn" onClick={() => { setDraft(null); setStatus('idle') }}>
                Discard changes
              </button>
            )}
          </div>
        </details>
      )}

      {error && <p className="settings-error" role="alert">{error}</p>}

      <div className="settings-save-row">
        <button
          className="settings-save-btn"
          onClick={handleSave}
          disabled={!dirty || status === 'saving'}
        >
          {status === 'saving' ? 'Saving…' : status === 'saved' ? '✓ Saved' : 'Save Report Schedule'}
        </button>
      </div>
    </section>
  )
}
