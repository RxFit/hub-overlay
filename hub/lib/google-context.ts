/**
 * Builds a compact, model-readable snapshot of the user's live Google
 * Workspace data (Tasks, Calendar, Drive, Gmail, Chat) for injection into the
 * AI assistant's system prompt.
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
  listRecentGmailThreads,
  listChatSpaces,
  listChatMessages,
  type ChatMessage,
} from './google'
import {
  EMPTY_CHAT_SPACE_PREFERENCES,
  resolveVisibleSpaces,
  type ChatSpacePreferences,
} from './chat-spaces'

export interface GoogleWorkspaceContext {
  detail: string
  counts: {
    taskCount?: number
    upcomingEvents?: number
    recentFiles?: number
    unreadEmails?: number
  }
}

/* Prompt-size caps: the Gmail section and the Chat message lines are the only
   unbounded-ish inputs (subjects/snippets/messages are user-generated), so
   each gets a hard character budget on top of the per-item slices. */
const GMAIL_SECTION_CAP = 1_800
const CHAT_MESSAGES_CAP = 1_500

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
  chatSpacePreferences: ChatSpacePreferences = EMPTY_CHAT_SPACE_PREFERENCES,
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

  // ── Gmail: most recent inbox threads ──
  const gmailSection = (async () => {
    try {
      const threads = await listRecentGmailThreads(accessToken, { maxResults: 10 })
      const unread = threads.filter(t => t.isUnread).length
      counts.unreadEmails = unread
      if (threads.length === 0) return '### Gmail\nInbox is empty.'
      const header = `### Gmail (inbox, most recent ${threads.length} threads — ${unread} unread)`
      const lines: string[] = []
      let used = header.length
      let shown = 0
      for (const t of threads) {
        // Every user-generated field is per-field sliced BEFORE the section
        // budget check — otherwise one hostile mail with a huge subject as the
        // newest thread would blow the budget on line 1 and hide the whole inbox.
        const subject = t.subject.replace(/\s+/g, ' ').trim().slice(0, 120)
        const from = t.from.replace(/\s+/g, ' ').trim().slice(0, 80)
        const snippet = t.snippet.replace(/\s+/g, ' ').trim().slice(0, 120)
        let line = `  - ${t.isUnread ? '[UNREAD] ' : ''}"${subject}" — ${from} (${fmtDate(t.date)})`
        if (snippet) line += ` :: ${snippet}`
        if (used + line.length + 1 > GMAIL_SECTION_CAP) break
        lines.push(line)
        used += line.length + 1
        shown++
      }
      if (shown < threads.length) lines.push(`  …and ${threads.length - shown} more`)
      return `${header}\n${lines.join('\n')}`
    } catch {
      return '### Gmail\n[Could not load Gmail this turn — the Gmail panel on the left has the live view.]'
    }
  })()

  // ── Chat: spaces the user belongs to, plus recent messages for the first few ──
  const chatSection = (async () => {
    try {
      // Respect the user's Chat panel visibility choices here too. Without this
      // the model's context is dominated by whatever Google auto-created — the
      // first 3 spaces get their messages quoted, and a Meet chat from this
      // morning would outrank the team's actual space purely by list order.
      const spaces = resolveVisibleSpaces(await listChatSpaces(accessToken), chatSpacePreferences)
      if (spaces.length === 0) return '### Chat\nNo spaces.'
      // Last few messages for the first spaces, fetched in parallel; a failed
      // space just renders as names-only instead of blanking the section.
      const messagesBySpace = await Promise.all(
        spaces.slice(0, 3).map(s =>
          listChatMessages(accessToken, s.name, 5).catch((): ChatMessage[] => []),
        ),
      )
      let msgBudget = CHAT_MESSAGES_CAP
      const lines = spaces
        .slice(0, 15)
        .map((s, i) => {
          let block = `  - ${s.displayName || '(direct message)'} [${s.spaceType ?? s.type}]`
          for (const m of messagesBySpace[i] ?? []) {
            const text = (m.text ?? '').replace(/\s+/g, ' ').trim()
            if (!text) continue
            const sender =
              (m.sender?.displayName ?? '').replace(/\s+/g, ' ').trim().slice(0, 80) || '(unknown)'
            const line = `\n    · ${sender}: ${text.slice(0, 100)}`
            if (line.length > msgBudget) break
            block += line
            msgBudget -= line.length
          }
          return block
        })
        .join('\n')
      return `### Chat (${spaces.length} spaces)\n${lines}`
    } catch {
      return '### Chat\n[Could not load Chat this turn — the Chat panel has the live view.]'
    }
  })()

  const resolved = await Promise.all([tasksSection, eventsSection, filesSection, gmailSection, chatSection])
  return { detail: resolved.join('\n\n'), counts }
}
