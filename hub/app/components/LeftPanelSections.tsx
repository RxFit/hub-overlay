'use client'

import { useState, useEffect, ReactNode, useCallback } from 'react'
import { useTasks, useCalendar, useDrive } from '@/app/hooks/useHubData'
import type { TaskItem, CalendarEvent, DriveFile } from '@/app/hooks/useHubData'
import { useKPIData } from '@/app/hooks/useKPIData'
import type { LiveKPI, ProjectKPI, ToolArtifactRecord, ChatAttachment } from '@/types'
import { AnimatedNumber } from './AnimatedNumber'
import useSWR from 'swr'

/* ══════════════════════════════════════════════════════════════════════════════
   SKELETON — shared loading placeholder
   ══════════════════════════════════════════════════════════════════════════════ */

function SkeletonLine({ width = '100%', height = '14px' }: { width?: string; height?: string }) {
  return (
    <div
      aria-hidden="true"
      className="lps-skeleton-line"
      style={{ width, height }}
    />
  )
}

function SkeletonBlock({ lines = 3 }: { lines?: number }) {
  return (
    <div className="lps-skeleton-block" aria-label="Loading" role="status">
      {Array.from({ length: lines }).map((_, i) => (
        <SkeletonLine key={i} width={`${85 - i * 12}%`} />
      ))}
    </div>
  )
}

/* ══════════════════════════════════════════════════════════════════════════════
   ERROR MESSAGE — shared error/empty fallback
   ══════════════════════════════════════════════════════════════════════════════ */

function SectionMessage({ message, type = 'info' }: { message: string; type?: 'info' | 'error' | 'empty' }) {
  return (
    <div
      role={type === 'error' ? 'alert' : 'status'}
      className={`section-message section-message--${type}`}
    >
      {message}
    </div>
  )
}

/* ══════════════════════════════════════════════════════════════════════════════
   COLLAPSIBLE SECTION — reusable wrapper with animated open/close
   ══════════════════════════════════════════════════════════════════════════════ */

export function CollapsibleSection({
  title,
  protocolNum,
  defaultOpen = true,
  children,
}: {
  title: string
  protocolNum: string
  defaultOpen?: boolean
  children: ReactNode
}) {
  const [isOpen, setIsOpen] = useState(defaultOpen)

  return (
    <section aria-label={title}>
      <button
        onClick={() => setIsOpen(!isOpen)}
        aria-expanded={isOpen}
        aria-controls={`section-${protocolNum}`}
        className="collapsible-header"
      >
        {/* Arrow indicator */}
        <span
          aria-hidden="true"
          className={`collapsible-header__arrow${isOpen ? ' collapsible-header__arrow--open' : ''}`}
        >
          ▶
        </span>

        {/* Protocol number */}
        <span className="rx-comment-label">{protocolNum} //</span>

        {/* Title */}
        <span className="collapsible-header__title">
          {title}
        </span>

        {/* Line */}
        <span
          aria-hidden="true"
          className="collapsible-header__line"
        />
      </button>

      <div
        id={`section-${protocolNum}`}
        role="region"
        aria-label={title}
        className={`collapsible-body ${isOpen ? 'collapsible-body--open' : 'collapsible-body--closed'}`}
      >
        {children}
      </div>
    </section>
  )
}

/* ══════════════════════════════════════════════════════════════════════════════
   TASKS SECTION
   ══════════════════════════════════════════════════════════════════════════════ */

