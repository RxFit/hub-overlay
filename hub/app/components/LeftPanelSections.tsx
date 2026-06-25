'use client'

import { useState, useEffect, useRef, ReactNode, useMemo, memo, Component } from 'react'
import type { ErrorInfo } from 'react'
import { useModalA11y } from '@/app/hooks/useModalA11y'
import { signIn } from 'next-auth/react'
import { useTasks, useCalendar, useDrive } from '@/app/hooks/useHubData'
import { writeFetch } from '@/app/hooks/useWriteFetch'
import type { TaskItem, CalendarEvent, DriveFile } from '@/app/hooks/useHubData'
import type { LiveKPI, ProjectKPI, ToolArtifactRecord, ChatAttachment } from '@/types'
import { AnimatedNumber } from './AnimatedNumber'
import {
  buildTaskInjectMessage,
  buildEventInjectMessage,
  buildDocumentInject,
  buildArtifactInject,
  formatTime,
  formatShortDate,
  formatRelativeDate,
  formatDueDate,
} from '@/lib/panel-inject'
import useSWR from 'swr'

/**
 * SWR fetcher for the Documents Artifacts tab. Throws a status-tagged error on
 * !res.ok so a 401/500 surfaces as an auth/error state instead of "empty".
 */
export async function artifactsFetcher(url: string) {
  const r = await fetch(url)
  if (!r.ok) {
    const body = await r.json().catch(() => ({}))
    const err = new Error(body.error || `API error ${r.status}`)
    ;(err as any).status = r.status
    throw err
  }
  return r.json()
}

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

function SectionMessage({
  message,
  type = 'info',
  action,
}: {
  message: string
  type?: 'info' | 'error' | 'empty'
  action?: { label: string; onClick: () => void }
}) {
  return (
    <div
      role={type === 'error' ? 'alert' : 'status'}
      className={`section-message section-message--${type}`}
    >
      <span>{message}</span>
      {action && (
        <button
          type="button"
          className="section-message__action"
          onClick={action.onClick}
        >
          {action.label}
        </button>
      )}
    </div>
  )
}

/* ══════════════════════════════════════════════════════════════════════════════
   ERROR BOUNDARY — contains a render throw to a single section
   ══════════════════════════════════════════════════════════════════════════════ */

export class SectionErrorBoundary extends Component<
  { label?: string; children: ReactNode },
  { hasError: boolean }
> {
  state = { hasError: false }

  static getDerivedStateFromError(): { hasError: boolean } {
    return { hasError: true }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // Surface in dev / wire to telemetry later; do not rethrow.
    console.error('[SectionErrorBoundary]', this.props.label ?? '', error, info)
  }

  render() {
    if (this.state.hasError) {
      return (
        <SectionMessage
          message={`Unable to display ${this.props.label ?? 'this section'} — try refreshing`}
          type="error"
        />
      )
    }
    return this.props.children
  }
}

/**
 * Shared loading / auth-error / error renderer for Left Panel sections.
 * Returns the element to render, or null when there is no blocking state
 * (i.e. the section should render its real content).
 *
 *   const state = renderSectionState({ isLoading, error, skeletonLines: 4 })
 *   if (state) return <CollapsibleSection ...>{state}</CollapsibleSection>
 */
function renderSectionState({
  isLoading,
  error,
  skeletonLines = 3,
  onRetry,
}: {
  isLoading?: boolean
  error?: unknown
  skeletonLines?: number
  onRetry?: () => void
}): ReactNode | null {
  if (isLoading) return <SkeletonBlock lines={skeletonLines} />

  if (error) {
    const isAuthError = (error as any)?.status === 401
    if (isAuthError) {
      return (
        <SectionMessage
          message="Session expired — please sign in again"
          type="error"
          action={{ label: 'Sign in again', onClick: () => signIn('google') }}
        />
      )
    }
    return (
      <SectionMessage
        message="Something went wrong — try refreshing"
        type="error"
        action={onRetry ? { label: 'Retry', onClick: onRetry } : undefined}
      />
    )
  }

  return null
}

