'use client'

import { useState, useRef, useMemo, memo } from 'react'
import { useModalA11y } from '@/app/hooks/useModalA11y'
import { useCalendar } from '@/app/hooks/useHubData'
import { writeFetch } from '@/app/hooks/useWriteFetch'
import type { CalendarEvent } from '@/app/hooks/useHubData'
import type { ChatAttachment } from '@/types'
import styles from './LeftPanelSections.module.css'
import { CollapsibleSection, SkeletonBlock, SectionMessage } from './LeftPanelShared'
import { formatTime, eventDisplayTitle, validateEventForm, DAY_LETTERS, getMonday, getWeekDays } from './LeftPanelUtils'
import { buildEventInjectMessage } from '@/lib/panel-inject'

/* ══════════════════════════════════════════════════════════════════════════════
   CALENDAR EVENT MODAL
   ══════════════════════════════════════════════════════════════════════════════ */

interface CalendarEventModalProps {
  defaultDate?: string  // ISO date string e.g. "2026-06-03"
  onClose: () => void
  onCreated: () => void
}

/** Local calendar date as YYYY-MM-DD, WITHOUT the UTC shift that
 *  new Date().toISOString() introduces for negative-offset users. */
function toLocalISODate(d: Date): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

function CalendarEventModal({ defaultDate, onClose, onCreated }: CalendarEventModalProps) {
  const today = defaultDate || toLocalISODate(new Date())
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [date, setDate] = useState(today)
  const [startTime, setStartTime] = useState('09:00')
  const [endTime, setEndTime] = useState('10:00')
  const [attendees, setAttendees] = useState('')
  const [location, setLocation] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const dialogRef = useRef<HTMLDivElement>(null)
  useModalA11y(dialogRef, onClose)

  async function handleSave(e: React.FormEvent) {
    e.preventDefault()
    if (!title.trim() || !date || !startTime || !endTime) return
    const validationError = validateEventForm({ startTime, endTime, attendees })
    if (validationError) {
      setError(validationError)
      return
    }
    setSaving(true)
    setError(null)
    try {
      const start = `${date}T${startTime}:00`
      const end = `${date}T${endTime}:00`
      // Anchor the naive local datetime to the user's actual zone so Google
      // doesn't reinterpret it against the calendar default (wrong-hour bug).
      const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone
      const emailList = attendees.split(',').map(s => s.trim()).filter(Boolean)
      await writeFetch('/api/google/calendar', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          summary: title.trim(),
          description: description.trim() || undefined,
          start,
          end,
          attendees: emailList.length ? emailList : undefined,
          location: location.trim() || undefined,
          timeZone: timeZone || undefined,
        }),
      })
      onCreated()
      onClose()
    } catch (err) {
      // writeFetch routed a 401 into signIn('google'); show the message either way.
      setError(err instanceof Error ? err.message : 'Failed to create event')
    } finally {
      setSaving(false)
    }
  }

  return (
    <>
      {/* Backdrop */}
      <div
        className={styles.calEventModalBackdrop}
        onClick={onClose}
        aria-hidden="true"
      />
      {/* Modal */}
      <div
        ref={dialogRef}
        tabIndex={-1}
        className={styles.calEventModal}
        role="dialog"
        aria-modal="true"
        aria-label="Create calendar event"
      >
        <div className={styles.calEventModalHeader}>
          <h3 className={styles.calEventModalTitle}>New Event</h3>
          <button className={styles.calEventModalClose} onClick={onClose} aria-label="Close">✕</button>
        </div>

        <form onSubmit={handleSave} className={styles.calEventForm}>
          {/* Title */}
          <div className={styles.calEventFormField}>
            <label className={styles.calEventFormLabel} htmlFor="cal-event-title">Title *</label>
            <input
              id="cal-event-title"
              type="text"
              className={styles.calEventFormInput}
              value={title}
              onChange={e => setTitle(e.target.value)}
              placeholder="Event title"
              required
              autoFocus
            />
          </div>

          {/* Date + Times row */}
          <div className={styles.calEventFormRow}>
            <div className={styles.calEventFormField}>
              <label className={styles.calEventFormLabel} htmlFor="cal-event-date">Date *</label>
              <input
                id="cal-event-date"
                type="date"
                className={styles.calEventFormInput}
                value={date}
                onChange={e => setDate(e.target.value)}
                required
              />
            </div>
            <div className={styles.calEventFormField}>
              <label className={styles.calEventFormLabel} htmlFor="cal-event-start">Start</label>
              <input
                id="cal-event-start"
                type="time"
                className={styles.calEventFormInput}
                value={startTime}
                onChange={e => { setStartTime(e.target.value); setError(null) }}
              />
            </div>
            <div className={styles.calEventFormField}>
              <label className={styles.calEventFormLabel} htmlFor="cal-event-end">End</label>
              <input
                id="cal-event-end"
                type="time"
                className={styles.calEventFormInput}
                value={endTime}
                onChange={e => { setEndTime(e.target.value); setError(null) }}
              />
            </div>
          </div>

          {/* Attendees */}
          <div className={styles.calEventFormField}>
            <label className={styles.calEventFormLabel} htmlFor="cal-event-attendees">Attendees</label>
            <input
              id="cal-event-attendees"
              type="text"
              className={styles.calEventFormInput}
              value={attendees}
              onChange={e => { setAttendees(e.target.value); setError(null) }}
              placeholder="email@example.com, ..."
            />
          </div>

          {/* Location */}
          <div className={styles.calEventFormField}>
            <label className={styles.calEventFormLabel} htmlFor="cal-event-location">Location</label>
            <input
              id="cal-event-location"
              type="text"
              className={styles.calEventFormInput}
              value={location}
              onChange={e => setLocation(e.target.value)}
              placeholder="Office, Zoom link, etc."
            />
          </div>

          {/* Description */}
          <div className={styles.calEventFormField}>
            <label className={styles.calEventFormLabel} htmlFor="cal-event-desc">Description</label>
            <textarea
              id="cal-event-desc"
              className={styles.calEventFormTextarea}
              value={description}
              onChange={e => setDescription(e.target.value)}
              placeholder="Optional notes…"
              rows={3}
            />
          </div>

          {error && (
            <div className={styles.calEventFormError} role="alert">{error}</div>
          )}

          <div className={styles.calEventFormActions}>
            <button
              type="button"
              className={`${styles.calEventFormBtn} ${styles.calEventFormBtnCancel}`}
              onClick={onClose}
            >
              Cancel
            </button>
            <button
              type="submit"
              className={`${styles.calEventFormBtn} ${styles.calEventFormBtnSave}`}
              disabled={saving || !title.trim()}
            >
              {saving ? 'Saving…' : 'Save Event'}
            </button>
          </div>
        </form>
      </div>
    </>
  )
}