export function TasksSection({ onInjectChat }: { onInjectChat: (msg: string) => void }) {
  const { taskLists, tasksByList, isLoading, error, mutate } = useTasks()
  const [activeListId, setActiveListId] = useState<string | null>(null)

  // Auto-select first list once loaded
  const firstListId = taskLists[0]?.id ?? null
  const resolvedListId = activeListId ?? firstListId

  // Local optimistic state: task IDs that are being toggled
  const [togglingIds, setTogglingIds] = useState<Set<string>>(new Set())
  // IDs that have been completed and are fading out
  const [fadingIds, setFadingIds] = useState<Set<string>>(new Set())
  // IDs to hide from the list (after fade completes)
  const [hiddenIds, setHiddenIds] = useState<Set<string>>(new Set())

  // Clear all optimistic state when switching lists — prevents hidden/fading
  // tasks from one list bleeding into another tab's view
  useEffect(() => {
    setFadingIds(new Set())
    setHiddenIds(new Set())
    setTogglingIds(new Set())
  }, [resolvedListId])

  if (isLoading) {
    return (
      <CollapsibleSection title="Tasks" protocolNum="03" defaultOpen>
        <SkeletonBlock lines={4} />
      </CollapsibleSection>
    )
  }

  const isAuthError = error && (error as any)?.status === 401
  if (isAuthError) {
    return (
      <CollapsibleSection title="Tasks" protocolNum="03" defaultOpen>
        <SectionMessage message="Session expired — please sign in again" type="error" />
      </CollapsibleSection>
    )
  }

  if (error) {
    return (
      <CollapsibleSection title="Tasks" protocolNum="03" defaultOpen>
        <SectionMessage message="Unable to load tasks — try refreshing" type="error" />
      </CollapsibleSection>
    )
  }

  const currentTasks = resolvedListId ? (tasksByList[resolvedListId] ?? []) : []
  const visibleTasks = currentTasks.filter(t => !hiddenIds.has(t.id))

  async function handleToggleTask(task: TaskItem, listId: string) {
    if (togglingIds.has(task.id)) return
    const wasCompleted = task.status === 'completed'
    const newAction = wasCompleted ? 'uncomplete' : 'complete'

    if (!wasCompleted) {
      // Mark as fading immediately for optimistic UX
      setFadingIds(prev => new Set(prev).add(task.id))
      setTimeout(() => {
        setHiddenIds(prev => new Set(prev).add(task.id))
        setFadingIds(prev => { const s = new Set(prev); s.delete(task.id); return s })
      }, 1500)
    }

    setTogglingIds(prev => new Set(prev).add(task.id))
    try {
      await fetch('/api/google/tasks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: newAction, taskListId: listId, taskId: task.id }),
      })
      mutate?.()
    } catch {
      // Rollback on error
      setFadingIds(prev => { const s = new Set(prev); s.delete(task.id); return s })
      setHiddenIds(prev => { const s = new Set(prev); s.delete(task.id); return s })
    } finally {
      setTogglingIds(prev => { const s = new Set(prev); s.delete(task.id); return s })
    }
  }

  const activeListName = taskLists.find(l => l.id === resolvedListId)?.title ?? 'Tasks'

  return (
    <CollapsibleSection title="Tasks" protocolNum="03" defaultOpen>
      {/* List tab strip */}
      {taskLists.length > 1 && (
        <div className="doc-filter-tabs" role="tablist" aria-label="Task lists" style={{ marginBottom: '6px' }}>
          {taskLists.map(list => (
            <button
              key={list.id}
              role="tab"
              aria-selected={resolvedListId === list.id}
              className={`feed-filter-btn${resolvedListId === list.id ? ' active' : ''}`}
              onClick={() => setActiveListId(list.id)}
              title={list.title}
            >
              {list.title.length > 9 ? list.title.slice(0, 8) + '…' : list.title}
            </button>
          ))}
        </div>
      )}

      {/* Task list */}
      {visibleTasks.length === 0 ? (
        <SectionMessage message={`No pending tasks in ${activeListName}`} type="empty" />
      ) : (
        <div role="list" aria-label={`${activeListName} tasks`}>
          {visibleTasks.map(task => (
            <TaskRow
              key={task.id}
              task={task}
              isFading={fadingIds.has(task.id)}
              isToggling={togglingIds.has(task.id)}
              onToggle={() => resolvedListId && handleToggleTask(task, resolvedListId)}
              onInjectChat={() => onInjectChat(buildTaskInjectMessage(task, activeListName))}
            />
          ))}
        </div>
      )}

      {/* FAB: open AI chat to create a task */}
      <button
        className="tasks-fab"
        onClick={() => onInjectChat(`I want to create a new task in my ${activeListName} list`)}
        aria-label={`Create task in ${activeListName}`}
        title={`Create task in ${activeListName}`}
      >
        + Task
      </button>
    </CollapsibleSection>
  )
}