/* ══════════════════════════════════════════════════════════════════════════════
   COLLAPSIBLE SECTION — reusable wrapper with animated open/close
   ══════════════════════════════════════════════════════════════════════════════ */

/**
 * Children may be a plain node or a render-prop `(isOpen) => node`. The
 * render-prop form lets a section's data hook gate its polling on open-state
 * (see Plan 05): the hook still runs unconditionally inside the child body, but
 * its `refreshInterval` is set to 0 while collapsed so an invisible section
 * stops spending quota.
 */
type CollapsibleChild = ReactNode | ((isOpen: boolean) => ReactNode)

export function CollapsibleSection({
  title,
  protocolNum,
  defaultOpen = true,
  children,
}: {
  title: string
  protocolNum: string
  defaultOpen?: boolean
  children: CollapsibleChild
}) {
  const [isOpen, setIsOpen] = useState(defaultOpen)
  const body = typeof children === 'function' ? children(isOpen) : children

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
        <h3 className="collapsible-header__title" style={{ margin: 0, font: 'inherit' }}>
          {title}
        </h3>

        {/* Line */}
        <span
          aria-hidden="true"
          className="collapsible-header__line"
        />
      </button>

      <div
        id={`section-${protocolNum}`}
        className={`collapsible-body ${isOpen ? 'collapsible-body--open' : 'collapsible-body--closed'}`}
      >
        {body}
      </div>
    </section>
  )
}

/* ══════════════════════════════════════════════════════════════════════════════
   TASKS SECTION
   ══════════════════════════════════════════════════════════════════════════════ */

function TasksSectionImpl({ onInjectChat, onInjectAction }: { onInjectChat: (msg: string, attachments?: ChatAttachment[]) => void; onInjectAction: (msg: string, attachments?: ChatAttachment[]) => void }) {
  return (
    <CollapsibleSection title="Tasks" protocolNum="03" defaultOpen>
      {(isOpen) => <TasksSectionBody isOpen={isOpen} onInjectChat={onInjectChat} onInjectAction={onInjectAction} />}
    </CollapsibleSection>
  )
}

