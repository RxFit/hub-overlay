/**
 * Pure builders for the panel → chat "inject" payloads.
 *
 * When a user taps an item in the left panel (a task, calendar event, or Drive
 * document), these construct the message (and, for documents, the attachment)
 * that gets sent into the primary chat. They carry the item's real details
 * inline so the assistant can answer about THIS item even when it falls outside
 * the live Google Workspace snapshot the chat route fetches.
 *
 * Extracted from LeftPanelSections.tsx so they are unit-testable without React.
 * Input types are structural so this module stays decoupled from the hooks.
 */

import type { ChatAttachment } from '@/types'

export interface TaskInput {
  title: string
  notes?: string
  status: string // 'needsAction' | 'completed'
  due?: string
}

export interface EventInput {
  summary?: string
  start: { dateTime?: string; date?: string }
  end?: { dateTime?: string; date?: string }
  location?: string
  description?: string
  attendees?: { email?: string; displayName?: string }[]
}

export interface DriveFileInput {
  id: string
  name: string
  mimeType: string
  /** Present on the real DriveFile the row passes in; the message builder
   *  doesn't read it, but the type should mirror the shape it receives. */
  modifiedTime?: string
}

/** Collapse whitespace and bound a free-text field so a pathological note/description
 *  can't blow the message size. */
function clampText(s: string, max = 500): string {
  return s.replace(/\s+/g, ' ').trim().slice(0, max)
}

export function formatTime(isoString: string): string {
  try {
    const d = new Date(isoString)
    return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
  } catch {
    return isoString
  }
}

export function formatShortDate(isoString: string): string {
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

/**
 * Format a Google Tasks `due` value (date-only, UTC midnight) for display.
 * Parses the DATE portion in local terms so the day doesn't shift for
 * negative-offset users, and reports future deltas + overdue — unlike
 * formatRelativeDate, which is past-only and would say "just now" for a
 * task due tomorrow.
 */
export function formatDueDate(isoString: string): string {
  try {
    // Take the YYYY-MM-DD prefix and build a LOCAL midnight date so the
    // calendar day matches what the user sees, not the UTC instant.
    const [y, m, d] = isoString.slice(0, 10).split('-').map(Number)
    if (!y || !m || !d) return isoString
    const due = new Date(y, m - 1, d)

    const now = new Date()
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate())
    const diffDays = Math.round((due.getTime() - today.getTime()) / 86_400_000)

    if (diffDays === 0) return 'Today'
    if (diffDays === 1) return 'Tomorrow'
    if (diffDays === -1) return 'Yesterday (overdue)'
    if (diffDays < 0) return `${-diffDays}d overdue`
    if (diffDays < 7) return `in ${diffDays}d`
    return due.toLocaleDateString([], { month: 'short', day: 'numeric' })
  } catch {
    return isoString
  }
}

/**
 * Build a context-rich chat message for a tapped task. Carries the task's list,
 * status, due date, and notes inline.
 */
export function buildTaskInjectMessage(task: TaskInput, listName: string): string {
  const lines = [
    `Tell me about this task from my "${listName}" list:`,
    `• Title: ${task.title}`,
    `• Status: ${task.status === 'completed' ? 'Completed' : 'Pending'}`,
  ]
  if (task.due) lines.push(`• Due: ${formatDueDate(task.due)}`)
  if (task.notes) lines.push(`• Notes: ${clampText(task.notes)}`)
  return lines.join('\n')
}

/**
 * Build a context-rich chat message for a tapped calendar event. Carries the
 * date/time, location, and description inline.
 */
export function buildEventInjectMessage(event: EventInput): string {
  const when = event.start.dateTime
    ? `${formatShortDate(event.start.dateTime)} at ${formatTime(event.start.dateTime)}`
    : event.start.date
      ? `${formatShortDate(event.start.date + 'T00:00:00')} (all day)`
      : 'unscheduled'
  const lines = [
    `Tell me about this calendar event:`,
    `• Title: ${event.summary || '(untitled)'}`,
    `• When: ${when}${event.end?.dateTime ? `, ends ${formatTime(event.end.dateTime)}` : ''}`,
  ]
  if (event.location) lines.push(`• Location: ${event.location}`)
  const attendeeNames = (event.attendees ?? [])
    .slice(0, 5)
    .map(a => a.email || a.displayName)
    .filter(Boolean)
  if (attendeeNames.length > 0) {
    // clampText bounds pathological attendee strings, same as notes/description.
    lines.push(`• Attendees: ${clampText(attendeeNames.join(', '), 300)}`)
  }
  if (event.description) lines.push(`• Details: ${clampText(event.description)}`)
  return lines.join('\n')
}

