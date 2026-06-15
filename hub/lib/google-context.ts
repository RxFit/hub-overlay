/**
 * Builds a compact, model-readable snapshot of the user's live Google
 * Workspace data (Tasks, Calendar, Drive, Chat) for injection into the AI
 * assistant's system prompt.
 *
 * WHY THIS EXISTS: the chat route fetched Paperclip + Vertex + pgvector + Exa
 * context but never the user's own Google data. So tapping a Google Task
 * ("Tell me about task: X") reached the model with zero data about that task,
 * and the model fell back to the prompt's Paperclip "warming up" deflection.
 * This builder closes that gap. Each service is fetched independently with its
 * own try/catch so one slow/failed API never blanks the rest; the caller wraps
 * the whole thing in an aggregate timeout.
 */

import {
  listTaskLists,
  listTasks,
  listUpcomingEvents,
  listRecentFiles,
  listChatSpaces,
} from './google'

export interface GoogleWorkspaceContext {
  detail: string
  counts: {
    taskCount?: number
    upcomingEvents?: number
    recentFiles?: number
  }
}

const CHICAGO = 'America/Chicago'
function fmtDate(iso?: string): string {
  if (!iso) return 'no date'
  const d = new Date(iso)
  if (isNaN(d.getTime())) return iso
  return d.toLocaleString('en-US', {
    timeZone: CHICAGO, month: 'short', day: 'numeric',
    hour: iso.length > 10 ? 'numeric' : undefined,
    minute: iso.length > 10 ? '2-digit' : undefined,
  })
}

/**
 * Assemble the live Google Workspace context block. Every list is capped so
 * the prompt stays bounded regardless of account size.
 */
export async function buildGoogleWorkspaceContext(
  accessToken: string,
): Promise<GoogleWorkspaceContext> {
  const counts: GoogleWorkspaceContext['counts'] = {}

  // ── Tasks: first few lists, pending items only ──
  const tasksSection = (async () => {
    try {
      const lists = await listTaskLists(accessToken)
      const perList = await Promise.all(
        lists.slice(0, 5).map(l =>
          listTasks(accessToken, l.id, { showCompleted: false, maxResults: 25 })
            .then(tasks => ({ list: l, tasks }))
            .catch(() => ({ list: l, tasks: [] })),
        ),
      )
      const allPending = perList.flatMap(p => p.tasks.filter(t => t.status === 'needsAction'))
      counts.taskCount = allPending.length
      if (allPending.length === 0) return '### Tasks\nNo pending tasks.'
      const lines = perList
        .filter(p => p.tasks.some(t => t.status === 'needsAction'))
        .map(p => {
          const items = p.tasks
            .filter(t => t.status === 'needsAction')
            .slice(0, 15)
            .map(t => {
              let line = `  - ${t.title}`
              if (t.due) line += ` (due ${fmtDate(t.due)})`
              if (t.notes) line += ` — ${t.notes.replace(/\s+/g, ' ').slice(0, 200)}`
              return line
            })
            .join('\n')
          return `**${p.list.title}**\n${items}`
        })
      return `### Tasks (${allPending.length} pending)\n${lines.join('\n')}`
    } catch {
      return '### Tasks\n[Could not load tasks this turn — the Tasks panel on the left has the live view.]'
    }
  })()

  // ── Calendar: upcoming events ──
  const eventsSection = (async () => {
    try {
      const events = await listUpcomingEvents(accessToken, { maxResults: 15 })
      counts.upcomingEvents = events.length
      if (events.length === 0) return '### Calendar\nNo events in the current window.'
      const lines = events
        .slice(0, 15)
        .map(e => `  - ${e.summary ?? '(untitled)'} — ${fmtDate(e.start?.dateTime ?? e.start?.date)}`)
        .join('\n')
      return `### Calendar (${events.length} upcoming)\n${lines}`
    } catch {
      return '### Calendar\n[Could not load calendar this turn — the Calendar panel on the left has the live view.]'
    }
  })()

  // ── Drive: recently modified files ──
  const filesSection = (async () => {
    try {
      const files = await listRecentFiles(accessToken, { maxResults: 12 })
      counts.recentFiles = files.length
      if (files.length === 0) return '### Drive\nNo recent files.'
      const lines = files
        .map(f => `  - ${f.name} (modified ${fmtDate(f.modifiedTime)})`)
        .join('\n')
      return `### Drive (recent files)\n${lines}`
    } catch {
      return '### Drive\n[Could not load Drive this turn — the Documents panel on the left has the live view.]'
    }
  })()

  // ── Chat: spaces the user belongs to ──
  const chatSection = (async () => {
    try {
      const spaces = await listChatSpaces(accessToken)
      if (spaces.length === 0) return '### Chat\nNo spaces.'
      const lines = spaces
        .slice(0, 15)
        .map(s => `  - ${s.displayName || '(direct message)'} [${s.spaceType ?? s.type}]`)
        .join('\n')
      return `### Chat (${spaces.length} spaces)\n${lines}`
    } catch {
      return '### Chat\n[Could not load Chat this turn — the Chat panel has the live view.]'
    }
  })()

  const resolved = await Promise.all([tasksSection, eventsSection, filesSection, chatSection])
  return { detail: resolved.join('\n\n'), counts }
}