function TasksSectionBody({ isOpen, onInjectChat, onInjectAction }: { isOpen: boolean; onInjectChat: (msg: string, attachments?: ChatAttachment[]) => void; onInjectAction: (msg: string, attachments?: ChatAttachment[]) => void }) {
  const { taskLists, tasksByList, isLoading, error, mutate } = useTasks(isOpen)
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

  const visibleTasks = useMemo(() => {
    const current = resolvedListId ? (tasksByList[resolvedListId] ?? []) : []
    return current.filter(t => !hiddenIds.has(t.id))
  }, [resolvedListId, tasksByList, hiddenIds])

  const state = renderSectionState({ isLoading, error, skeletonLines: 4 })
  if (state) {
    return <>{state}</>
  }

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
      await writeFetch('/api/google/tasks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: newAction, taskListId: listId, taskId: task.id }),
      })
      mutate?.()
    } catch {
      // Rollback optimistic UI on ANY failure (HTTP error or network).
      // writeFetch already routed a 401 into signIn('google').
      setFadingIds(prev => { const s = new Set(prev); s.delete(task.id); return s })
      setHiddenIds(prev => { const s = new Set(prev); s.delete(task.id); return s })
    } finally {
      setTogglingIds(prev => { const s = new Set(prev); s.delete(task.id); return s })
    }
  }

  const activeListName = taskLists.find(l => l.id === resolvedListId)?.title ?? 'Tasks'

  return (
    <>
      {/* List tab strip */}
      {taskLists.length > 1 && (
        <div
          className="doc-filter-tabs"
          role="tablist"
          aria-label="Task lists"
          style={{ marginBottom: '6px' }}
          onKeyDown={(e) =>
            handleRovingKeydown(e, '[role="tab"]', (i) => setActiveListId(taskLists[i].id))
          }
        >
          {taskLists.map(list => (
            <button
              key={list.id}
              id={`task-tab-${list.id}`}
              role="tab"
              aria-selected={resolvedListId === list.id}
              aria-controls="task-tabpanel"
              tabIndex={resolvedListId === list.id ? 0 : -1}
              className={`feed-filter-btn${resolvedListId === list.id ? ' active' : ''}`}
              onClick={() => setActiveListId(list.id)}
              title={list.title}
            >
              {list.title.length > 9 ? list.title.slice(0, 8) + '…' : list.title}
            </button>
          ))}
        </div>
      )}

      {/* Task list (tab panel) */}
      <div
        id="task-tabpanel"
        role="tabpanel"
        aria-labelledby={resolvedListId ? `task-tab-${resolvedListId}` : undefined}
      >
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
      </div>

      {/* Injects a chat prompt — it does NOT create the task inline. Label it
          honestly so users don't expect an inline form. A real inline-create
          flow (action:'create' + createTask) is deferred — see plan note. */}
      <button
        className="tasks-fab"
        onClick={() => onInjectAction(`Add a task to my ${activeListName} list: `)}
        aria-label={`Ask AI to add a task to ${activeListName}`}
        title={`Ask AI to add a task to ${activeListName}`}
      >
        Ask AI to add a task
      </button>
    </>
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
  const dueDate = task.due ? formatDueDate(task.due) : null
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

      {/* Content — click/Enter/Space to inject into chat */}
      <button
        type="button"
        className="task-content"
        onClick={onInjectChat}
        style={{ flex: 1, minWidth: 0, cursor: 'pointer', textAlign: 'left', background: 'none', border: 0, padding: 0, font: 'inherit', color: 'inherit' }}
      >
        <div className={`task-title ${isCompleted || isFading ? 'task-title--completed' : 'task-title--pending'}`}>
          {task.title}
        </div>
        {dueDate && (
          <div className="task-due">Due {dueDate}</div>
        )}
      </button>

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
        className="cal-event-modal-backdrop"
        onClick={onClose}
        aria-hidden="true"
      />
      {/* Modal */}
      <div
        ref={dialogRef}
        tabIndex={-1}
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

function CalendarSectionImpl({ onInjectChat }: { onInjectChat: (msg: string, attachments?: ChatAttachment[]) => void }) {
  return (
    <CollapsibleSection title="Calendar" protocolNum="02" defaultOpen>
      {(isOpen) => <CalendarSectionBody isOpen={isOpen} onInjectChat={onInjectChat} />}
    </CollapsibleSection>
  )
}

function CalendarSectionBody({ isOpen, onInjectChat }: { isOpen: boolean; onInjectChat: (msg: string, attachments?: ChatAttachment[]) => void }) {
  const { events, isLoading, error, mutate } = useCalendar(isOpen)
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

  const state = renderSectionState({ isLoading, error, skeletonLines: 3 })
  if (state) {
    return <>{state}</>
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
        <div
          className="calendar-week-strip"
          role="listbox"
          aria-label="Week days"
          onKeyDown={(e) =>
            handleRovingKeydown(e, '[role="option"]', (i) => setSelectedDate(new Date(weekDays[i])))
          }
        >
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
                tabIndex={isSelected ? 0 : -1}
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
                    summary: event.summary || '(untitled)',
                    // Delete from the event's SOURCE calendar (tagged by the API
                    // route); falls back to 'primary' server-side if absent.
                    calendarId: event.calendarId,
                  })}
                />
              ))}
            </div>
          )}
        </div>

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
        <DeleteConfirmDialog
          summary={deleteConfirm.summary}
          error={deleteError}
          deleting={deleting}
          onCancel={() => setDeleteConfirm(null)}
          onConfirm={handleDeleteConfirm}
        />
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
        aria-label={`Event: ${event.summary || '(untitled)'} at ${startTime}`}
      >
        <span className="calendar-time-badge">{startTime}</span>
        <div className="calendar-details">
          <div className="calendar-summary">{event.summary || '(untitled)'}</div>
          {(event as any).location && (
            <div className="calendar-meta">{(event as any).location}</div>
          )}
        </div>
      </button>

      {/* Delete button — shown on hover */}
      <button
        className="cal-row-delete-btn"
        onClick={(e) => { e.stopPropagation(); onDelete() }}
        aria-label={`Delete event: ${event.summary || '(untitled)'}`}
        title="Delete event"
      >
        🗑
      </button>
    </div>
  )
}

