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
  location?: string
  description?: string
}

export interface DriveFileInput {
  id: string
  name: string
  mimeType: string
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
    `• When: ${when}`,
  ]
  if (event.location) lines.push(`• Location: ${event.location}`)
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

export interface ArtifactInput {
  id: string
  toolId: string
  title: string
}

/**
 * Build the message + attachment for a tapped tool artifact. The attachment
 * carries the real artifact id so the chat route resolves THIS artifact even
 * when two share a toolId + title.
 */
export function buildArtifactInject(
  artifact: ArtifactInput,
): { message: string; attachment: ChatAttachment } {
  const message = `Show me the ${artifact.toolId} artifact: ${artifact.title}`
  const attachment: ChatAttachment = {
    id: artifact.id,
    type: 'text',
    label: artifact.title,
    // Embed the resolvable id so the chat route can fetch the artifact by id.
    content: `[artifact:${artifact.id}] toolId=${artifact.toolId} title="${artifact.title}"`,
  }
  return { message, attachment }
}