/* ══════════════════════════════════════════════════════════════════════════════
   CALENDAR SECTION
   ══════════════════════════════════════════════════════════════════════════════ */

function CalendarSectionImpl({ onInjectChat }: { onInjectChat: (msg: string, attachments?: ChatAttachment[]) => void }) {
  const { events, isLoading, error, mutate } = useCalendar()
  const [selectedDate, setSelectedDate] = useState<Date>(() => new Date())
  const [weekStart, setWeekStart] = useState<Date>(() => getMonday(new Date()))
  const [showCreateModal, setShowCreateModal] = useState(false)
  const [deleteConfirm, setDeleteConfirm] = useState<{ id: string; summary: string; calendarId?: string } | null>(null)
  const [deleting, setDeleting] = useState(false)
  const [deleteError, setDeleteError] = useState<string | null>(null)

  // Build the 7 days of the current week
  const weekDays = useMemo(() => getWeekDays(weekStart), [weekStart])

  // Determine which days have events
  const daysWithEvents = useMemo(() => {
    const set = new Set<string>()
    events.forEach((event) => {
      const eventDate = event.start.dateTime
        ? new Date(event.start.dateTime)
        : event.start.date
          ? new Date(event.start.date + 'T00:00:00')
          : null
      if (eventDate) set.add(eventDate.toDateString())
    })
    return set
  }, [events])

  // Filter events for selected day
  const selectedDateStr = selectedDate.toDateString()
  const dayEvents = useMemo(() => events.filter((event) => {
    const eventDate = event.start.dateTime
      ? new Date(event.start.dateTime)
      : event.start.date
        ? new Date(event.start.date + 'T00:00:00')
        : null
    return eventDate ? eventDate.toDateString() === selectedDateStr : false
  }), [events, selectedDateStr])

  if (isLoading) {
    return (
      <CollapsibleSection title="Calendar" protocolNum="02" defaultOpen>
        <SkeletonBlock lines={3} />
      </CollapsibleSection>
    )
  }

  const isAuthError = error && (error as any)?.status === 401
  if (isAuthError) {
    return (
      <CollapsibleSection title="Calendar" protocolNum="02" defaultOpen>
        <SectionMessage message="Session expired — please sign in again" type="error" />
      </CollapsibleSection>
    )
  }

  if (error) {
    return (
      <CollapsibleSection title="Calendar" protocolNum="02" defaultOpen>
        <SectionMessage message="Unable to load calendar — try refreshing" type="error" />
      </CollapsibleSection>
    )
  }

  const today = new Date()
  today.setHours(0, 0, 0, 0)

  const dayName = selectedDate.toLocaleDateString([], { weekday: 'long' })
  const selectedDateISO = toLocalISODate(selectedDate)

  async function handleDeleteConfirm() {
    if (!deleteConfirm) return
    setDeleting(true)
    setDeleteError(null)
    try {
      await writeFetch('/api/google/calendar', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ eventId: deleteConfirm.id, calendarId: deleteConfirm.calendarId }),
      })
      mutate?.()
      setDeleteConfirm(null)
    } catch (err) {
      // Keep the dialog open and surface the failure; 401 already triggered reauth.
      setDeleteError(err instanceof Error ? err.message : 'Failed to delete event')
    } finally {
      setDeleting(false)
    }
  }

  return (
    <>
      <CollapsibleSection title="Calendar" protocolNum="02" defaultOpen>
        {/* Create event button in section body */}
        <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: '4px' }}>
          <button
            className={styles.calCreateBtn}
            onClick={() => setShowCreateModal(true)}
            aria-label="Create calendar event"
          >
            + Event
          </button>
        </div>

        {/* Week navigation */}
        <div className={styles.calendarWeekNav}>
          <button
            aria-label="Previous week"
            className={styles.calendarWeekNavBtn}
            onClick={() => {
              const prev = new Date(weekStart)
              prev.setDate(prev.getDate() - 7)
              setWeekStart(prev)
            }}
          >
            ‹
          </button>
          <span className={styles.calendarWeekNavLabel}>
            {weekStart.toLocaleDateString([], { month: 'short', day: 'numeric' })} – {weekDays[6].toLocaleDateString([], { month: 'short', day: 'numeric' })}
          </span>
          <button
            aria-label="Next week"
            className={styles.calendarWeekNavBtn}
            onClick={() => {
              const next = new Date(weekStart)
              next.setDate(next.getDate() + 7)
              setWeekStart(next)
            }}
          >
            ›
          </button>
        </div>

        {/* Week strip */}
        <div className={styles.calendarWeekStrip} role="listbox" aria-label="Week days">
          {weekDays.map((day) => {
            const dayStr = day.toDateString()
            const isToday = dayStr === today.toDateString()
            const isSelected = dayStr === selectedDateStr
            const hasEvents = daysWithEvents.has(dayStr)
            const dayLetter = DAY_LETTERS[day.getDay()]

            const classNames = [
              styles.calendarDayCell,
              isToday ? styles.calendarDayCellToday : '',
              isSelected ? styles.calendarDayCellSelected : '',
              hasEvents ? styles.calendarDayCellHasEvents : '',
            ].filter(Boolean).join(' ')

            return (
              <button
                key={dayStr}
                role="option"
                aria-selected={isSelected}
                aria-label={`${day.toLocaleDateString([], { weekday: 'long', month: 'short', day: 'numeric' })}${hasEvents ? ', has events' : ''}`}
                className={classNames}
                onClick={() => setSelectedDate(new Date(day))}
              >
                <span className={styles.calendarDayCellLetter}>{dayLetter}</span>
                <span className={styles.calendarDayCellNumber}>{day.getDate()}</span>
                {hasEvents && <span className={styles.calendarDayCellDot} aria-hidden="true" />}
              </button>
            )
          })}
        </div>

        {/* Day detail */}
        <div className={styles.calendarDayDetail} aria-label={`Events for ${dayName}`}>
          {dayEvents.length === 0 ? (
            <SectionMessage message={`No events on ${dayName}`} type="empty" />
          ) : (
            <div role="list" aria-label={`${dayName} events`}>
              {dayEvents.map((event) => (
                <CalendarRow
                  key={event.id}
                  event={event}
                  onClick={() => onInjectChat(buildEventInjectMessage(event))}
                  onDelete={() => setDeleteConfirm({
                    id: event.id,
                    summary: eventDisplayTitle(event.summary),
                    // Delete from the event's SOURCE calendar (tagged by the API
                    // route); falls back to 'primary' server-side if absent.
                    calendarId: event.calendarId,
                  })}
                />
              ))}
            </div>
          )}
        </div>
      </CollapsibleSection>

      {/* Create Event Modal */}
      {showCreateModal && (
        <CalendarEventModal
          defaultDate={selectedDateISO}
          onClose={() => setShowCreateModal(false)}
          onCreated={() => mutate?.()}
        />
      )}

      {/* Delete Confirm Dialog */}
      {deleteConfirm && (
        <>
          <div className={styles.calEventModalBackdrop} onClick={() => setDeleteConfirm(null)} aria-hidden="true" />
          <div className={`${styles.calEventModal} ${styles.calDeleteDialog}`} role="alertdialog" aria-modal="true" aria-label="Confirm event deletion">
            <div className={styles.calEventModalHeader}>
              <h3 className={styles.calEventModalTitle}>Delete Event?</h3>
              <button className={styles.calEventModalClose} onClick={() => setDeleteConfirm(null)} aria-label="Cancel">✕</button>
            </div>
            <div style={{ padding: '16px 20px' }}>
              <p style={{ color: 'var(--text-secondary)', fontSize: '0.85rem', margin: '0 0 16px' }}>
                Are you sure you want to delete <strong style={{ color: 'var(--text-primary)' }}>&quot;{deleteConfirm.summary}&quot;</strong>? This cannot be undone.
              </p>
              {deleteError && (
                <div className={styles.calEventFormError} role="alert">{deleteError}</div>
              )}
              <div className={styles.calEventFormActions}>
                <button
                  className={`${styles.calEventFormBtn} ${styles.calEventFormBtnCancel}`}
                  onClick={() => setDeleteConfirm(null)}
                >
                  Cancel
                </button>
                <button
                  className={`${styles.calEventFormBtn} ${styles.calEventFormBtnDelete}`}
                  onClick={handleDeleteConfirm}
                  disabled={deleting}
                >
                  {deleting ? 'Deleting…' : 'Delete Event'}
                </button>
              </div>
            </div>
          </div>
        </>
      )}
    </>
  )
}