function DeleteConfirmDialog({
  summary,
  error,
  deleting,
  onCancel,
  onConfirm,
}: {
  summary: string
  error: string | null
  deleting: boolean
  onCancel: () => void
  onConfirm: () => void
}) {
  const dialogRef = useRef<HTMLDivElement>(null)
  useModalA11y(dialogRef, onCancel)

  return (
    <>
      <div className="cal-event-modal-backdrop" onClick={onCancel} aria-hidden="true" />
      <div
        ref={dialogRef}
        tabIndex={-1}
        className="cal-event-modal cal-delete-dialog"
        role="alertdialog"
        aria-modal="true"
        aria-label="Confirm event deletion"
      >
        <div className="cal-event-modal__header">
          <h3 className="cal-event-modal__title">Delete Event?</h3>
          <button className="cal-event-modal__close" onClick={onCancel} aria-label="Cancel">✕</button>
        </div>
        <div style={{ padding: '16px 20px' }}>
          <p style={{ color: 'var(--text-secondary)', fontSize: '0.85rem', margin: '0 0 16px' }}>
            Are you sure you want to delete <strong style={{ color: 'var(--text-primary)' }}>&quot;{summary}&quot;</strong>? This cannot be undone.
          </p>
          {error && (
            <div className="cal-event-form__error" role="alert">{error}</div>
          )}
          <div className="cal-event-form__actions">
            <button className="cal-event-form__btn cal-event-form__btn--cancel" onClick={onCancel}>
              Cancel
            </button>
            <button
              className="cal-event-form__btn cal-event-form__btn--delete"
              onClick={onConfirm}
              disabled={deleting}
            >
              {deleting ? 'Deleting…' : 'Delete Event'}
            </button>
          </div>
        </div>
      </div>
    </>
  )
}

/* ══════════════════════════════════════════════════════════════════════════════
   DOCUMENTS SECTION
   ══════════════════════════════════════════════════════════════════════════════ */

/* Tool icon mapping for artifact cards (module scope — allocated once). */
const TOOL_ICONS: Record<string, string> = {
  'issue-tree': '🌳', 'decision-memo': '📋', 'prioritization': '📊',
  'data-insights': '📈', 'meeting-prep': '🤝', 'storyline': '📖',
  'scpr': '🔄', 'mckinsey-critic': '🔍', 'ai-use-case-scorer': '🤖',
  'deck-pipeline': '📑', 'gamma-deck': '🎨',
}

function getToolIcon(toolId: string): string {
  return TOOL_ICONS[toolId] || '⚡'
}

type DocFilter = 'recent' | 'shared' | 'artifacts' | 'transcripts'
const DOC_FILTERS: { key: DocFilter; label: string }[] = [
  { key: 'recent', label: 'Recent' },
  { key: 'shared', label: 'Shared' },
  { key: 'artifacts', label: 'Artifacts' },
  { key: 'transcripts', label: 'Transcripts' },
]

function DocumentsSectionImpl({ onInjectChat }: { onInjectChat: (msg: string, attachments?: ChatAttachment[]) => void }) {
  return (
    <CollapsibleSection title="Documents" protocolNum="04" defaultOpen={false}>
      {(isOpen) => <DocumentsSectionBody isOpen={isOpen} onInjectChat={onInjectChat} />}
    </CollapsibleSection>
  )
}