function TaskRow({
  task,
  isFading,
  isToggling,
  onToggle,
  onInjectChat,
}: {
  task: TaskItem
  isFading: boolean
  isToggling: boolean
  onToggle: () => void
  onInjectChat: () => void
}) {
  const dueDate = task.due ? formatRelativeDate(task.due) : null
  const isCompleted = task.status === 'completed'

  return (
    <div
      role="listitem"
      className={`section-row task-row ${isFading ? 'task-row--fading' : ''}`}
      style={{ display: 'flex', alignItems: 'center', gap: '8px', cursor: 'default' }}
    >
      {/* Interactive checkbox */}
      <button
        onClick={(e) => { e.stopPropagation(); onToggle() }}
        disabled={isToggling}
        aria-label={isCompleted ? 'Mark incomplete' : 'Mark complete'}
        aria-pressed={isCompleted}
        className={`task-checkbox task-checkbox--btn ${isCompleted ? 'task-checkbox--completed' : 'task-checkbox--pending'} ${isToggling ? 'task-checkbox--toggling' : ''}`}
      >
        {isCompleted && '✓'}
      </button>

      {/* Content — click to inject into chat */}
      <div
        className="task-content"
        onClick={onInjectChat}
        style={{ flex: 1, cursor: 'pointer', minWidth: 0 }}
      >
        <div className={`task-title ${isCompleted || isFading ? 'task-title--completed' : 'task-title--pending'}`}>
          {task.title}
        </div>
        {dueDate && (
          <div className="task-due">Due {dueDate}</div>
        )}
      </div>

      {/* Status dot */}
      <span
        aria-hidden="true"
        className={`task-status-dot ${isCompleted ? 'task-status-dot--completed' : 'task-status-dot--pending'}`}
      />
    </div>
  )
}

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
        className="cal-event-modal-backdrop"
        onClick={onClose}
        aria-hidden="true"
      />
      {/* Modal */}
      <div
        className="cal-event-modal"
        role="dialog"
        aria-modal="true"
        aria-label="Create calendar event"
      >
        <div className="cal-event-modal__header">
          <h3 className="cal-event-modal__title">New Event</h3>
          <button className="cal-event-modal__close" onClick={onClose} aria-label="Close">✕</button>
        </div>

        <form onSubmit={handleSave} className="cal-event-form">
          {/* Title */}
          <div className="cal-event-form__field">
            <label className="cal-event-form__label" htmlFor="cal-event-title">Title *</label>
            <input
              id="cal-event-title"
              type="text"
              className="cal-event-form__input"
              value={title}
              onChange={e => setTitle(e.target.value)}
              placeholder="Event title"
              required
              autoFocus
            />
          </div>

          {/* Date + Times row */}
          <div className="cal-event-form__row">
            <div className="cal-event-form__field">
              <label className="cal-event-form__label" htmlFor="cal-event-date">Date *</label>
              <input
                id="cal-event-date"
                type="date"
                className="cal-event-form__input"
                value={date}
                onChange={e => setDate(e.target.value)}
                required
              />
            </div>
            <div className="cal-event-form__field">
              <label className="cal-event-form__label" htmlFor="cal-event-start">Start</label>
              <input
                id="cal-event-start"
                type="time"
                className="cal-event-form__input"
                value={startTime}
                onChange={e => setStartTime(e.target.value)}
              />
            </div>
            <div className="cal-event-form__field">
              <label className="cal-event-form__label" htmlFor="cal-event-end">End</label>
              <input
                id="cal-event-end"
                type="time"
                className="cal-event-form__input"
                value={endTime}
                onChange={e => setEndTime(e.target.value)}
              />
            </div>
          </div>

          {/* Attendees */}
          <div className="cal-event-form__field">
            <label className="cal-event-form__label" htmlFor="cal-event-attendees">Attendees</label>
            <input
              id="cal-event-attendees"
              type="text"
              className="cal-event-form__input"
              value={attendees}
              onChange={e => setAttendees(e.target.value)}
              placeholder="email@example.com, ..."
            />
          </div>

          {/* Location */}
          <div className="cal-event-form__field">
            <label className="cal-event-form__label" htmlFor="cal-event-location">Location</label>
            <input
              id="cal-event-location"
              type="text"
              className="cal-event-form__input"
              value={location}
              onChange={e => setLocation(e.target.value)}
              placeholder="Address or Google Meet link"
            />
          </div>

          {/* Description */}
          <div className="cal-event-form__field">
            <label className="cal-event-form__label" htmlFor="cal-event-desc">Description</label>
            <textarea
              id="cal-event-desc"
              className="cal-event-form__input cal-event-form__textarea"
              value={description}
              onChange={e => setDescription(e.target.value)}
              placeholder="Optional notes"
              rows={2}
            />
          </div>

          {error && (
            <div className="cal-event-form__error" role="alert">{error}</div>
          )}

          <div className="cal-event-form__actions">
            <button
              type="button"
              className="cal-event-form__btn cal-event-form__btn--cancel"
              onClick={onClose}
            >
              Cancel
            </button>
            <button
              type="submit"
              className="cal-event-form__btn cal-event-form__btn--save"
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
            className="cal-create-btn"
            onClick={() => setShowCreateModal(true)}
            aria-label="Create calendar event"
          >
            + Event
          </button>
        </div>

        {/* Week navigation */}
        <div className="calendar-week-nav">
          <button
            aria-label="Previous week"
            className="calendar-week-nav__btn"
            onClick={() => {
              const prev = new Date(weekStart)
              prev.setDate(prev.getDate() - 7)
              setWeekStart(prev)
            }}
          >
            ‹
          </button>
          <span className="calendar-week-nav__label">
            {weekStart.toLocaleDateString([], { month: 'short', day: 'numeric' })} – {weekDays[6].toLocaleDateString([], { month: 'short', day: 'numeric' })}
          </span>
          <button
            aria-label="Next week"
            className="calendar-week-nav__btn"
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
        <div className="calendar-week-strip" role="listbox" aria-label="Week days">
          {weekDays.map((day) => {
            const dayStr = day.toDateString()
            const isToday = dayStr === today.toDateString()
            const isSelected = dayStr === selectedDateStr
            const hasEvents = daysWithEvents.has(dayStr)
            const dayLetter = DAY_LETTERS[day.getDay()]

            const classNames = [
              'calendar-day-cell',
              isToday ? 'calendar-day-cell--today' : '',
              isSelected ? 'calendar-day-cell--selected' : '',
              hasEvents ? 'calendar-day-cell--has-events' : '',
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
                <span className="calendar-day-cell__letter">{dayLetter}</span>
                <span className="calendar-day-cell__number">{day.getDate()}</span>
                {hasEvents && <span className="calendar-day-cell__dot" aria-hidden="true" />}
              </button>
            )
          })}
        </div>

        {/* Day detail */}
        <div className="calendar-day-detail" aria-label={`Events for ${dayName}`}>
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
                    summary: event.summary,
                    // calendarId is left undefined — server defaults to 'primary'
                    // (organizer.email is NOT the calendar ID)
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
          <div className="cal-event-modal-backdrop" onClick={() => setDeleteConfirm(null)} aria-hidden="true" />
          <div className="cal-event-modal cal-delete-dialog" role="alertdialog" aria-modal="true" aria-label="Confirm event deletion">
            <div className="cal-event-modal__header">
              <h3 className="cal-event-modal__title">Delete Event?</h3>
              <button className="cal-event-modal__close" onClick={() => setDeleteConfirm(null)} aria-label="Cancel">✕</button>
            </div>
            <div style={{ padding: '16px 20px' }}>
              <p style={{ color: 'var(--text-secondary)', fontSize: '0.85rem', margin: '0 0 16px' }}>
                Are you sure you want to delete <strong style={{ color: 'var(--text-primary)' }}>&quot;{deleteConfirm.summary}&quot;</strong>? This cannot be undone.
              </p>
              <div className="cal-event-form__actions">
                <button
                  className="cal-event-form__btn cal-event-form__btn--cancel"
                  onClick={() => setDeleteConfirm(null)}
                >
                  Cancel
                </button>
                <button
                  className="cal-event-form__btn cal-event-form__btn--delete"
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

