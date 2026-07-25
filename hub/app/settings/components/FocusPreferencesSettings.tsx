'use client'

import { useEffect, useState, useCallback } from 'react'
import type { FocusPreferences, FocusVip, FocusVipCategory } from '@/lib/focus-preferences'
import { MAX_VIPS, MAX_GOALS_LENGTH } from '@/lib/focus-preferences'
import { FOCUS_NOTIFY_KEY, isFocusNotifyEnabled } from '@/app/hooks/useFocusNotifications'

/**
 * FocusPreferencesSettings — editor for the per-user Gmail Focus personalization
 * (VIP list + goals) that the ranker injects. Self-contained: fetches on mount,
 * saves via PUT, and reflects the server-normalized result so the user sees
 * exactly what was stored (deduped / clamped).
 */

type SaveStatus = 'idle' | 'saving' | 'saved' | 'error'

const EMPTY: FocusPreferences = { vips: [], goals: '' }

export function FocusPreferencesSettings() {
  const [loading, setLoading] = useState(true)
  const [vips, setVips] = useState<FocusVip[]>([])
  const [goals, setGoals] = useState('')
  const [status, setStatus] = useState<SaveStatus>('idle')
  const [error, setError] = useState<string | null>(null)
  // Desktop-alert toggle — client-side (localStorage), applies immediately,
  // no Save needed. The page-level watcher reads it on mount.
  const [notifyOn, setNotifyOn] = useState(false)
  const [notifyHint, setNotifyHint] = useState<string | null>(null)
  useEffect(() => { setNotifyOn(isFocusNotifyEnabled()) }, [])

  const toggleNotify = useCallback(async () => {
    setNotifyHint(null)
    if (notifyOn) {
      try { localStorage.setItem(FOCUS_NOTIFY_KEY, '0') } catch {}
      setNotifyOn(false)
      return
    }
    if (typeof window === 'undefined' || !('Notification' in window)) {
      setNotifyHint('This browser does not support desktop notifications.')
      return
    }
    // Permission must be requested from a user gesture — this click is one.
    const permission = Notification.permission === 'granted'
      ? 'granted'
      : await Notification.requestPermission()
    if (permission !== 'granted') {
      setNotifyHint('Notifications are blocked for this site — allow them in your browser settings, then try again.')
      return
    }
    try { localStorage.setItem(FOCUS_NOTIFY_KEY, '1') } catch {}
    setNotifyOn(true)
  }, [notifyOn])

  useEffect(() => {
    let live = true
    ;(async () => {
      try {
        const r = await fetch('/api/google/gmail/focus/preferences')
        const d: FocusPreferences = r.ok ? await r.json() : EMPTY
        if (!live) return
        setVips(Array.isArray(d.vips) ? d.vips : [])
        setGoals(typeof d.goals === 'string' ? d.goals : '')
      } catch {
        if (live) { setVips([]); setGoals('') }
      } finally {
        if (live) setLoading(false)
      }
    })()
    return () => { live = false }
  }, [])

  const dirty = () => { setStatus('idle'); setError(null) }

  const addVip = useCallback(() => {
    if (vips.length >= MAX_VIPS) return
    dirty()
    setVips(prev => [...prev, { value: '', category: 'business' }])
  }, [vips.length])

  const updateVip = useCallback((i: number, patch: Partial<FocusVip>) => {
    dirty()
    setVips(prev => prev.map((v, idx) => (idx === i ? { ...v, ...patch } : v)))
  }, [])

  const removeVip = useCallback((i: number) => {
    dirty()
    setVips(prev => prev.filter((_, idx) => idx !== i))
  }, [])

  const save = useCallback(async () => {
    setStatus('saving')
    setError(null)
    try {
      const r = await fetch('/api/google/gmail/focus/preferences', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        // Drop blank VIP rows before sending; the server re-normalizes anyway.
        body: JSON.stringify({ vips: vips.filter(v => v.value.trim()), goals }),
      })
      if (!r.ok) {
        const body = await r.json().catch(() => ({}))
        throw new Error(body?.error || `Save failed (${r.status})`)
      }
      const saved: FocusPreferences = await r.json()
      // Reflect the normalized result (dedupe / clamp) so the UI matches storage.
      setVips(saved.vips ?? [])
      setGoals(saved.goals ?? '')
      setStatus('saved')
    } catch (err) {
      setStatus('error')
      setError(err instanceof Error ? err.message : 'Save failed')
    }
  }, [vips, goals])

  return (
    <section className="settings-section" aria-label="Email Focus priorities">
      <h2 className="settings-section-title">
        <span className="rx-comment-label">01.6 //</span> Email Focus Priorities
      </h2>
      <p className="settings-section-desc">
        Teach the Gmail Focus strip what matters to you. These are private to your account and
        used to rank which emails surface first.
      </p>

      {loading ? (
        <div className="settings-spaces-loading" role="status">
          {[1, 2].map(i => <div key={i} className="settings-space-skeleton" />)}
        </div>
      ) : (
        <>
          {/* Goals */}
          <label className="settings-field-label" htmlFor="focus-goals">
            What matters to you right now
          </label>
          <textarea
            id="focus-goals"
            className="settings-textarea"
            rows={3}
            maxLength={MAX_GOALS_LENGTH}
            placeholder="e.g. Closing the Q3 SBG deal, hiring a head of ops, and anything about my daughter's school."
            value={goals}
            onChange={e => { dirty(); setGoals(e.target.value) }}
            style={{ width: '100%', resize: 'vertical' }}
          />
          <p className="settings-field-hint">
            Plain language — business and personal together. The ranker weights emails that
            advance these higher (and won&apos;t bury an unexpected but relevant new contact).
          </p>

          {/* VIP list */}
          <div className="settings-field-label" style={{ marginTop: '16px' }}>
            VIP senders ({vips.length}/{MAX_VIPS})
          </div>
          <p className="settings-field-hint" style={{ marginTop: '2px' }}>
            An email address, a domain (<code>@acme.com</code>), or a name. Mail from these is
            always high priority — personal counts as much as business.
          </p>

          <div className="settings-vip-list" role="list">
            {vips.map((vip, i) => (
              <div key={i} className="settings-vip-row" role="listitem"
                style={{ display: 'flex', gap: '8px', alignItems: 'center', marginBottom: '8px' }}>
                <input
                  className="settings-input"
                  type="text"
                  aria-label={`VIP ${i + 1} value`}
                  placeholder="email, @domain, or name"
                  value={vip.value}
                  onChange={e => updateVip(i, { value: e.target.value })}
                  style={{ flex: 1 }}
                />
                <select
                  className="settings-input"
                  aria-label={`VIP ${i + 1} category`}
                  value={vip.category}
                  onChange={e => updateVip(i, { category: e.target.value as FocusVipCategory })}
                >
                  <option value="business">Business</option>
                  <option value="personal">Personal</option>
                </select>
                <button
                  className="settings-link-btn"
                  aria-label={`Remove VIP ${i + 1}`}
                  onClick={() => removeVip(i)}
                >
                  Remove
                </button>
              </div>
            ))}
          </div>

          <button
            className="settings-link-btn"
            onClick={addVip}
            disabled={vips.length >= MAX_VIPS}
          >
            + Add VIP
          </button>

          {/* Desktop alerts for urgent emails — instant, no Save needed. The
              alert is the ONLY tier action: nothing is archived or forwarded. */}
          <label className="settings-space-row" style={{ marginTop: '18px' }}>
            <div className="settings-space-row__info">
              <span className="settings-space-row__icon" aria-hidden="true">🔔</span>
              <span className="settings-space-row__name">Desktop alerts for urgent emails</span>
            </div>
            <div
              role="switch"
              aria-checked={notifyOn}
              tabIndex={0}
              className={`settings-toggle ${notifyOn ? 'settings-toggle--on' : ''}`}
              onClick={toggleNotify}
              onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleNotify() } }}
              aria-label={`${notifyOn ? 'Disable' : 'Enable'} desktop alerts for urgent emails`}
            >
              <span className="settings-toggle__thumb" />
            </div>
          </label>
          <p className="settings-field-hint">
            One-time alert per urgent thread (a VIP waiting on you, a hard deadline) while the
            Hub is open — even in a background tab. Alert only; nothing touches your mail.
          </p>
          {notifyHint && (
            <p className="settings-field-hint" role="alert" style={{ color: 'var(--danger)' }}>
              ⚠️ {notifyHint}
            </p>
          )}

          <div className="settings-save-row" style={{ marginTop: '16px' }}>
            <button
              className="settings-save-btn"
              onClick={save}
              disabled={status === 'saving' || status === 'saved'}
            >
              {status === 'saving' ? 'Saving…' : status === 'saved' ? '✓ Saved' : 'Save Focus Priorities'}
            </button>
            {status === 'error' && (
              <span className="settings-save-error" role="alert" style={{ marginLeft: '10px', color: 'var(--danger, #e5484d)' }}>
                ⚠️ {error}
              </span>
            )}
          </div>
        </>
      )}
    </section>
  )
}