function DocumentsSectionBody({ isOpen, onInjectChat }: { isOpen: boolean; onInjectChat: (msg: string, attachments?: ChatAttachment[]) => void }) {
  const [activeFilter, setActiveFilter] = useState<DocFilter>('recent')
  const isArtifactsTab = activeFilter === 'artifacts'
  const { files, isLoading, error, mutate } = useDrive(activeFilter, !isArtifactsTab, isOpen)

  /* Fetch tool artifacts when artifacts tab is active */
  const { data: artifactsData, isLoading: artifactsLoading, error: artifactsError } = useSWR<{ artifacts: ToolArtifactRecord[] }>(
    activeFilter === 'artifacts' ? '/api/tool-artifacts' : null,
    artifactsFetcher,
    { revalidateOnFocus: false }
  )

  const emptyMessages: Record<DocFilter, string> = {
    recent: 'No files modified in the last 7 days',
    shared: 'No files shared with you in the last 7 days',
    artifacts: 'No saved artifacts — complete a tool session to create one',
    transcripts: 'No transcripts found',
  }

  const artifactsState = renderSectionState({ isLoading: artifactsLoading, error: artifactsError, skeletonLines: 3 })
  const driveState = renderSectionState({ isLoading, error, skeletonLines: 3, onRetry: () => mutate?.() })

  return (
    <>
      {/* Filter tabs */}
      <div
        className="doc-filter-tabs"
        role="tablist"
        aria-label="Document filters"
        onKeyDown={(e) =>
          handleRovingKeydown(e, '[role="tab"]', (i) => setActiveFilter(DOC_FILTERS[i].key))
        }
      >
        {DOC_FILTERS.map((f) => (
          <button
            key={f.key}
            id={`doc-tab-${f.key}`}
            role="tab"
            aria-selected={activeFilter === f.key}
            aria-controls="doc-tabpanel"
            tabIndex={activeFilter === f.key ? 0 : -1}
            className={`feed-filter-btn${activeFilter === f.key ? ' active' : ''}`}
            onClick={() => setActiveFilter(f.key)}
          >
            {f.label}
          </button>
        ))}
      </div>

      {/* Tab panel */}
      <div
        id="doc-tabpanel"
        role="tabpanel"
        aria-labelledby={`doc-tab-${activeFilter}`}
        tabIndex={0}
      >
      {activeFilter === 'artifacts' ? (
        artifactsState ? (
          artifactsState
        ) : !artifactsData?.artifacts?.length ? (
          <SectionMessage message={emptyMessages.artifacts} type="empty" />
        ) : (
          <div role="list" aria-label="Saved tool artifacts">
            {artifactsData.artifacts.map((artifact) => (
              <div role="listitem" key={artifact.id}>
                <button
                  onClick={() => {
                    const { message, attachment } = buildArtifactInject(artifact)
                    onInjectChat(message, [attachment])
                  }}
                  aria-label={`Artifact: ${artifact.title}`}
                  className="section-row"
                >
                  <span aria-hidden="true" className="document-icon">
                    {getToolIcon(artifact.toolId)}
                  </span>
                  <div className="document-info">
                    <div className="document-name">{artifact.title}</div>
                    <div className="document-modified">
                      {artifact.toolId} · {formatShortDate(artifact.createdAt)}
                    </div>
                  </div>
                </button>
              </div>
            ))}
          </div>
        )
      ) : (
        /* Existing Drive file content */
        <>
          {driveState ? (
            driveState
          ) : files.length === 0 ? (
            <SectionMessage message={emptyMessages[activeFilter]} type="empty" />
          ) : (
            <div role="list" aria-label={`${activeFilter} documents`}>
              {files.map((file) => (
                <DocumentRow
                  key={file.id}
                  file={file}
                  onClick={() => {
                    // Attaches the real Drive fileId so the chat route resolves
                    // the document's actual content, not just the file name.
                    const { message, attachment } = buildDocumentInject(file, activeFilter === 'transcripts')
                    onInjectChat(message, [attachment])
                  }}
                />
              ))}
            </div>
          )}
        </>
      )}
      </div>
    </>
  )
}