/** Day letter labels indexed by JS getDay() (0=Sun) */
const DAY_LETTERS = ['S', 'M', 'T', 'W', 'T', 'F', 'S']

/** Get Monday of the week containing the given date */
function getMonday(d: Date): Date {
  const date = new Date(d)
  date.setHours(0, 0, 0, 0)
  const day = date.getDay()
  // getDay() returns 0 for Sunday — shift back to Monday
  const diff = day === 0 ? -6 : 1 - day
  date.setDate(date.getDate() + diff)
  return date
}

/** Get all 7 days of a week starting from Monday */
function getWeekDays(monday: Date): Date[] {
  return Array.from({ length: 7 }, (_, i) => {
    const d = new Date(monday)
    d.setDate(monday.getDate() + i)
    return d
  })
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
      className="section-row section-row--calendar cal-event-row"
      style={{ display: 'flex', alignItems: 'center' }}
    >
      {/* Time badge + event details — clickable for AI inject */}
      <button
        onClick={onClick}
        className="cal-event-row__main"
        aria-label={`Event: ${event.summary} at ${startTime}`}
      >
        <span className="calendar-time-badge">{startTime}</span>
        <div className="calendar-details">
          <div className="calendar-summary">{event.summary}</div>
          {(event as any).location && (
            <div className="calendar-meta">{(event as any).location}</div>
          )}
        </div>
      </button>

      {/* Delete button — shown on hover */}
      <button
        className="cal-row-delete-btn"
        onClick={(e) => { e.stopPropagation(); onDelete() }}
        aria-label={`Delete event: ${event.summary}`}
        title="Delete event"
      >
        🗑
      </button>
    </div>
  )
}

