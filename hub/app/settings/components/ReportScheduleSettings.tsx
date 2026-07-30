'use client'

import { useCallback, useState } from 'react'
import { useGooglePrefs, useSaveGooglePrefs } from '@/app/hooks/useGoogleAnalyticsPrefs'
import {
  normalizeReports,
  DEFAULT_REPORTS,
  WEEKDAYS,
  type ReportConfig,
  type ReportCadence,
  type Weekday,
} from '@/lib/reports/config'

/**
 * ReportScheduleSettings — when scheduled digests run, and who receives them.
 *
 * This is the piece that made the "admin-configurable cadence" real. The config
 * layer and the runner shipped first, but nothing wrote `google_prefs.reports`,
 * so every tenant silently ran the seeded defaults and the setting existed only
 * on paper.
 *
 * ── Whole-list PUT, deliberately ──
 * Saving sends the ENTIRE reports array rather than a per-report patch. The
 * server re-normalizes it (dropping malformed entries, clamping hours, capping
 * monthly days at 28) and the response replaces local state, so what the form
 * shows afterward is exactly what will run — not what the user typed. Per-report
 * PATCH would need an id-addressable endpoint and would let the list drift from
 * the stored value.
 *
 * The post carries ONLY `reports`; the writer keys off field presence, so this
 * cannot clobber the tenant's GA4 property or Search Console site.
 *
 * Admin-gated: the section hides itself when the prefs API answers 403, the same
 * way AnalyticsSettings does.
 */

type SaveStatus = 'idle' | 'saving' | 'saved' | 'error'

const CADENCES: ReportCadence[] = ['daily', 'weekly', 'monthly']

const KIND_LABEL: Record<string, string> = {
  ga4_gsc_digest: 'Analytics digest (Doc)',
  business_review_deck: 'Business review (Slides)',
}

const WEEKDAY_LABEL: Record<Weekday, string> = {
  sun: 'Sunday',
  mon: 'Monday',
  tue: 'Tuesday',
  wed: 'Wednesday',
  thu: 'Thursday',
  fri: 'Friday',
  sat: 'Saturday',
}

/** "7" → "07:00". The runner matches on the hour, so minutes are not offered. */
const hourLabel = (h: number) => `${String(h).padStart(2, '0')}:00`