const DocumentRow = memo(function DocumentRow(
  { file, onClick }: { file: DriveFile; onClick: () => void },
) {
  const icon = getDriveIcon(file.mimeType)
  const modified = formatRelativeDate(file.modifiedTime)

  return (
    <div role="listitem">
      <button
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
    </div>
  )
})

/* ══════════════════════════════════════════════════════════════════════════════
   KPI SECTION — Live Paperclip + Business KPIs
   ══════════════════════════════════════════════════════════════════════════════ */

function KPISectionImpl({
  kpis: allKpis,
  isLoading,
  onInjectChat,
}: {
  kpis: LiveKPI[]
  isLoading: boolean
  onInjectChat: (msg: string, attachments?: ChatAttachment[]) => void
}) {
  // Mandate: Left Panel = Google ecosystem + business metrics only.
  // Paperclip orchestration metrics belong on the Right Panel.
  const kpis = useMemo(() => allKpis.filter(kpi => kpi.source !== 'paperclip'), [allKpis])

  const state = renderSectionState({ isLoading, skeletonLines: 4 })
  if (state) {
    return (
      <CollapsibleSection title="KPIs" protocolNum="01" defaultOpen>
        {state}
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
              <div className="kpi-value" aria-hidden="true">
                <AnimatedNumber value={String(kpi.value)} delay={i * 120} />
              </div>
              <div
                className={`kpi-trend ${trendClass}`}
                aria-hidden="true"
              >
                <span className="rx-star">✦</span> {kpi.trend}
              </div>
            </button>
          )
        })}
      </div>
    </CollapsibleSection>
  )
}

/* ══════════════════════════════════════════════════════════════════════════════
   MEMOIZED SECTION EXPORTS — props (onInjectChat/activeProject) are referentially
   stable across chat-input keystrokes, so React.memo skips re-render of these
   sections when only unrelated HubPage state changes.
   ══════════════════════════════════════════════════════════════════════════════ */

export const TasksSection = memo(TasksSectionImpl)
export const CalendarSection = memo(CalendarSectionImpl)
export const DocumentsSection = memo(DocumentsSectionImpl)
export const KPISection = memo(KPISectionImpl)

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
  onInjectChat: (msg: string, attachments?: ChatAttachment[]) => void
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
   (Inject-payload builders + date formatters live in lib/panel-inject.ts so they
   are unit-testable without React — imported at the top of this file.)
   ══════════════════════════════════════════════════════════════════════════════ */

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

/**
 * Roving keyboard navigation for a horizontal composite widget (tablist / listbox).
 * Wire to the container's onKeyDown. `optionSelector` targets the option elements.
 * Moves focus with ArrowLeft/Right + Home/End and calls onSelect with the new index.
 */
function handleRovingKeydown(
  e: React.KeyboardEvent<HTMLElement>,
  optionSelector: string,
  onSelect: (index: number) => void,
) {
  const keys = ['ArrowLeft', 'ArrowRight', 'Home', 'End']
  if (!keys.includes(e.key)) return
  const container = e.currentTarget
  const options = Array.from(container.querySelectorAll<HTMLElement>(optionSelector))
  if (options.length === 0) return
  const current = options.indexOf(document.activeElement as HTMLElement)
  let next = current
  if (e.key === 'ArrowRight') next = current < 0 ? 0 : (current + 1) % options.length
  else if (e.key === 'ArrowLeft') next = current <= 0 ? options.length - 1 : current - 1
  else if (e.key === 'Home') next = 0
  else if (e.key === 'End') next = options.length - 1
  e.preventDefault()
  options[next]?.focus()
  onSelect(next)
}