export const CalendarSection = memo(CalendarSectionImpl)

function CalendarRow({
  event,
  onClick,
  onDelete,
}: {
  event: CalendarEvent
  onClick: () => void
  onDelete: () => void
}) {
  const startTime = event.start.dateTime
    ? formatTime(event.start.dateTime)
    : 'All day'
  const title = eventDisplayTitle(event.summary)

  return (
    <div
      role="listitem"
      className={`${styles.sectionRow} ${styles.sectionRowCalendar} ${styles.calEventRow}`}
      style={{ display: 'flex', alignItems: 'center' }}
    >
      {/* Time badge + event details — clickable for AI inject */}
      <button
        onClick={onClick}
        className={styles.calEventRowMain}
        aria-label={`Event: ${title} at ${startTime}`}
      >
        <span className={styles.calendarTimeBadge}>{startTime}</span>
        <div className={styles.calendarDetails}>
          <div className={styles.calendarSummary}>{title}</div>
          {(event as any).location && (
            <div className={styles.calendarMeta}>{(event as any).location}</div>
          )}
        </div>
      </button>

      {/* Delete button — shown on hover */}
      <button
        className={styles.calRowDeleteBtn}
        onClick={(e) => { e.stopPropagation(); onDelete() }}
        aria-label={`Delete event: ${title}`}
        title={`Delete event: ${title}`}
      >
        🗑
      </button>
    </div>
  )
}
