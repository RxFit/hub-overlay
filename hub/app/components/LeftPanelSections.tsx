'use client'

import { useState, ReactNode } from 'react'
import { useTasks, useCalendar, useDrive, useKPIs } from '@/app/hooks/useHubData'
import type { TaskItem, CalendarEvent, DriveFile, KPIRow } from '@/app/hooks/useHubData'
import { AnimatedNumber } from './AnimatedNumber'

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
  const { tasks, isLoading, error } = useTasks()

  if (isLoading) {
    return (
      <CollapsibleSection title="Tasks" protocolNum="01" defaultOpen>
        <SkeletonBlock lines={4} />
      </CollapsibleSection>
    )
  }

  const isAuthError = error && (error as any)?.status === 401
  if (isAuthError) {
    return (
      <CollapsibleSection title="Tasks" protocolNum="01" defaultOpen>
        <SectionMessage message="Session expired — please sign in again" type="error" />
      </CollapsibleSection>
    )
  }

  if (error) {
    return (
      <CollapsibleSection title="Tasks" protocolNum="01" defaultOpen>
        <SectionMessage message="Unable to load tasks — try refreshing or check your connection" type="error" />
      </CollapsibleSection>
    )
  }

  if (tasks.length === 0) {
    return (
      <CollapsibleSection title="Tasks" protocolNum="01" defaultOpen>
        <SectionMessage message="No pending tasks" type="empty" />
      </CollapsibleSection>
    )
  }

  return (
    <CollapsibleSection title="Tasks" protocolNum="01" defaultOpen>
      <div role="list" aria-label="Google Tasks">
        {tasks.map((task) => (
          <TaskRow key={task.id} task={task} onClick={() => onInjectChat(`Tell me about task: ${task.title}`)} />
        ))}
      </div>
    </CollapsibleSection>
  )
}

function TaskRow({ task, onClick }: { task: TaskItem; onClick: () => void }) {
  const dueDate = task.due ? formatRelativeDate(task.due) : null
  const isCompleted = task.status === 'completed'

  return (
    <button
      role="listitem"
      onClick={onClick}
      aria-label={`Task: ${task.title}${dueDate ? `, due ${dueDate}` : ''}`}
      className="section-row"
    >
      {/* Decorative checkbox */}
      <span
        aria-hidden="true"
        className={`task-checkbox ${isCompleted ? 'task-checkbox--completed' : 'task-checkbox--pending'}`}
      >
        {isCompleted && '✓'}
      </span>

      {/* Content */}
      <div className="task-content">
        <div className={`task-title ${isCompleted ? 'task-title--completed' : 'task-title--pending'}`}>
          {task.title}
        </div>
        {dueDate && (
          <div className="task-due">
            Due {dueDate}
          </div>
        )}
      </div>

      {/* Status dot */}
      <span
        aria-hidden="true"
        className={`task-status-dot ${isCompleted ? 'task-status-dot--completed' : 'task-status-dot--pending'}`}
      />
    </button>
  )
}

export function CalendarSection({ onInjectChat }: { onInjectChat: (msg: string) => void }) {
  const { events, isLoading, error } = useCalendar()
  const [selectedDate, setSelectedDate] = useState<Date>(() => new Date())
  const [weekStart, setWeekStart] = useState<Date>(() => getMonday(new Date()))

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
        <SectionMessage message="Unable to load calendar — try refreshing or check your connection" type="error" />
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

  return (
    <CollapsibleSection title="Calendar" protocolNum="02" defaultOpen>
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
                onClick={() => {
                  const dateStr = event.start.dateTime
                    ? formatShortDate(event.start.dateTime)
                    : event.start.date ?? ''
                  onInjectChat(`Tell me about event: ${event.summary} on ${dateStr}`)
                }}
              />
            ))}
          </div>
        )}
      </div>
    </CollapsibleSection>
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

function CalendarRow({ event, onClick }: { event: CalendarEvent; onClick: () => void }) {
  const startTime = event.start.dateTime
    ? formatTime(event.start.dateTime)
    : 'All day'

  return (
    <button
      role="listitem"
      onClick={onClick}
      aria-label={`Event: ${event.summary} at ${startTime}`}
      className="section-row section-row--calendar"
    >
      {/* Time badge */}
      <span className="calendar-time-badge">
        {startTime}
      </span>

      {/* Event details */}
      <div className="calendar-details">
        <div className="calendar-summary">
          {event.summary}
        </div>
        {(event as any).location && (
          <div className="calendar-meta">
            {(event as any).location}
          </div>
        )}
      </div>
    </button>
  )
}

/* ══════════════════════════════════════════════════════════════════════════════
   DOCUMENTS SECTION
   ══════════════════════════════════════════════════════════════════════════════ */

type DocFilter = 'recent' | 'shared' | 'transcripts'
const DOC_FILTERS: { key: DocFilter; label: string }[] = [
  { key: 'recent', label: 'Recent' },
  { key: 'shared', label: 'Shared' },
  { key: 'transcripts', label: 'Transcripts' },
]