/* ══════════════════════════════════════════════════════════════════════════════
   DOCUMENTS SECTION
   ══════════════════════════════════════════════════════════════════════════════ */

type DocFilter = 'recent' | 'shared' | 'artifacts' | 'transcripts'
const DOC_FILTERS: { key: DocFilter; label: string }[] = [
  { key: 'recent', label: 'Recent' },
  { key: 'shared', label: 'Shared' },
  { key: 'artifacts', label: 'Artifacts' },
  { key: 'transcripts', label: 'Transcripts' },
]

export function DocumentsSection({ onInjectChat }: { onInjectChat: (msg: string, attachments?: ChatAttachment[]) => void }) {
  const [activeFilter, setActiveFilter] = useState<DocFilter>('recent')
  const { files, isLoading, error } = useDrive(activeFilter === 'artifacts' ? 'recent' : activeFilter)
  
  /* Fetch tool artifacts when artifacts tab is active */
  const { data: artifactsData, isLoading: artifactsLoading, error: artifactsError } = useSWR<{ artifacts: ToolArtifactRecord[] }>(
    activeFilter === 'artifacts' ? '/api/tool-artifacts' : null,
    (url: string) => fetch(url).then(r => r.json()),
    { revalidateOnFocus: false }
  )

  const isAuthError = error && (error as any)?.status === 401

  const emptyMessages: Record<DocFilter, string> = {
    recent: 'No recent files',
    shared: 'No shared files',
    artifacts: 'No saved artifacts — complete a tool session to create one',
    transcripts: 'No transcripts found',
  }

  /* Tool icon mapping for artifact cards */
  const getToolIcon = (toolId: string): string => {
    const icons: Record<string, string> = {
      'issue-tree': '🌳', 'decision-memo': '📋', 'prioritization': '📊',
      'data-insights': '📈', 'meeting-prep': '🤝', 'storyline': '📖',
      'scpr': '🔄', 'mckinsey-critic': '🔍', 'ai-use-case-scorer': '🤖',
      'deck-pipeline': '📑', 'gamma-deck': '🎨',
    }
    return icons[toolId] || '⚡'
  }

  return (
    <CollapsibleSection title="Documents" protocolNum="04" defaultOpen={false}>
      {/* Filter tabs */}
      <div className="doc-filter-tabs" role="tablist" aria-label="Document filters">
        {DOC_FILTERS.map((f) => (
          <button
            key={f.key}
            role="tab"
            aria-selected={activeFilter === f.key}
            className={`feed-filter-btn${activeFilter === f.key ? ' active' : ''}`}
            onClick={() => setActiveFilter(f.key)}
          >
            {f.label}
          </button>
        ))}
      </div>

      {/* Artifacts tab content */}
      {activeFilter === 'artifacts' ? (
        artifactsLoading ? (
          <SkeletonBlock lines={3} />
        ) : artifactsError ? (
          <SectionMessage message="Unable to load artifacts" type="error" />
        ) : !artifactsData?.artifacts?.length ? (
          <SectionMessage message={emptyMessages.artifacts} type="empty" />
        ) : (
          <div role="list" aria-label="Saved tool artifacts">
            {artifactsData.artifacts.map((artifact) => (
              <button
                key={artifact.id}
                role="listitem"
                onClick={() => onInjectChat(`Show me the ${artifact.toolId} artifact: ${artifact.title}`)}
                aria-label={`Artifact: ${artifact.title}`}
                className="section-row"
              >
                <span aria-hidden="true" className="document-icon">
                  {getToolIcon(artifact.toolId)}
                </span>
                <div className="document-info">
                  <div className="document-name">{artifact.title}</div>
                  <div className="document-modified">
                    {artifact.toolId} · {new Date(artifact.createdAt).toLocaleDateString([], { month: 'short', day: 'numeric' })}
                  </div>
                </div>
              </button>
            ))}
          </div>
        )
      ) : (
        /* Existing Drive file content */
        <>
          {isLoading ? (
            <SkeletonBlock lines={3} />
          ) : isAuthError ? (
            <SectionMessage message="Session expired — please sign in again" type="error" />
          ) : error ? (
            <SectionMessage message="Unable to load files — try refreshing or check your connection" type="error" />
          ) : files.length === 0 ? (
            <SectionMessage message={emptyMessages[activeFilter]} type="empty" />
          ) : (
            <div role="list" aria-label={`${activeFilter} documents`}>
              {files.map((file) => (
                <DocumentRow
                  key={file.id}
                  file={file}
                  onClick={() => {
                    const msg = activeFilter === 'transcripts'
                      ? `Summarize the meeting transcript "${file.name}" using its attached content.`
                      : `Tell me about the document "${file.name}" using its attached content.`
                    // Attach the real Drive file so the chat route resolves the
                    // document's actual content (Vertex semantic search → Drive
                    // export) instead of answering from just the file name.
                    const attachment: ChatAttachment = {
                      id: file.id,
                      type: 'document',
                      label: file.name,
                      fileId: file.id,
                      mimeType: file.mimeType,
                    }
                    onInjectChat(msg, [attachment])
                  }}
                />
              ))}
            </div>
          )}
        </>
      )}
    </CollapsibleSection>
  )
}