/**
 * Build the message + Drive attachment for a tapped document. The attachment
 * carries the real fileId so the chat route resolves the document's actual
 * content (Vertex semantic search → Drive export) rather than just the name.
 */
export function buildDocumentInject(
  file: DriveFileInput,
  isTranscript: boolean,
): { message: string; attachment: ChatAttachment } {
  const message = isTranscript
    ? `Summarize the meeting transcript "${file.name}" using its attached content.`
    : `Tell me about the document "${file.name}" using its attached content.`
  const attachment: ChatAttachment = {
    id: file.id,
    type: 'document',
    label: file.name,
    fileId: file.id,
    mimeType: file.mimeType,
  }
  return { message, attachment }
}

export interface ArtifactSectionInput {
  title: string
  content: string
  children?: ArtifactSectionInput[]
}

export interface ArtifactContentInput {
  title?: string
  sections?: ArtifactSectionInput[]
}

export interface ArtifactInput {
  id: string
  toolId: string
  title: string
  /** Human tool name for the message ("Deep Research"); falls back to the id. */
  toolName?: string
  /** The saved sections. When present the attachment carries the real
   *  content, so the assistant discusses what was actually found instead of
   *  a bare id it has no way to resolve. */
  content?: ArtifactContentInput | null
}

/** Upper bound on the attached artifact text. The chat route's text
 *  attachment resolver slices at 16k; staying under it keeps the marker line
 *  and the leading sections intact for even the largest report. */
export const ARTIFACT_ATTACHMENT_MAX_CHARS = 12_000
const ARTIFACT_ATTACHMENT_MAX_DEPTH = 8

/**
 * PURE: flatten an artifact's sections (one nesting level per depth) into
 * markdown the assistant can read — heading per section, body verbatim.
 */
export function renderArtifactText(content: ArtifactContentInput | null | undefined): string {
  const out: string[] = []
  let remaining = ARTIFACT_ATTACHMENT_MAX_CHARS
  const walk = (sections: unknown, depth: number) => {
    if (!Array.isArray(sections) || depth > ARTIFACT_ATTACHMENT_MAX_DEPTH || remaining <= 0) return
    for (const raw of sections) {
      if (remaining <= 0) break
      if (!raw || typeof raw !== 'object') continue
      const s = raw as Record<string, unknown>
      const title = typeof s.title === 'string' && s.title.trim() ? s.title : 'Untitled section'
      const body = typeof s.content === 'string' ? s.content.trim() : ''
      const heading = '#'.repeat(Math.min(2 + depth, 6))
      const rendered = body ? `${heading} ${title}\n${body}` : `${heading} ${title}`
      const bounded = rendered.slice(0, remaining)
      out.push(bounded)
      remaining -= bounded.length + 2
      walk(s.children, depth + 1)
    }
  }
  const sections = content && typeof content === 'object'
    ? (content as { sections?: unknown }).sections
    : undefined
  walk(sections, 0)
  return out.join('\n\n')
}

/**
 * Build the message + attachment for a tapped tool artifact. The attachment
 * leads with the real artifact id so THIS artifact stays identifiable even
 * when two share a toolId + title, then carries the saved sections (bounded)
 * so the chat can actually discuss the findings.
 */
export function buildArtifactInject(
  artifact: ArtifactInput,
): { message: string; attachment: ChatAttachment } {
  const toolName = artifact.toolName || artifact.toolId
  const message = `Walk me through the saved ${toolName} artifact "${artifact.title}" — lead with its key findings.`
  // The resolvable id marker stays first and is never truncated away.
  const marker = `[artifact:${artifact.id}] toolId=${artifact.toolId} title="${artifact.title}"`
  const body = renderArtifactText(artifact.content)
  const attachment: ChatAttachment = {
    id: artifact.id,
    type: 'text',
    label: artifact.title,
    content: body ? `${marker}\n\n${body}`.slice(0, ARTIFACT_ATTACHMENT_MAX_CHARS) : marker,
  }
  return { message, attachment }
}
