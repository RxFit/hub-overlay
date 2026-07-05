export function formatTime(isoString: string): string {
  try {
    const d = new Date(isoString)
    return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
  } catch {
    return isoString
  }
}

export function formatRelativeDate(isoString: string): string {
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

export function getDriveIcon(mimeType: string): string {
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
 * Display title for a calendar event. Google allows summary-less events, so
 * fall back to the '(untitled)' convention (matches lib/panel-inject.ts)
 * instead of rendering "undefined".
 */
export function eventDisplayTitle(summary?: string): string {
  const trimmed = summary?.trim()
  return trimmed || '(untitled)'
}

/**
 * Client-side validation for the new-event modal (F7). Returns a user-facing
 * error message, or null when the form is valid. Times are same-day "HH:MM"
 * strings, so lexical comparison is chronological. Attendees are validated
 * against the same rule the server enforces (see EMAIL_RE in
 * app/api/google/gmail/route.ts) so bad addresses fail fast instead of
 * round-tripping to Google.
 */
export function validateEventForm({ startTime, endTime, attendees }: {
  startTime: string
  endTime: string
  attendees: string
}): string | null {
  if (endTime <= startTime) {
    return 'End time must be after the start time.'
  }
  const EMAIL_RE = /^[^\s@,]+@[^\s@,]+\.[^\s@,]+$/
  const bad = attendees.split(',').map(s => s.trim()).filter(Boolean).filter(e => !EMAIL_RE.test(e))
  if (bad.length > 0) {
    return `Invalid attendee email${bad.length > 1 ? 's' : ''}: ${bad.join(', ')}`
  }
  return null
}

export const DAY_LETTERS = ['S', 'M', 'T', 'W', 'T', 'F', 'S']

export function getMonday(d: Date): Date {
  const date = new Date(d)
  date.setHours(0, 0, 0, 0)
  const day = date.getDay()
  // getDay() returns 0 for Sunday — shift back to Monday
  const diff = day === 0 ? -6 : 1 - day
  date.setDate(date.getDate() + diff)
  return date
}

export function getWeekDays(monday: Date): Date[] {
  return Array.from({ length: 7 }, (_, i) => {
    const d = new Date(monday)
    d.setDate(monday.getDate() + i)
    return d
  })
}

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