function DocumentRow({ file, onClick }: { file: DriveFile; onClick: () => void }) {
  const icon = getDriveIcon(file.mimeType)
  const modified = formatRelativeDate(file.modifiedTime)

  return (
    <button
      role="listitem"
      onClick={onClick}
      aria-label={`Document: ${file.name}, modified ${modified}`}
      className="section-row"
    >
      {/* File type icon */}
      <span aria-hidden="true" className="document-icon">
        {icon}
      </span>

      {/* File info */}
      <div className="document-info">
        <div className="document-name">
          {file.name}
        </div>
        <div className="document-modified">
          {modified}
        </div>
      </div>
    </button>
  )
}

/* ══════════════════════════════════════════════════════════════════════════════
   KPI SECTION — Live Paperclip + Business KPIs
   ══════════════════════════════════════════════════════════════════════════════ */

export function KPISection({
  activeProject,
  onInjectChat,
}: {
  activeProject?: string
  onInjectChat: (msg: string) => void
}) {
  const { kpis: allKpis, isLoading } = useKPIData(activeProject)

  // Mandate: Left Panel = Google ecosystem + business metrics only.
  // Paperclip orchestration metrics belong on the Right Panel.
  const kpis = allKpis.filter(kpi => kpi.source !== 'paperclip')

  if (isLoading) {
    return (
      <CollapsibleSection title="KPIs" protocolNum="01" defaultOpen>
        <SkeletonBlock lines={4} />
      </CollapsibleSection>
    )
  }

  if (kpis.length === 0) {
    return (
      <CollapsibleSection title="KPIs" protocolNum="01" defaultOpen>
        <SectionMessage message="No business KPIs configured — configure KPIs in Settings" type="empty" />
      </CollapsibleSection>
    )
  }

  return (
    <CollapsibleSection title="Business KPIs" protocolNum="01" defaultOpen>
      <div className="kpi-grid" role="list" aria-label="Business KPIs">
        {kpis.map((kpi: LiveKPI, i: number) => {
          const trendClass =
            kpi.trendDirection === 'up'
              ? 'kpi-trend-up'
              : kpi.trendDirection === 'down'
                ? 'kpi-trend-down'
                : 'kpi-trend-neutral'

          return (
            <button
              key={kpi.id}
              className="kpi-card kpi-card--clickable"
              role="listitem"
              onClick={() => onInjectChat(`Tell me more about KPI: ${kpi.label}`)}
              aria-label={`${kpi.label}: ${kpi.value}, trend ${kpi.trend}`}
            >
              <div className="kpi-label">
                {kpi.label}
              </div>
              <div className="kpi-value">
                <AnimatedNumber value={String(kpi.value)} delay={i * 120} />
              </div>
              <div
                className={`kpi-trend ${trendClass}`}
                aria-label={`Trend: ${kpi.trendDirection} ${kpi.trend}`}
              >
                <span aria-hidden="true" className="rx-star">✦</span> {kpi.trend}
              </div>
            </button>
          )
        })}
      </div>
    </CollapsibleSection>
  )
}