export function DocumentsSection({ onInjectChat }: { onInjectChat: (msg: string) => void }) {
  const [activeFilter, setActiveFilter] = useState<DocFilter>('recent')
  const { files, isLoading, error } = useDrive(activeFilter)

  const isAuthError = error && (error as any)?.status === 401

  const emptyMessages: Record<DocFilter, string> = {
    recent: 'No recent files',
    shared: 'No shared files',
    transcripts: 'No transcripts found',
  }

  return (
    <CollapsibleSection title="Documents" protocolNum="03" defaultOpen={false}>
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

      {/* Content */}
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
                  ? `Summarize the meeting transcript: ${file.name}`
                  : `Find document: ${file.name}`
                onInjectChat(msg)
              }}
            />
          ))}
        </div>
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
   KPI SECTION
   ══════════════════════════════════════════════════════════════════════════════ */

/** Static fallback KPI data when Sheet is unavailable */
const FALLBACK_KPIS: KPIRow[] = [
  { label: 'Revenue MTD', value: '$124,500', trend: '+12.4%', up: true },
  { label: 'Active Clients', value: '47', trend: '+3', up: true },
  { label: 'Agent Tasks', value: '18', trend: 'In Progress', up: true },
  { label: 'Open Issues', value: '34', trend: '-8 this week', up: true },
]

export function KPISection({
  sheetId,
  range = 'KPIs!A2:D10',
  onInjectChat,
}: {
  sheetId?: string
  range?: string
  onInjectChat: (msg: string) => void
}) {
  const { kpis, isLoading, error } = useKPIs(sheetId, range)

  // Use live data if available, otherwise fall back to static
  const displayKpis = (kpis.length > 0 && !error) ? kpis : FALLBACK_KPIS
  const usingFallback = kpis.length === 0 || !!error

  if (isLoading && sheetId) {
    return (
      <CollapsibleSection title="KPIs" protocolNum="04" defaultOpen>
        <SkeletonBlock lines={4} />
      </CollapsibleSection>
    )
  }

  return (
    <CollapsibleSection title="KPIs" protocolNum="04" defaultOpen>
      <div className="kpi-grid" role="list" aria-label="Key performance indicators">
        {displayKpis.map((kpi, i) => (
          <button
            key={kpi.label}
            className="kpi-card kpi-card--clickable"
            role="listitem"
            onClick={() => onInjectChat(`Tell me more about KPI: ${kpi.label}`)}
            aria-label={`${kpi.label}: ${kpi.value}, trend ${kpi.trend}`}
          >
            <div className="kpi-label">{kpi.label}</div>
            <div className="kpi-value">
              <AnimatedNumber value={kpi.value} delay={i * 120} />
            </div>
            <div
              className={`kpi-trend ${kpi.up ? 'kpi-trend-up' : 'kpi-trend-down'}`}
              aria-label={`Trend: ${kpi.up ? 'up' : 'down'} ${kpi.trend}`}
            >
              <span aria-hidden="true" className="rx-star">✦</span> {kpi.trend}
            </div>
          </button>
        ))}
      </div>
      {usingFallback && !isLoading && sheetId && (
        <div className="kpi-fallback-notice">
          // using cached data
        </div>
      )}
    </CollapsibleSection>
  )
}

/* ══════════════════════════════════════════════════════════════════════════════
   PROJECT HEALTH SECTION — static data (mirrors page.tsx)
   ══════════════════════════════════════════════════════════════════════════════ */

const PROJECTS = [
  { id: 'rxfit',      name: 'RxFit',      abbr: 'RX', color: '#C5A059' },
  { id: 'fridgesnap', name: 'FridgeSnap', abbr: 'FS', color: '#4A6FA5' },
  { id: 'jadecoss',   name: 'JadeCoS',    abbr: 'JC', color: '#8a6e3e' },
  { id: 'wellnessapp',name: 'WellnessApp',abbr: 'WA', color: '#d4b572' },
  { id: 'notebookrx', name: 'NotebookRx', abbr: 'NR', color: '#9aa8c6' },
  { id: 'seo-agent',  name: 'SEO Agent',  abbr: 'SE', color: '#ef4444' },
]

export function ProjectHealthSection({ onInjectChat }: { onInjectChat: (msg: string) => void }) {
  return (
    <CollapsibleSection title="Project Health" protocolNum="05" defaultOpen>
      <div className="project-health-list" role="list" aria-label="Project health status">
        {PROJECTS.map(p => {
          const healthStatus = p.id === 'jadecoss' ? 'critical' : p.id === 'fridgesnap' ? 'at risk' : 'healthy'
          const statusColor = p.id === 'jadecoss' ? 'var(--danger)' : p.id === 'fridgesnap' ? 'var(--warn)' : 'var(--accent)'
          return (
            <div
              key={p.id}
              role="listitem"
              tabIndex={0}
              aria-label={`${p.name}: ${healthStatus}`}
              className="project-health-item"
              onClick={() => onInjectChat(`Show me the health status for ${p.name}`)}
              onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onInjectChat(`Show me the health status for ${p.name}`) } }}
            >
              <span
                aria-hidden="true"
                className="project-health-badge"
                style={{
                  background: `${p.color}1a`,
                  border: `1px solid ${p.color}44`,
                  color: p.color,
                }}
              >
                {p.abbr}
              </span>
              <span className="project-health-name">{p.name}</span>
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
