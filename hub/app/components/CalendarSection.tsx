'use client'

import { useState } from 'react'
import { useCalendar } from '@/app/hooks/useHubData'
import type { CalendarEvent } from '@/app/hooks/useHubData'
import styles from './LeftPanelSections.module.css'
import { CollapsibleSection, SkeletonBlock, SectionMessage } from './LeftPanelShared'
import { formatTime, DAY_LETTERS, getMonday, getWeekDays } from './LeftPanelUtils'

/* ══════════════════════════════════════════════════════════════════════════════
   CALENDAR EVENT MODAL
   ══════════════════════════════════════════════════════════════════════════════ */

interface CalendarEventModalProps {
  defaultDate?: string  // ISO date string e.g. "2026-06-03"
  onClose: () => void
  onCreated: () => void
}

function CalendarEventModal({ defaultDate, onClose, onCreated }: CalendarEventModalProps) {
  const today = defaultDate || new Date().toISOString().split('T')[0]
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [date, setDate] = useState(today)
  const [startTime, setStartTime] = useState('09:00')
  const [endTime, setEndTime] = useState('10:00')
  const [attendees, setAttendees] = useState('')
  const [location, setLocation] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleSave(e: React.FormEvent) {
    e.preventDefault()
    if (!title.trim() || !date || !startTime || !endTime) return
    setSaving(true)
    setError(null)
    try {
      const start = `${date}T${startTime}:00`
      const end = `${date}T${endTime}:00`
      const emailList = attendees.split(',').map(s => s.trim()).filter(Boolean)
      const res = await fetch('/api/google/calendar', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          summary: title.trim(),
          description: description.trim() || undefined,
          start,
          end,
          attendees: emailList.length ? emailList : undefined,
          location: location.trim() || undefined,
        }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Failed to create event')
      onCreated()
      onClose()
    } catch (err) {
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
                onChange={e => setStartTime(e.target.value)}
              />
            </div>
            <div className={styles.calEventFormField}>
              <label className={styles.calEventFormLabel} htmlFor="cal-event-end">End</label>
              <input
                id="cal-event-end"
                type="time"
                className={styles.calEventFormInput}
                value={endTime}
                onChange={e => setEndTime(e.target.value)}
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
              onChange={e => setAttendees(e.target.value)}
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
              placeholder="Address or Google Meet link"
            />
          </div>

          {/* Description */}
          <div className={styles.calEventFormField}>
            <label className={styles.calEventFormLabel} htmlFor="cal-event-desc">Description</label>
            <textarea
              id="cal-event-desc"
              className={`${styles.calEventFormInput} ${styles.calEventFormTextarea}`}
              value={description}
              onChange={e => setDescription(e.target.value)}
              placeholder="Optional notes"
              rows={2}
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

export function CalendarSection({ onInjectChat }: { onInjectChat: (msg: string) => void }) {
  const { events, isLoading, error, mutate } = useCalendar()
  const [selectedDate, setSelectedDate] = useState<Date>(() => new Date())
  const [weekStart, setWeekStart] = useState<Date>(() => getMonday(new Date()))
  const [showCreateModal, setShowCreateModal] = useState(false)
  const [deleteConfirm, setDeleteConfirm] = useState<{ id: string; summary: string; calendarId?: string } | null>(null)
  const [deleting, setDeleting] = useState(false)

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

  // Build the 7 days of the current week
  const weekDays = getWeekDays(weekStart)
  const today = new Date()
  today.setHours(0, 0, 0, 0)

  // Determine which days have events
  const daysWithEvents = new Set<string>()
  events.forEach((event) => {
    const eventDate = event.start.dateTime
      ? new Date(event.start.dateTime)
      : event.start.date
        ? new Date(event.start.date + 'T00:00:00')
        : null
    if (eventDate) {
      daysWithEvents.add(eventDate.toDateString())
    }
  })

  // Filter events for selected day
  const selectedDateStr = selectedDate.toDateString()
  const dayEvents = events.filter((event) => {
    const eventDate = event.start.dateTime
      ? new Date(event.start.dateTime)
      : event.start.date
        ? new Date(event.start.date + 'T00:00:00')
        : null
    return eventDate ? eventDate.toDateString() === selectedDateStr : false
  })

  const dayName = selectedDate.toLocaleDateString([], { weekday: 'long' })
  const selectedDateISO = selectedDate.toISOString().split('T')[0]

  async function handleDeleteConfirm() {
    if (!deleteConfirm) return
    setDeleting(true)
    try {
      await fetch('/api/google/calendar', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ eventId: deleteConfirm.id, calendarId: deleteConfirm.calendarId }),
      })
      mutate?.()
    } catch { /* non-fatal */ } finally {
      setDeleting(false)
      setDeleteConfirm(null)
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
                  onClick={() => {
                    const userTz = Intl.DateTimeFormat().resolvedOptions().timeZone
                    const startStr = event.start.dateTime
                      ? new Date(event.start.dateTime).toLocaleString('en-US', { timeZone: userTz, dateStyle: 'medium', timeStyle: 'short' })
                      : event.start.date ?? ''
                    const endStr = event.end?.dateTime
                      ? `, ends ${new Date(event.end.dateTime).toLocaleTimeString('en-US', { timeZone: userTz, timeStyle: 'short' })}`
                      : ''
                    const loc = event.location ? `, location: ${event.location}` : ''
                    const attendees = event.attendees?.length
                      ? `, attendees: ${event.attendees.map(a => a.email || a.displayName).slice(0, 5).join(', ')}`
                      : ''
                    const desc = event.description
                      ? `. Description: ${event.description.replace(/\s+/g, ' ').slice(0, 300)}`
                      : ''
                    onInjectChat(`Tell me about this calendar event: "${event.summary}" on ${startStr}${endStr}${loc}${attendees}${desc}`)
                  }}
                  onDelete={() => setDeleteConfirm({
                    id: event.id,
                    summary: event.summary ?? '(untitled)',
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
        aria-label={`Event: ${event.summary} at ${startTime}`}
      >
        <span className={styles.calendarTimeBadge}>{startTime}</span>
        <div className={styles.calendarDetails}>
          <div className={styles.calendarSummary}>{event.summary}</div>
          {(event as any).location && (
            <div className={styles.calendarMeta}>{(event as any).location}</div>
          )}
        </div>
      </button>

      {/* Delete button — shown on hover */}
      <button
        className={styles.calRowDeleteBtn}
        onClick={(e) => { e.stopPropagation(); onDelete() }}
        aria-label={`Delete event: ${event.summary}`}
        title="Delete event"
      >
        🗑
      </button>
    </div>
  )
}