/* ══════════════════════════════════════════════════════════════════════════════
   PROJECT HEALTH SECTION — Live Paperclip data
   ══════════════════════════════════════════════════════════════════════════════ */

const HEALTH_COLORS: Record<string, string> = {
  healthy: 'var(--accent)',
  'at-risk': 'var(--warn)',
  critical: 'var(--danger)',
}

export function ProjectHealthSection({
  projects,
  onInjectChat,
  userRole,
  isLoading,
}: {
  projects?: ProjectKPI[]
  onInjectChat: (msg: string) => void
  userRole?: string
  isLoading?: boolean
}) {
  if (isLoading) {
    return (
      <CollapsibleSection title="Project Health" protocolNum="05" defaultOpen>
        <div className="lps-skeleton-block" aria-label="Loading project health" role="status">
          {[1, 2, 3].map(i => (
            <div key={i} className="lps-skeleton-line" style={{ width: `${85 - i * 10}%`, height: '38px', marginBottom: '6px', borderRadius: '8px' }} />
          ))}
        </div>
      </CollapsibleSection>
    )
  }

  if (!projects || projects.length === 0) {
    const emptyMsg =
      userRole === 'superadmin' || userRole === 'admin'
        ? 'No companies in Paperclip yet.'
        : userRole === 'staff'
          ? 'No projects assigned — contact your admin to get access.'
          : 'No project data'
    return (
      <CollapsibleSection title="Project Health" protocolNum="05" defaultOpen>
        <SectionMessage message={emptyMsg} type="empty" />
      </CollapsibleSection>
    )
  }

  return (
    <CollapsibleSection title="Project Health" protocolNum="05" defaultOpen>
      <div className="project-health-list" role="list" aria-label="Project health status">
        {projects.map((p) => {
          const statusColor = HEALTH_COLORS[p.health] ?? 'var(--text-muted)'
          const abbr = (p.identifier ?? p.companyName ?? '??').slice(0, 3).toUpperCase()
          return (
            <div
              key={p.companyId}
              role="listitem"
              tabIndex={0}
              aria-label={`${p.companyName}: ${p.health}`}
              className={`project-health-item project-health-item--live`}
              onClick={() => onInjectChat(`Show me the health status for ${p.companyName}`)}
              onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onInjectChat(`Show me the health status for ${p.companyName}`) } }}
            >
              <span
                aria-hidden="true"
                className="project-health-badge"
                style={{
                  background: `${statusColor}1a`,
                  border: `1px solid ${statusColor}44`,
                  color: statusColor,
                }}
              >
                {abbr}
              </span>
              <span className="project-health-name">{p.companyName}</span>
              <span className="project-health-stats">
                {p.openIssues} open · {p.completionRate}%
              </span>
              <span
                aria-hidden="true"
                className="project-status-pulse project-health-status-dot"
                style={{
                  background: statusColor,
                  boxShadow: `0 0 6px ${statusColor}`,
                }}
              />
            </div>
          )
        })}
      </div>
    </CollapsibleSection>
  )
}