export function ReportScheduleSettings() {
  const { prefs, isLoading, forbidden } = useGooglePrefs()
  const { save } = useSaveGooglePrefs()

  const [draft, setDraft] = useState<ReportConfig[] | null>(null)
  const [status, setStatus] = useState<SaveStatus>('idle')
  const [error, setError] = useState<string | null>(null)

  // Server truth seeds the form; the seeded defaults stand in when a tenant has
  // never saved, matching exactly what the runner would do today.
  const stored = normalizeReports(prefs.reports)
  const effective = stored.length ? stored : DEFAULT_REPORTS
  const reports = draft ?? effective

  const edit = useCallback((next: ReportConfig[]) => {
    setStatus('idle')
    setError(null)
    setDraft(next)
  }, [])

  const update = useCallback(
    (index: number, patch: Partial<ReportConfig>) => {
      edit(reports.map((r, i) => (i === index ? { ...r, ...patch } : r)))
    },
    [reports, edit],
  )

  const handleSave = useCallback(async () => {
    if (!draft) return
    setStatus('saving')
    setError(null)
    // Only `reports` — see the whole-list note above.
    const ok = await save({ reports: draft })
    if (ok) {
      // Drop local state so the server-normalized list takes over.
      setDraft(null)
      setStatus('saved')
      setTimeout(() => setStatus('idle'), 2000)
    } else {
      setStatus('error')
      setError('Could not save the report schedule — please try again.')
    }
  }, [draft, save])

  if (forbidden) return null

  return (
    <section className="settings-section" aria-label="Scheduled reports">
      <h2 className="settings-section-title">
        <span className="rx-comment-label">01.7 //</span> Scheduled Reports
      </h2>
      <p className="settings-section-desc">
        When performance reports are generated and who receives them. Times are in the workspace
        timezone. Reports are always filed in your Drive; email and Chat delivery are optional.
      </p>

      <details className="settings-collapsible">
        <summary className="settings-collapsible__trigger">
          <span className="settings-collapsible__arrow">▶</span>
          {isLoading
            ? 'Loading…'
            : `${reports.filter(r => r.enabled).length} of ${reports.length} enabled`}
        </summary>

        {reports.length === 0 ? (
          <p className="settings-empty">No reports configured.</p>
        ) : (
          <div className="settings-analytics-fields">
            {reports.map((report, i) => (
              <div key={report.id} className="settings-report-row">
                <div className="settings-report-row__head">
                  <span className="settings-label" style={{ margin: 0 }}>
                    {KIND_LABEL[report.kind] ?? report.kind}
                  </span>
                  <div
                    role="switch"
                    aria-checked={report.enabled}
                    aria-label={`${report.enabled ? 'Disable' : 'Enable'} ${report.id}`}
                    tabIndex={0}
                    className={`settings-toggle ${report.enabled ? 'settings-toggle--on' : ''}`}
                    onClick={() => update(i, { enabled: !report.enabled })}
                    onKeyDown={e => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault()
                        update(i, { enabled: !report.enabled })
                      }
                    }}
                  >
                    <span className="settings-toggle__thumb" />
                  </div>
                </div>

                <div className="settings-input-group">
                  <label className="settings-label" htmlFor={`cadence-${report.id}`}>
                    How often
                  </label>
                  <select
                    id={`cadence-${report.id}`}
                    className="settings-input"
                    value={report.cadence}
                    onChange={e => {
                      const cadence = e.target.value as ReportCadence
                      // Switching cadence changes what `day` means, so reset it
                      // to a valid value for the new one rather than carrying a
                      // weekday into a monthly report.
                      update(i, {
                        cadence,
                        day: cadence === 'weekly' ? 'mon' : cadence === 'monthly' ? 1 : undefined,
                      })
                    }}
                  >
                    {CADENCES.map(c => (
                      <option key={c} value={c}>
                        {c.charAt(0).toUpperCase() + c.slice(1)}
                      </option>
                    ))}
                  </select>
                </div>

                {report.cadence === 'weekly' && (
                  <div className="settings-input-group">
                    <label className="settings-label" htmlFor={`day-${report.id}`}>
                      Day of week
                    </label>
                    <select
                      id={`day-${report.id}`}
                      className="settings-input"
                      value={String(report.day ?? 'mon')}
                      onChange={e => update(i, { day: e.target.value as Weekday })}
                    >
                      {WEEKDAYS.map(d => (
                        <option key={d} value={d}>
                          {WEEKDAY_LABEL[d]}
                        </option>
                      ))}
                    </select>
                  </div>
                )}

                {report.cadence === 'monthly' && (
                  <div className="settings-input-group">
                    <label className="settings-label" htmlFor={`dom-${report.id}`}>
                      Day of month
                    </label>
                    <select
                      id={`dom-${report.id}`}
                      className="settings-input"
                      value={String(report.day ?? 1)}
                      onChange={e => update(i, { day: Number(e.target.value) })}
                    >
                      {/* Capped at 28 so the report fires in February too. */}
                      {Array.from({ length: 28 }, (_, n) => n + 1).map(d => (
                        <option key={d} value={d}>
                          {d}
                        </option>
                      ))}
                    </select>
                  </div>
                )}

                <div className="settings-input-group">
                  <label className="settings-label" htmlFor={`hour-${report.id}`}>
                    Time (workspace timezone)
                  </label>
                  <select
                    id={`hour-${report.id}`}
                    className="settings-input"
                    value={String(report.hourLocal)}
                    onChange={e => update(i, { hourLocal: Number(e.target.value) })}
                  >
                    {Array.from({ length: 24 }, (_, h) => h).map(h => (
                      <option key={h} value={h}>
                        {hourLabel(h)}
                      </option>
                    ))}
                  </select>
                </div>

                <div className="settings-input-group">
                  <label className="settings-label" htmlFor={`email-${report.id}`}>
                    Email to
                  </label>
                  <input
                    id={`email-${report.id}`}
                    className="settings-input"
                    type="text"
                    placeholder="admins, someone@example.com"
                    value={report.delivery.email.join(', ')}
                    onChange={e =>
                      update(i, {
                        delivery: {
                          ...report.delivery,
                          email: e.target.value.split(',').map(s => s.trim()).filter(Boolean),
                        },
                      })
                    }
                  />
                  <p className="settings-section-desc" style={{ marginTop: '4px' }}>
                    Use <code>admins</code> for everyone with admin access, or list addresses.
                    Leave blank to file the report in Drive without emailing it.
                  </p>
                </div>

                <div className="settings-input-group">
                  <label className="settings-label" htmlFor={`space-${report.id}`}>
                    Post to Chat space (optional)
                  </label>
                  <input
                    id={`space-${report.id}`}
                    className="settings-input"
                    type="text"
                    placeholder="spaces/AAAA..."
                    value={report.delivery.chatSpaceId ?? ''}
                    onChange={e =>
                      update(i, {
                        delivery: { ...report.delivery, chatSpaceId: e.target.value.trim() || undefined },
                      })
                    }
                  />
                </div>
              </div>
            ))}

            <div className="settings-spaces-actions">
              <button className="settings-link-btn" onClick={() => edit([...DEFAULT_REPORTS])}>
                Reset to defaults
              </button>
            </div>

            {error && (
              <p className="settings-error" role="alert">
                {error}
              </p>
            )}

            <div className="settings-save-row">
              <button
                id="settings-save-reports-btn"
                className="settings-save-btn"
                onClick={handleSave}
                disabled={!draft || status === 'saving'}
              >
                {status === 'saving' ? 'Saving…' : status === 'saved' ? '✓ Saved' : 'Save Report Schedule'}
              </button>
            </div>
          </div>
        )}
      </details>
    </section>
  )
}