/* ══════════════════════════════════════════════════════════════════════════════
   UTILITY FUNCTIONS
   ══════════════════════════════════════════════════════════════════════════════ */

/**
 * Build a context-rich chat message for a tapped task. Carries the task's list,
 * due date, status, and notes inline so the assistant can answer about THIS task
 * even when it falls outside the live Google Workspace snapshot window the chat
 * route fetches (pending-only, first 5 lists).
 */
function buildTaskInjectMessage(task: TaskItem, listName: string): string {
  const lines = [
    `Tell me about this task from my "${listName}" list:`,
    `• Title: ${task.title}`,
    `• Status: ${task.status === 'completed' ? 'Completed' : 'Pending'}`,
  ]
  if (task.due) lines.push(`• Due: ${formatRelativeDate(task.due)}`)
  if (task.notes) lines.push(`• Notes: ${task.notes.replace(/\s+/g, ' ').slice(0, 500)}`)
  return lines.join('\n')
}

/**
 * Build a context-rich chat message for a tapped calendar event. Carries the
 * date/time, location, and description inline so the assistant has the event's
 * real details regardless of the snapshot window.
 */
function buildEventInjectMessage(event: CalendarEvent): string {
  const when = event.start.dateTime
    ? `${formatShortDate(event.start.dateTime)} at ${formatTime(event.start.dateTime)}`
    : event.start.date
      ? `${formatShortDate(event.start.date + 'T00:00:00')} (all day)`
      : 'unscheduled'
  const lines = [
    `Tell me about this calendar event:`,
    `• Title: ${event.summary || '(untitled)'}`,
    `• When: ${when}`,
  ]
  if (event.location) lines.push(`• Location: ${event.location}`)
  if (event.description) lines.push(`• Details: ${event.description.replace(/\s+/g, ' ').slice(0, 500)}`)
  return lines.join('\n')
}

function formatTime(isoString: string): string {
  try {
    const d = new Date(isoString)
    return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
  } catch {
    return isoString
  }
}

function formatShortDate(isoString: string): string {
  try {
    const d = new Date(isoString)
    const now = new Date()
    const isToday = d.toDateString() === now.toDateString()
    const tomorrow = new Date(now)
    tomorrow.setDate(tomorrow.getDate() + 1)
    const isTomorrow = d.toDateString() === tomorrow.toDateString()

    if (isToday) return 'Today'
    if (isTomorrow) return 'Tomorrow'
    return d.toLocaleDateString([], { month: 'short', day: 'numeric' })
  } catch {
    return isoString
  }
}

function formatRelativeDate(isoString: string): string {
  try {
    const d = new Date(isoString)
    const now = new Date()
    const diffMs = now.getTime() - d.getTime()
    const diffMins = Math.floor(diffMs / 60_000)
    const diffHours = Math.floor(diffMs / 3_600_000)
    const diffDays = Math.floor(diffMs / 86_400_000)

    if (diffMins < 1) return 'just now'
    if (diffMins < 60) return `${diffMins}m ago`
    if (diffHours < 24) return `${diffHours}h ago`
    if (diffDays < 7) return `${diffDays}d ago`
    return d.toLocaleDateString([], { month: 'short', day: 'numeric' })
  } catch {
    return isoString
  }
}

function getDriveIcon(mimeType: string): string {
  if (mimeType.includes('spreadsheet') || mimeType.includes('excel')) return '📊'
  if (mimeType.includes('document') || mimeType.includes('word')) return '📄'
  if (mimeType.includes('presentation') || mimeType.includes('powerpoint')) return '📑'
  if (mimeType.includes('pdf')) return '📕'
  if (mimeType.includes('image')) return '🖼️'
  if (mimeType.includes('video')) return '🎬'
  if (mimeType.includes('audio')) return '🎵'
  if (mimeType.includes('folder')) return '📁'
  if (mimeType.includes('form')) return '📋'
  return '📄'
}
