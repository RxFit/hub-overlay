import { ActionSpec } from '@/types'
import { PAPERCLIP_BASE_URL } from '@/lib/paperclipConfig'
import { isProtectedCompany } from '@/lib/protected-workspaces'

interface ExecuteActionDeps {
  activeCompany: { id: string; name: string; identifier: string } | null
  mutate: (key: string) => any
}

/**
 * Marker prefix on errors thrown when a Google write route reports a
 * `MISSING_SCOPE` 403 — i.e. the user's OAuth grant predates a newly-added
 * scope (Docs/Sheets/Contacts). `handleActionApprove` matches this prefix to
 * trigger a one-time `signIn('google')` re-consent. It is deliberately
 * distinct from any other 403 (RBAC / gate token) so ONLY a genuine
 * insufficient-scope error re-consents — never a legitimate authorization
 * denial, which re-consent can't fix and would loop on.
 */
export const MISSING_SCOPE_MARKER = 'GOOGLE_MISSING_SCOPE'

/**
 * Build an error message for a failed Google write response. Only a real
 * `{ code: 'MISSING_SCOPE' }` 403 gets the re-consent marker; every other
 * failure (including bare 403s) yields a plain diagnostic that does NOT
 * trigger re-auth.
 */
async function scopeAwareError(res: Response, label: string): Promise<string> {
  let code: string | undefined
  let serverErr: string | undefined
  try {
    const b = await res.json()
    code = b?.code
    serverErr = typeof b?.error === 'string' ? b.error : undefined
  } catch {
    /* non-JSON body */
  }
  if (res.status === 403 && code === 'MISSING_SCOPE') {
    return `${MISSING_SCOPE_MARKER}: ${serverErr || 'Additional Google permission is needed. Please re-authenticate to grant it.'}`
  }
  return `${label} failed: ${res.status}${serverErr ? ` — ${serverErr}` : ''}`
}

/**
 * Resolve a recipient reference (name or email) to an email address via the
 * contacts route. Returns the original reference unchanged if it already looks
 * like an email or if nothing resolves — the caller/route still validates.
 */
async function resolveRecipientEmail(reference: string): Promise<string> {
  const ref = (reference || '').trim()
  if (!ref || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(ref)) return ref
  try {
    const res = await fetch(`/api/google/contacts?q=${encodeURIComponent(ref)}`)
    if (!res.ok) return ref
    const data = await res.json()
    const matches: Array<{ email: string; displayName: string }> = data?.matches ?? []
    const exact = matches.find((m) => m.displayName?.toLowerCase() === ref.toLowerCase())
    return (exact ?? matches[0])?.email ?? ref
  } catch {
    return ref
  }
}

/**
 * Headers for high-stakes Paperclip issue creation. Carries the server-issued
 * quality-gate token (P0-2) so the proxy can verify the context-sufficiency gate
 * was satisfied server-side before the agent is triggered.
 */
function issueHeaders(spec: ActionSpec): Record<string, string> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (spec.gateToken) headers['X-Gate-Token'] = spec.gateToken
  return headers
}

/**
 * Headers for AI-originated Google sends (send_gmail / post_chat_message).
 * Sibling of `issueHeaders` for routes that verify the gate directly (P0-2,
 * Option B): marks the request as AI-originated via X-AI-Intent and carries
 * the server-issued quality-gate token so the route can fail closed on
 * missing/forged/expired/mismatched tokens. Throws (fail fast, before any
 * network call) when the spec has no token — the server would reject it anyway.
 */
function gatedSendHeaders(spec: ActionSpec): Record<string, string> {
  if (!spec.gateToken) {
    throw new Error('Missing quality-gate token — please re-run the request so the safety gate can score it.')
  }
  return {
    'Content-Type': 'application/json',
    'X-Gate-Token': spec.gateToken,
    'X-AI-Intent': spec.intent,
  }
}

function pickList<T>(data: unknown, key: string): T[] {
  if (Array.isArray(data)) return data as T[]
  if (data && typeof data === 'object' && key in data) {
    const list = (data as Record<string, unknown>)[key]
    if (Array.isArray(list)) return list as T[]
  }
  return []
}

function isOpenIssue(issue: { status?: string; state?: { group?: string } }): boolean {
  const status = issue.status?.toLowerCase()
  const group = issue.state?.group?.toLowerCase()
  return (
    ['backlog', 'todo', 'in_progress', 'in_review', 'blocked'].includes(status || '') ||
    ['backlog', 'unstarted', 'started'].includes(group || '')
  )
}

/**
 * Personal-action lightweight flow: the single "additionalContext" answer —
 * when the user actually added detail rather than a "go ahead" skip (skip
 * phrases are already stripped in buildConfirmationSpec, so anything present
 * here is real) — enriches the action's main content. Appends it after the base
 * content, or uses it alone when the base is empty.
 */
function withExtraContext(base: string, extra?: string): string {
  const add = (extra ?? '').trim()
  if (!add) return base
  return base ? `${base}\n\n${add}` : add
}

/**
 * Executes an approved action from Interview Mode.
 * Returns the result message to display in the chat.
 */
export async function executeAction(
  spec: ActionSpec,
  deps: ExecuteActionDeps
): Promise<string> {
  const { activeCompany, mutate } = deps
  let resultMsg = ''

  switch (spec.intent) {
    case 'create_task': {
      // Get the first task list ID via the tasks API
      const listsRes = await fetch('/api/google/tasks')
      const listsData = await listsRes.json()
      const taskListId = listsData?.taskLists?.[0]?.id
      if (!taskListId) throw new Error('No task lists found')

      // Interview collects: description, priority, deadline, assignee
      // Prefer the extracted description/title. When neither was captured (the
      // user gave the task only via the single "add context?" answer), promote
      // additionalContext to the title instead of falling back to the raw
      // summary string — and then don't also duplicate it into the notes.
      const taskPrimary = spec.details.description || spec.details.title
      const taskTitle = taskPrimary || spec.details.additionalContext || spec.summary
      const taskNotes = withExtraContext(
        [
          spec.details.priority ? `Priority: ${spec.details.priority}` : '',
          spec.details.assignee ? `Assigned to: ${spec.details.assignee}` : '',
        ].filter(Boolean).join('\n'),
        taskPrimary ? spec.details.additionalContext : undefined,
      )

      const res = await fetch('/api/google/tasks', {
        method: 'POST',
        // X-AI-Intent marks this as an AI-originated action so the route records
        // it in the ai_action_log audit trail (NS-2). Task creation is not
        // gate-token-guarded, so no X-Gate-Token is attached.
        headers: { 'Content-Type': 'application/json', 'X-AI-Intent': 'create_task' },
        body: JSON.stringify({
          action: 'create',
          taskListId,
          title: taskTitle,
          notes: taskNotes,
          due: spec.details.deadline || spec.details.due || undefined,
        }),
      })
      if (!res.ok) throw new Error(`Task creation failed: ${res.status}`)
      const data = await res.json()
      resultMsg = `✅ **Task created!**\n\n"${data.task?.title || taskTitle}" has been added to your Google Tasks.`
      break
    }

    case 'update_task': {
      // Resolve the task by (partial) title across the user's task lists,
      // including completed tasks so "reopen X" can find them.
      const utRef = (spec.details.taskRef || '').toLowerCase().trim()
      if (!utRef) throw new Error('Tell me which task to change (its title or part of it).')

      const utListsRes = await fetch('/api/google/tasks')
      if (!utListsRes.ok) throw new Error(`Failed to fetch task lists: ${utListsRes.status}`)
      const utListsData = await utListsRes.json()
      const utLists: Array<{ id: string; title: string }> = utListsData?.taskLists || []
      if (utLists.length === 0) throw new Error('No task lists found')

      let utFound: { listId: string; id: string; title: string; status?: string } | null = null
      const utMatches: string[] = []
      for (const list of utLists.slice(0, 5)) {
        try {
          const tasksRes = await fetch(`/api/google/tasks?taskListId=${encodeURIComponent(list.id)}&showCompleted=true`)
          if (!tasksRes.ok) continue
          const tasksData = await tasksRes.json()
          const tasks: Array<{ id: string; title: string; status?: string }> = tasksData?.tasks || []
          for (const t of tasks) {
            if (t.title?.toLowerCase().includes(utRef)) {
              utMatches.push(t.title)
              if (!utFound) utFound = { listId: list.id, id: t.id, title: t.title, status: t.status }
              // Exact title match wins over the first substring match
              if (t.title.toLowerCase().trim() === utRef) {
                utFound = { listId: list.id, id: t.id, title: t.title, status: t.status }
              }
            }
          }
        } catch { /* skip unreachable list */ }
      }
      if (!utFound) throw new Error(`Could not find a task matching "${spec.details.taskRef}" in your Google Tasks.`)
      if (utMatches.length > 1 && !utMatches.some((t) => t.toLowerCase().trim() === utRef)) {
        throw new Error(`Multiple tasks match "${spec.details.taskRef}": ${utMatches.slice(0, 6).map((t) => `"${t}"`).join(', ')}. Please edit and use the exact title.`)
      }

      const utChange = (spec.details.change || '').toLowerCase().trim()
      const utHeaders = { 'Content-Type': 'application/json', 'X-AI-Intent': 'update_task' }
      const utBase = { taskListId: utFound.listId, taskId: utFound.id }

      if (/\b(done|complete|completed|finish|finished|check(ed)? off)\b/.test(utChange)) {
        const res = await fetch('/api/google/tasks', {
          method: 'POST', headers: utHeaders,
          body: JSON.stringify({ action: 'complete', ...utBase }),
        })
        if (!res.ok) throw new Error(`Task completion failed: ${res.status}`)
        resultMsg = `✅ **Task completed!**\n\n"${utFound.title}" has been marked done in your Google Tasks.`
      } else if (/\b(reopen|uncomplete|not done|undo|restore)\b/.test(utChange)) {
        const res = await fetch('/api/google/tasks', {
          method: 'POST', headers: utHeaders,
          body: JSON.stringify({ action: 'uncomplete', ...utBase }),
        })
        if (!res.ok) throw new Error(`Task reopen failed: ${res.status}`)
        resultMsg = `↩️ **Task reopened.**\n\n"${utFound.title}" is back on your list.`
      } else if (/\b(delete|remove|trash)\b/.test(utChange)) {
        const res = await fetch('/api/google/tasks', {
          method: 'POST', headers: utHeaders,
          body: JSON.stringify({ action: 'delete', ...utBase }),
        })
        if (!res.ok) throw new Error(`Task deletion failed: ${res.status}`)
        resultMsg = `🗑️ **Task deleted.**\n\n"${utFound.title}" has been removed from your Google Tasks.`
      } else if (spec.details.change?.trim()) {
        // Rename or reschedule. A parseable date → due-date change; otherwise
        // treat the text as the new title.
        const rawChange = spec.details.change.trim()
        const dueMatch = rawChange.match(/(?:due|move|reschedule)[^a-z0-9]*(?:to|for|on)?\s*(.+)/i)
        const dateText = dueMatch ? dueMatch[1] : rawChange
        const parsedDue = Date.parse(dateText)
        const payload: Record<string, string> = { action: 'update', ...utBase }
        let changeLabel: string
        if (!isNaN(parsedDue) && (dueMatch || /^\d{4}-\d{2}-\d{2}/.test(dateText))) {
          payload.due = new Date(parsedDue).toISOString()
          changeLabel = `due date moved to ${new Date(parsedDue).toLocaleDateString()}`
        } else {
          payload.title = rawChange.replace(/^(rename( it)?( to)?|retitle( to)?|call it)\s+/i, '').trim() || rawChange
          changeLabel = `renamed to "${payload.title}"`
        }
        const res = await fetch('/api/google/tasks', {
          method: 'POST', headers: utHeaders,
          body: JSON.stringify(payload),
        })
        if (!res.ok) throw new Error(`Task update failed: ${res.status}`)
        resultMsg = `✏️ **Task updated.**\n\n"${utFound.title}" — ${changeLabel}.`
      } else {
        throw new Error('Tell me what to change: mark done, reopen, delete, a new title, or a new due date.')
      }
      break
    }

    case 'schedule_event': {
      // Interview collects: title, when, attendees, location, duration
      const whenText = spec.details.when || spec.details.start || spec.details.date || ''
      
      // Try to parse the "when" into an ISO string
      let startDate: Date
      const parsed = Date.parse(whenText)
      if (!isNaN(parsed)) {
        startDate = new Date(parsed)
      } else {
        // Fallback: use tomorrow at 10 AM if unparseable
        startDate = new Date()
        startDate.setDate(startDate.getDate() + 1)
        startDate.setHours(10, 0, 0, 0)
      }

      // Parse duration (default 30 min)
      const durationText = spec.details.duration || '30 minutes'
      const durationMatch = durationText.match(/(\d+)\s*(min|hour|hr)/i)
      let durationMs = 30 * 60 * 1000 // default 30 min
      if (durationMatch) {
        const num = parseInt(durationMatch[1], 10)
        durationMs = durationMatch[2].startsWith('h')
          ? num * 60 * 60 * 1000
          : num * 60 * 1000
      }

      const endDate = new Date(startDate.getTime() + durationMs)
      const startISO = startDate.toISOString()
      const endISO = endDate.toISOString()

      const eventTitle = spec.details.title || spec.summary
      const eventDesc = withExtraContext(
        [
          spec.details.location ? `Location: ${spec.details.location}` : '',
          spec.details.notes || '',
        ].filter(Boolean).join('\n'),
        spec.details.additionalContext,
      )

      const attendeeList = spec.details.attendees
        ? spec.details.attendees.split(',').map((e: string) => e.trim()).filter(Boolean)
        : undefined

      // Auto-attach a Google Meet link when this looks like a real meeting:
      // either there are attendees, or the details mention a video call. A
      // solo block on your own calendar doesn't need one. (No new scope — the
      // existing `calendar` scope covers conferenceData.)
      const meetSignal = `${spec.details.details || ''} ${spec.details.location || ''} ${eventTitle}`.toLowerCase()
      const addMeetLink = (attendeeList?.length ?? 0) > 0 || /\b(meet|video|zoom|call|virtual|remote)\b/.test(meetSignal)

      const res = await fetch('/api/google/calendar', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          summary: eventTitle,
          description: eventDesc,
          start: startISO,
          end: endISO,
          attendees: attendeeList,
          addMeetLink,
        }),
      })
      if (!res.ok) throw new Error(`Event creation failed: ${res.status}`)
      const data = await res.json()
      const meetLink = data.event?.hangoutLink || data.event?.conferenceData?.entryPoints?.find((e: { uri?: string }) => e.uri)?.uri
      resultMsg = `✅ **Event scheduled!**\n\n"${data.event?.summary || eventTitle}" has been added to your Google Calendar for ${startDate.toLocaleDateString()} at ${startDate.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}.${meetLink ? `\n\n🎥 Google Meet: ${meetLink}` : ''}`
      break
    }

    case 'create_google_doc': {
      const docTitle = spec.details.title || spec.summary
      // Lightweight flow: any real "add context?" answer enriches the doc body.
      const docBody = withExtraContext(spec.details.content || '', spec.details.additionalContext)
      const res = await fetch('/api/google/doc', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-AI-Intent': 'create_google_doc' },
        body: JSON.stringify({ title: docTitle, body: docBody }),
      })
      if (!res.ok) throw new Error(await scopeAwareError(res, 'Doc creation'))
      const data = await res.json()
      resultMsg = `📄 **Google Doc created!**\n\n"${data.doc?.title || docTitle}" is in your Drive.\n\n▶ [Open the doc](${data.doc?.documentUrl})`
      break
    }

    case 'create_google_sheet': {
      const sheetTitle = spec.details.title || spec.summary
      // Parse pasted content into rows: split lines, then commas/tabs into cells.
      // A real "add context?" answer is folded in as additional row content.
      const raw = withExtraContext(spec.details.content || '', spec.details.additionalContext).trim()
      const rows = raw
        ? raw.split('\n').map((line) => line.split(/\t|,/).map((c) => c.trim()))
        : undefined
      const res = await fetch('/api/google/sheet', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-AI-Intent': 'create_google_sheet' },
        body: JSON.stringify({ title: sheetTitle, rows }),
      })
      if (!res.ok) throw new Error(await scopeAwareError(res, 'Sheet creation'))
      const data = await res.json()
      resultMsg = `📊 **Google Sheet created!**\n\n"${data.sheet?.title || sheetTitle}" is in your Drive.\n\n▶ [Open the sheet](${data.sheet?.spreadsheetUrl})`
      break
    }

    case 'create_google_presentation': {
      const deckTitle = spec.details.title || spec.summary
      const res = await fetch('/api/google/presentation', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-AI-Intent': 'create_google_presentation' },
        body: JSON.stringify({ title: deckTitle, body: spec.details.content || '' }),
      })
      if (!res.ok) throw new Error(await scopeAwareError(res, 'Presentation creation'))
      const data = await res.json()
      resultMsg = `🖼️ **Google Slides deck created!**\n\n"${data.presentation?.title || deckTitle}" is in your Drive.\n\n▶ [Open the deck](${data.presentation?.presentationUrl})`
      break
    }

    case 'send_communication': {
      if (!activeCompany) throw new Error('No workspace available — please select a project first.')

      const commDetails = spec.details.details || spec.details.description || spec.summary
      const commTo = spec.details.to || spec.details.recipient || ''
      const commChannel = spec.details.channel || spec.details.medium || 'email'
      const commTitle = `Communication Request: ${(commDetails || commTo).slice(0, 80)}`
      const commDesc = [
        `## Communication Request`,
        ``,
        commTo ? `**To:** ${commTo}` : '',
        `**Channel:** ${commChannel}`,
        `**Details:** ${commDetails}`,
        ``,
        `### Directive`,
        `The human operator has requested a communication be sent. COO: compose the message based on the details above and execute delivery via ${commChannel}. Report back with confirmation of what was sent, to whom, and when.`,
      ].filter(Boolean).join('\n')

      // Find the COO agent dynamically in the target workspace
      let commAssigneeId: string | undefined
      try {
        const agentsRes = await fetch(`/api/paperclip/companies/${activeCompany.id}/agents`)
        if (agentsRes.ok) {
          const agents = pickList<{ id: string; name: string }>(await agentsRes.json(), 'agents')
          const coo = agents.find((a) => a.name.toLowerCase().includes('coo') || a.name.toLowerCase().includes('operations'))
          if (coo) commAssigneeId = coo.id
        }
      } catch { /* will fall through to server-side CEO resolution */ }

      const scIssueRes = await fetch('/api/paperclip/issues', {
        method: 'POST',
        headers: issueHeaders(spec),
        body: JSON.stringify({
          title: commTitle,
          description: commDesc,
          priority: 'high',
          companyId: activeCompany.id,
          ...(commAssigneeId ? { assigneeId: commAssigneeId } : {}),
        }),
      })
      if (!scIssueRes.ok) throw new Error(`Communication issue creation failed: ${scIssueRes.status}`)
      const scIssueData = await scIssueRes.json()
      
      const issueId = scIssueData.issue?.identifier || scIssueData.issue?.id || ''
      const inboxUrl = `${PAPERCLIP_BASE_URL}/${activeCompany.identifier}/inbox/mine`

      resultMsg = `✉️ **Communication Routed to ${commAssigneeId ? 'COO' : 'CEO'} Agent**\n\nIssue **${issueId}** ("${scIssueData.issue?.title || commTitle}") has been created and assigned in the **${activeCompany.name}** workspace.\n\n▶ Track progress in the **Execution Feed** (right panel) or view it directly in your [Paperclip Inbox](${inboxUrl}).`
      mutate('/api/feed')
      break
    }

    case 'send_gmail': {
      // Fail fast (before any fetch) if the quality-gate token is missing —
      // the server verifies it and would 403 the send anyway (P0-2, Option B).
      const gmailHeaders = gatedSendHeaders(spec)

      // Interview collects: to, subject, body (entity extraction may prefill).
      // Resolve a name ("Maria") to an address via contacts so the send doesn't
      // fail for want of an email; an address passes through unchanged.
      const to = await resolveRecipientEmail(spec.details.to || '')
      const subject = spec.details.subject || '(no subject)'
      const body = withExtraContext(
        spec.details.body || spec.details.details || '',
        spec.details.additionalContext,
      ) || spec.summary

      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) {
        throw new Error(`I couldn't resolve "${spec.details.to}" to an email address. Edit the action and give me the address directly.`)
      }

      const res = await fetch('/api/google/gmail', {
        method: 'POST',
        headers: gmailHeaders,
        body: JSON.stringify({ to, subject, message: body }),
      })
      if (!res.ok) throw new Error(`Email send failed: ${res.status}`)
      resultMsg = `✉️ **Email sent** to ${to} — "${subject}".`
      break
    }

    case 'post_chat_message': {
      // Fail fast (before any fetch) if the quality-gate token is missing —
      // the server verifies it and would 403 the post anyway (P0-2, Option B).
      const chatHeaders = gatedSendHeaders(spec)

      // Resolve the space by display name — never pick silently on ambiguity.
      // The spaces GET is a read and needs no gate; only the send carries it.
      const spacesRes = await fetch('/api/google/chat/spaces')
      if (!spacesRes.ok) throw new Error(`Failed to fetch Chat spaces: ${spacesRes.status}`)
      const spaces = pickList<{ name: string; displayName: string }>(await spacesRes.json(), 'spaces')

      const spaceRef = (spec.details.space || '').toLowerCase().trim()
      const matches = spaces.filter((s) => s.displayName?.toLowerCase().includes(spaceRef))
      if (matches.length === 0) {
        throw new Error(`Chat space matching "${spec.details.space}" not found`)
      }
      // Exact-match short-circuit: with substring matching alone, a space whose
      // name is contained in another's ("RxFit Ops" vs "RxFit Ops Archive")
      // could never be targeted — even its exact name would multi-match.
      const exactMatches = matches.filter(
        (s) => s.displayName?.toLowerCase().trim() === spaceRef
      )
      if (matches.length > 1 && exactMatches.length !== 1) {
        throw new Error(
          `Multiple Chat spaces match "${spec.details.space}": ${matches.map((s) => s.displayName).join(', ')}. Please edit and specify which one.`
        )
      }
      const space = exactMatches.length === 1 ? exactMatches[0] : matches[0]

      const msgRes = await fetch('/api/google/chat/messages', {
        method: 'POST',
        headers: chatHeaders,
        body: JSON.stringify({
          spaceId: space.name,
          text: withExtraContext(spec.details.message || '', spec.details.additionalContext),
        }),
      })
      if (!msgRes.ok) throw new Error(`Chat message failed: ${msgRes.status}`)
      resultMsg = `💬 **Posted to ${space.displayName}**.`
      break
    }

    case 'create_paperclip_issue': {
      const issueTitle = spec.details.title || spec.summary
      const issueDesc = spec.details.description || ''
      const issuePriority = spec.details.priority || 'medium'
      const issueCompany = activeCompany

      const res = await fetch('/api/paperclip/issues', {
        method: 'POST',
        headers: issueHeaders(spec),
        body: JSON.stringify({
          title: issueTitle,
          description: issueDesc,
          priority: issuePriority,
          ...(issueCompany ? { companyId: issueCompany.id } : {}),
        }),
      })
      if (!res.ok) throw new Error(`Paperclip Issue creation failed: ${res.status}`)
      const data = await res.json()
      
      const issueId = data.issue?.identifier || data.issue?.id || ''
      const issuePrefix = issueCompany?.identifier || 'RXF'
      const inboxUrl = `${PAPERCLIP_BASE_URL}/${issuePrefix}/inbox/mine`
      
      resultMsg = `✅ **Agent Triggered!**\n\nIssue **${issueId}** ("${data.issue?.title || issueTitle}") has been assigned to the CEO Agent in **${issueCompany?.name || 'your workspace'}**.\n\n▶ Track progress in the **Execution Feed** (right panel) or view it directly in your [Paperclip Inbox](${inboxUrl}).`
      
      mutate('/api/feed')
      break
    }

    case 'check_agent_status': {
      const companiesRes = await fetch('/api/paperclip/companies')
      if (!companiesRes.ok) throw new Error(`Failed to fetch companies: ${companiesRes.status}`)
      const companies = pickList<{ id: string; name: string }>(await companiesRes.json(), 'companies')

      const targetProject = spec.details.project?.toLowerCase()
      const targetCompanies = targetProject === 'all'
        ? companies
        : companies.filter((c: { name: string }) => c.name.toLowerCase().includes(targetProject || ''))

      const agentStatusParts: string[] = []
      for (const company of targetCompanies.slice(0, 5)) {
        try {
          const agentsRes = await fetch(`/api/paperclip/companies/${company.id}/agents`)
          if (!agentsRes.ok) continue
          const agents = pickList<{ name: string; status: string }>(await agentsRes.json(), 'agents')
          const lines = agents.map((a) =>
            `  • **${a.name}** — ${a.status === 'active' || a.status === 'running' ? '🟢' : a.status === 'error' ? '🔴' : '⚪'} ${a.status}`
          )
          agentStatusParts.push(`**${company.name}** (${agents.length} agents):\n${lines.join('\n')}`)
        } catch { /* skip */ }
      }

      resultMsg = agentStatusParts.length > 0
        ? `📊 **Agent Status Report**\n\n${agentStatusParts.join('\n\n')}`
        : '⚠️ No agents found or Paperclip is unavailable.'
      break
    }

    case 'view_runs': {
      const companiesRes = await fetch('/api/paperclip/companies')
      if (!companiesRes.ok) throw new Error('Failed to fetch companies')
      const companies = pickList<{ id: string; name: string }>(await companiesRes.json(), 'companies')

      const targetProject = spec.details.project?.toLowerCase()
      const targetCompanies = targetProject === 'all'
        ? companies
        : companies.filter((c: { name: string }) => c.name.toLowerCase().includes(targetProject || ''))

      const runParts: string[] = []
      for (const company of targetCompanies.slice(0, 5)) {
        try {
          const runsRes = await fetch(`/api/paperclip/runs?companyId=${company.id}&limit=10`)
          if (!runsRes.ok) continue
          const runs = pickList<{ agentName: string; status: string; issueIdentifier: string; durationMs: number | null }>(await runsRes.json(), 'runs')
          if (runs.length === 0) continue
          const lines = runs.map((r) =>
            `  • **${r.agentName}** → ${r.issueIdentifier} — ${r.status === 'completed' ? '✅' : r.status === 'failed' ? '❌' : '⏳'} ${r.status}${r.durationMs ? ` (${(r.durationMs / 1000).toFixed(1)}s)` : ''}`
          )
          runParts.push(`**${company.name}**:\n${lines.join('\n')}`)
        } catch { /* skip */ }
      }

      resultMsg = runParts.length > 0
        ? `📋 **Recent Runs**\n\n${runParts.join('\n\n')}`
        : '⚠️ No recent runs found.'
      break
    }

    case 'assign_issue': {
      const aiCompaniesRes = await fetch('/api/paperclip/companies')
      if (!aiCompaniesRes.ok) throw new Error('Failed to fetch companies')
      const aiCompanies = pickList<{ id: string; name: string }>(await aiCompaniesRes.json(), 'companies')

      const issueRef = (spec.details.issueRef || '').toLowerCase()
      const agentRef = (spec.details.agent || '').toLowerCase()
      let foundIssue: { id: string; title: string; companyId: string } | null = null
      let foundAgent: { id: string; name: string } | null = null

      for (const company of aiCompanies) {
        try {
          const [issuesRes, agentsRes] = await Promise.all([
            fetch(`/api/paperclip/companies/${company.id}/issues?limit=50`),
            fetch(`/api/paperclip/companies/${company.id}/agents`),
          ])
          if (issuesRes.ok && !foundIssue) {
            const issues = pickList<{ id: string; identifier: string; title: string }>(await issuesRes.json(), 'issues')
            const match = issues.find((i) =>
              i.identifier?.toLowerCase().includes(issueRef) ||
              i.title?.toLowerCase().includes(issueRef)
            )
            if (match) foundIssue = { id: match.id, title: match.title, companyId: company.id }
          }
          if (agentsRes.ok && !foundAgent) {
            const agents = pickList<{ id: string; name: string }>(await agentsRes.json(), 'agents')
            const match = agents.find((a) =>
              a.name?.toLowerCase().includes(agentRef)
            )
            if (match) foundAgent = { id: match.id, name: match.name }
          }
        } catch { /* skip */ }
      }

      if (!foundIssue) throw new Error(`Could not find issue matching "${spec.details.issueRef}"`)
      if (!foundAgent) throw new Error(`Could not find agent matching "${spec.details.agent}"`)

      const assignRes = await fetch(`/api/paperclip/issues/${foundIssue.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ assigneeAgentId: foundAgent.id }),
      })
      if (!assignRes.ok) throw new Error(`Failed to reassign issue: ${assignRes.status}`)

      resultMsg = `✅ **Issue Reassigned**\n\n"${foundIssue.title}" has been assigned to **${foundAgent.name}**.`
      mutate('/api/feed')
      break
    }

    case 'update_issue_state': {
      const usCompaniesRes = await fetch('/api/paperclip/companies')
      if (!usCompaniesRes.ok) throw new Error('Failed to fetch companies')
      const usCompanies = pickList<{ id: string; name: string }>(await usCompaniesRes.json(), 'companies')

      const usIssueRef = (spec.details.issueRef || '').toLowerCase()
      let usFoundIssue: { id: string; title: string; companyId: string } | null = null

      for (const company of usCompanies) {
        try {
          const issuesRes = await fetch(`/api/paperclip/companies/${company.id}/issues?limit=50`)
          if (!issuesRes.ok) continue
          const issues = pickList<{ id: string; identifier: string; title: string }>(await issuesRes.json(), 'issues')
          const match = issues.find((i) =>
            i.identifier?.toLowerCase().includes(usIssueRef) ||
            i.title?.toLowerCase().includes(usIssueRef)
          )
          if (match) {
            usFoundIssue = { id: match.id, title: match.title, companyId: company.id }
            break
          }
        } catch { /* skip */ }
      }

      if (!usFoundIssue) throw new Error(`Could not find issue matching "${spec.details.issueRef}"`)

      const stateMap: Record<string, string> = {
        'backlog': 'backlog',
        'open': 'todo', 'todo': 'todo',
        'in-progress': 'in_progress', 'in progress': 'in_progress', 'started': 'in_progress',
        'in-review': 'in_review', 'in review': 'in_review', 'review': 'in_review',
        'blocked': 'blocked',
        'done': 'done', 'complete': 'done', 'completed': 'done',
        'cancelled': 'cancelled', 'canceled': 'cancelled',
      }
      const rawState = (spec.details.newState || '').toLowerCase()
      const mappedStatus = stateMap[rawState] || rawState

      const stateRes = await fetch(`/api/paperclip/issues/${usFoundIssue.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: mappedStatus }),
      })
      if (!stateRes.ok) throw new Error(`Failed to update issue state: ${stateRes.status}`)

      resultMsg = `✅ **Issue Updated**\n\n"${usFoundIssue.title}" state changed to **${spec.details.newState}**.`
      mutate('/api/feed')
      break
    }

    case 'create_agent': {
      const companiesRes = await fetch('/api/paperclip/companies')
      if (!companiesRes.ok) throw new Error('Failed to fetch companies')
      const companies = pickList<{ id: string; name: string }>(await companiesRes.json(), 'companies')
      const targetName = spec.details.project?.toLowerCase() || ''
      const company = companies.find((c) => c.name.toLowerCase().includes(targetName))
      if (!company) throw new Error(`Workspace "${spec.details.project}" not found`)

      const agentsRes = await fetch(`/api/paperclip/companies/${company.id}/agents`)
      const agents = agentsRes.ok ? pickList<{ id: string; name: string }>(await agentsRes.json(), 'agents') : []
      const ceoAgent = agents.find((a) => a.name.toLowerCase().includes('ceo'))

      const issueTitle = `Provision Agent: ${spec.details.agentName}`
      const issueDesc = [
        `## Agent Provisioning Request`,
        ``,
        `**Requested Agent:** ${spec.details.agentName}`,
        `**Role/Instructions:** ${spec.details.instructions}`,
        `**Workspace:** ${company.name}`,
        ``,
        `### Directive`,
        `The human operator has requested a new agent role. CEO: evaluate whether this role is needed, determine the appropriate adapter and instructions, and provision the agent.`,
      ].join('\n')

      const issueRes = await fetch('/api/paperclip/issues', {
        method: 'POST',
        headers: issueHeaders(spec),
        body: JSON.stringify({
          title: issueTitle,
          description: issueDesc,
          priority: 'high',
          companyId: company.id,
          assigneeId: ceoAgent?.id || undefined,
        }),
      })
      if (!issueRes.ok) throw new Error(`Issue creation failed: ${issueRes.status}`)
      const issueData = await issueRes.json()
      resultMsg = `🧠 **CEO Briefed**\n\nIssue "${issueData.issue?.title || issueTitle}" has been created and assigned to the CEO Agent in **${company.name}**.\n\nThe CEO will evaluate the request and provision the agent. Track progress in the Execution Feed.`
      mutate('/api/feed')
      break
    }

    case 'launch_campaign': {
      const companiesRes = await fetch('/api/paperclip/companies')
      if (!companiesRes.ok) throw new Error('Failed to fetch companies')
      const companies = pickList<{ id: string; name: string }>(await companiesRes.json(), 'companies')
      const targetName = spec.details.project?.toLowerCase() || ''
      const company = companies.find((c) => c.name.toLowerCase().includes(targetName))
      if (!company) throw new Error(`Workspace "${spec.details.project}" not found`)

      const agentsRes = await fetch(`/api/paperclip/companies/${company.id}/agents`)
      const agents = agentsRes.ok ? pickList<{ id: string; name: string }>(await agentsRes.json(), 'agents') : []
      const ceoAgent = agents.find((a) => a.name.toLowerCase().includes('ceo'))

      const suggestedRoles = spec.details.suggestedRoles || 'CEO to determine'
      const constraints = spec.details.constraints || 'None specified'

      const issueTitle = `Campaign: ${spec.details.campaignGoal?.slice(0, 80) || 'New Campaign'}`
      const issueDesc = [
        `## Campaign Launch Request`,
        ``,
        `**Campaign Goal:** ${spec.details.campaignGoal}`,
        `**Suggested Agent Roles:** ${suggestedRoles}`,
        `**Constraints:** ${constraints}`,
        `**Workspace:** ${company.name}`,
        ``,
        `### Directive`,
        `The human operator has requested a multi-agent campaign. CEO: determine the optimal agent structure, provision the necessary agents, assign sub-tasks, and coordinate delivery. You have full authority to create, modify, or reassign agents as needed.`,
      ].join('\n')

      const issueRes = await fetch('/api/paperclip/issues', {
        method: 'POST',
        headers: issueHeaders(spec),
        body: JSON.stringify({
          title: issueTitle,
          description: issueDesc,
          priority: 'high',
          companyId: company.id,
          assigneeId: ceoAgent?.id || undefined,
        }),
      })
      if (!issueRes.ok) throw new Error(`Campaign issue creation failed: ${issueRes.status}`)
      const issueData = await issueRes.json()
      resultMsg = `🚀 **Campaign Briefed to CEO**\n\nIssue "${issueData.issue?.title || issueTitle}" has been created and assigned to the CEO Agent in **${company.name}**.\n\nThe CEO will determine the agent structure, provision the necessary roles, and coordinate the campaign. Track progress in the Execution Feed.`
      mutate('/api/feed')
      break
    }

    case 'restart_agent': {
      const raCompaniesRes = await fetch('/api/paperclip/companies')
      if (!raCompaniesRes.ok) throw new Error('Failed to fetch companies')
      const raCompanies = pickList<{ id: string; name: string }>(await raCompaniesRes.json(), 'companies')

      const raProjectRef = (spec.details.project || '').toLowerCase()
      const raAgentRef = (spec.details.agent || '').toLowerCase()
      const raTargetCompanies = raProjectRef === 'all'
        ? raCompanies
        : raCompanies.filter((c) => c.name.toLowerCase().includes(raProjectRef))

      let raFoundAgent: { id: string; name: string; companyId: string } | null = null
      for (const company of raTargetCompanies) {
        try {
          const agentsRes = await fetch(`/api/paperclip/companies/${company.id}/agents`)
          if (!agentsRes.ok) continue
          const agents = pickList<{ id: string; name: string }>(await agentsRes.json(), 'agents')
          const match = agents.find((a) =>
            a.name?.toLowerCase().includes(raAgentRef)
          )
          if (match) {
            raFoundAgent = { id: match.id, name: match.name, companyId: company.id }
            break
          }
        } catch { /* skip */ }
      }

      if (!raFoundAgent) throw new Error(`Could not find agent matching "${spec.details.agent}" in "${spec.details.project}"`)

      const raRes = await fetch(`/api/paperclip/agents/${raFoundAgent.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'idle' }),
      })
      if (!raRes.ok) throw new Error(`Failed to restart agent: ${raRes.status}`)

      resultMsg = `✅ **Agent Restarted**\n\n"${raFoundAgent.name}" in **${spec.details.project}** has been reset to idle and is ready for new tasks.`
      break
    }

    case 'run_audit': {
      const companiesRes = await fetch('/api/paperclip/companies')
      if (!companiesRes.ok) throw new Error('Failed to fetch companies')
      const companies = pickList<{ id: string; name: string }>(await companiesRes.json(), 'companies')

      const auditParts: string[] = []
      for (const company of companies.slice(0, 5)) {
        try {
          const [agentsRes, issuesRes] = await Promise.all([
            fetch(`/api/paperclip/companies/${company.id}/agents`),
            fetch(`/api/paperclip/companies/${company.id}/issues?limit=100`),
          ])
          const agents = agentsRes.ok ? pickList<{ status: string }>(await agentsRes.json(), 'agents') : []
          const issues = issuesRes.ok ? pickList<{ status?: string; state?: { group?: string } }>(await issuesRes.json(), 'issues') : []

          const healthy = agents.filter((a) => a.status === 'active' || a.status === 'running').length
          const errored = agents.filter((a) => a.status === 'error').length
          const openIssues = issues.filter(isOpenIssue).length
          
          auditParts.push(
            `**${company.name}**\n` +
            `  • Agents: ${agents.length} (${healthy} healthy, ${errored} errored)\n` +
            `  • Issues: ${issues.length} total, ${openIssues} open\n` +
            `  • Health: ${errored === 0 ? '🟢 Healthy' : errored > agents.length / 2 ? '🔴 Critical' : '🟡 At Risk'}`
          )
        } catch { /* skip */ }
      }

      resultMsg = `🔬 **Audit Report**\n\n${auditParts.join('\n\n')}`
      break
    }

    case 'create_workspace': {
      const res = await fetch('/api/admin/workspaces', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          companyName: spec.details.name,
          issuePrefix: spec.details.issuePrefix || spec.details.name?.slice(0, 3).toUpperCase() || 'NEW',
          brandColor: spec.details.brandColor || '#C5A059',
          agentTemplate: spec.details.template || 'csuite',
        }),
      })
      if (!res.ok) throw new Error(`Workspace creation failed: ${res.status}`)
      const data = await res.json()
      resultMsg = `✅ **Workspace Created**\n\n"${data.companyName || spec.details.name}" [${data.issuePrefix || spec.details.issuePrefix}] has been provisioned with ${spec.details.template === 'ceo-only' ? 'a CEO agent' : 'the full C-Suite (CEO, CMO, CTO, CFO, COO)'}.\n\n🔄 The project dropdown has been updated.`
      mutate('/api/companies')
      mutate('/api/feed')
      break
    }

    case 'delete_workspace': {
      if (spec.details.confirmName?.toLowerCase() !== spec.details.name?.toLowerCase()) {
        resultMsg = `❌ **Deletion cancelled.** The confirmation name didn't match. You typed "${spec.details.confirmName}" but the workspace is "${spec.details.name}".`
        break
      }

      const dwCompaniesRes = await fetch('/api/paperclip/companies')
      if (!dwCompaniesRes.ok) throw new Error('Failed to fetch companies')
      const dwCompanies = pickList<{ id: string; name: string }>(await dwCompaniesRes.json(), 'companies')
      const dwMatch = dwCompanies.find((c) =>
        c.name.toLowerCase() === spec.details.name?.toLowerCase()
      )
      if (!dwMatch) throw new Error(`Workspace "${spec.details.name}" not found`)

      // SAFETY (UX): short-circuit protected workspaces with immediate feedback
      // instead of a 403 round-trip. The server proxy is the authoritative guard
      // (and also blocks env-added ids the client can't see); this client check
      // covers the config-pinned ids the browser knows about.
      if (isProtectedCompany(dwMatch.id)) {
        resultMsg = `🛡️ **Protected workspace.** "${spec.details.name}" is protected and can't be deleted.`
        break
      }

      const dwRes = await fetch(`/api/paperclip/companies/${dwMatch.id}`, {
        method: 'DELETE',
      })
      if (!dwRes.ok) throw new Error(`Workspace deletion failed: ${dwRes.status}`)

      resultMsg = `🗑️ **Workspace Deleted**\n\n"${spec.details.name}" and all its agents, issues, and data have been permanently removed.\n\n🔄 The project dropdown has been updated.`
      mutate('/api/companies')
      mutate('/api/feed')
      break
    }

    case 'delete_agent': {
      if (spec.details.confirmName?.toLowerCase() !== spec.details.agent?.toLowerCase()) {
        resultMsg = `❌ **Deletion cancelled.** The confirmation name didn't match. You typed "${spec.details.confirmName}" but the agent is "${spec.details.agent}".`
        break
      }

      const daCompaniesRes = await fetch('/api/paperclip/companies')
      if (!daCompaniesRes.ok) throw new Error('Failed to fetch companies')
      const daCompanies = pickList<{ id: string; name: string }>(await daCompaniesRes.json(), 'companies')

      const daProjectRef = (spec.details.project || '').toLowerCase()
      const daAgentRef = (spec.details.agent || '').toLowerCase()
      let daFoundAgent: { id: string; name: string; companyId: string } | null = null

      for (const company of daCompanies) {
        if (daProjectRef && !company.name.toLowerCase().includes(daProjectRef)) continue
        try {
          const agentsRes = await fetch(`/api/paperclip/companies/${company.id}/agents`)
          if (!agentsRes.ok) continue
          const agents = pickList<{ id: string; name: string }>(await agentsRes.json(), 'agents')
          const match = agents.find((a) =>
            a.name?.toLowerCase().includes(daAgentRef)
          )
          if (match) {
            daFoundAgent = { id: match.id, name: match.name, companyId: company.id }
            break
          }
        } catch { /* skip */ }
      }

      if (!daFoundAgent) throw new Error(`Could not find agent matching "${spec.details.agent}" in "${spec.details.project}"`)

      const daRes = await fetch(`/api/paperclip/agents/${daFoundAgent.id}`, {
        method: 'DELETE',
      })
      if (!daRes.ok) throw new Error(`Agent deletion failed: ${daRes.status}`)

      resultMsg = `🗑️ **Agent Deleted**\n\n"${daFoundAgent.name}" in **${spec.details.project}** has been removed.\n\n🔄 The project dropdown has been updated.`
      mutate('/api/companies')
      mutate('/api/feed')
      break
    }

    case 'create_routine': {
      if (!activeCompany) throw new Error('Select a workspace before creating a routine')

      // Resolve the owning agent by name within the active workspace
      const crAgentRef = (spec.details.agent || '').toLowerCase()
      const crAgentsRes = await fetch(`/api/paperclip/agents?companyId=${encodeURIComponent(activeCompany.id)}`)
      if (!crAgentsRes.ok) throw new Error('Failed to fetch agents for this workspace')
      const crAgents = pickList<{ id: string; name: string }>(await crAgentsRes.json(), 'agents')
      const crOwner = crAgents.find((a) => a.name?.toLowerCase().includes(crAgentRef))
      if (!crOwner) throw new Error(`Could not find an agent matching "${spec.details.agent}" in ${activeCompany.name}`)

      // Create the routine (gate-token-guarded creation path)
      const crRes = await fetch(`/api/paperclip/companies/${activeCompany.id}/routines`, {
        method: 'POST',
        headers: issueHeaders(spec),
        body: JSON.stringify({
          title: (spec.details.description || '').slice(0, 80) || 'Hub routine',
          description: spec.details.description,
          assigneeAgentId: crOwner.id,
          status: 'active',
        }),
      })
      if (!crRes.ok) {
        const errText = await crRes.text().catch(() => '')
        throw new Error(`Routine creation failed: ${crRes.status}${errText ? ` — ${errText.slice(0, 200)}` : ''}`)
      }
      const crData = await crRes.json()
      const crRoutineId = crData.routine?.id || crData.id

      // Attach a schedule trigger when a cron expression was provided.
      // "manual" (or anything non-cron-shaped) → on-demand routine, no trigger.
      const crSchedule = (spec.details.schedule || '').trim()
      const looksLikeCron = /^(\S+\s+){4}\S+$/.test(crSchedule) && crSchedule.toLowerCase() !== 'manual'
      let crTriggerNote = 'It runs on demand (no schedule trigger).'
      if (looksLikeCron && crRoutineId) {
        const trigRes = await fetch(`/api/paperclip/routines/${crRoutineId}/triggers`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ kind: 'schedule', cron: crSchedule }),
        })
        crTriggerNote = trigRes.ok
          ? `It runs on schedule \`${crSchedule}\`.`
          : `⚠️ The routine was created, but attaching the schedule trigger failed (${trigRes.status}) — add the schedule in Paperclip, or ask me to retry.`
      }

      resultMsg = `✅ **Routine Created**\n\n"${crData.routine?.title || spec.details.description}" is now owned by **${crOwner.name}** in **${activeCompany.name}**. ${crTriggerNote}\n\nEach run creates a tracked issue — watch them land in the right panel's Routines tab.`
      mutate('/api/feed')
      break
    }

    case 'update_routine':
    case 'run_routine': {
      if (!activeCompany) throw new Error('Select a workspace first')

      // Resolve the routine by (partial) title within the active workspace
      const urRef = (spec.details.routineRef || '').toLowerCase()
      const urListRes = await fetch(`/api/paperclip/routines?companyId=${encodeURIComponent(activeCompany.id)}`)
      if (!urListRes.ok) throw new Error('Failed to fetch routines for this workspace')
      const urRoutines = pickList<{ id: string; title: string; status?: string }>(await urListRes.json(), 'routines')
      const urMatch = urRoutines.find((r) => r.title?.toLowerCase().includes(urRef))
      if (!urMatch) {
        const available = urRoutines.slice(0, 8).map((r) => `"${r.title}"`).join(', ') || 'none'
        throw new Error(`Could not find a routine matching "${spec.details.routineRef}". Available: ${available}`)
      }

      if (spec.intent === 'run_routine') {
        const runRes = await fetch(`/api/paperclip/routines/${urMatch.id}/run`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ source: 'manual' }),
        })
        if (!runRes.ok) throw new Error(`Manual run failed: ${runRes.status}`)
        resultMsg = `✅ **Routine Fired**\n\n"${urMatch.title}" has been triggered manually. If another run is already active, the routine's concurrency policy may coalesce or skip this one — check the Routines tab for the outcome.`
        mutate('/api/feed')
        break
      }

      // update_routine: pause / resume / rename
      const urChange = (spec.details.change || '').toLowerCase()
      const urPayload: Record<string, unknown> = {}
      let urChangeLabel = ''
      if (/\bpause|stop|disable\b/.test(urChange)) {
        urPayload.status = 'paused'
        urChangeLabel = 'paused'
      } else if (/\bresume|activate|enable|unpause|start\b/.test(urChange)) {
        urPayload.status = 'active'
        urChangeLabel = 'resumed'
      } else if (spec.details.change?.trim()) {
        urPayload.title = spec.details.change.trim()
        urChangeLabel = `renamed to "${urPayload.title}"`
      } else {
        throw new Error('Tell me what to change: pause, resume, or a new title.')
      }

      const urRes = await fetch(`/api/paperclip/routines/${urMatch.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(urPayload),
      })
      if (!urRes.ok) throw new Error(`Routine update failed: ${urRes.status}`)
      resultMsg = `✅ **Routine Updated**\n\n"${urMatch.title}" has been ${urChangeLabel}.`
      break
    }

    case 'create_goal': {
      if (!activeCompany) throw new Error('Select a workspace before creating a goal')

      const cgLevelRaw = (spec.details.level || 'team').toLowerCase().trim()
      const cgLevel = ['company', 'team', 'agent', 'task'].includes(cgLevelRaw) ? cgLevelRaw : 'team'

      // Optional owner agent resolved by name
      let cgOwnerId: string | undefined
      let cgOwnerName: string | undefined
      const cgOwnerRef = (spec.details.owner || '').toLowerCase().trim()
      if (cgOwnerRef && cgOwnerRef !== 'none') {
        const cgAgentsRes = await fetch(`/api/paperclip/agents?companyId=${encodeURIComponent(activeCompany.id)}`)
        if (cgAgentsRes.ok) {
          const cgAgents = pickList<{ id: string; name: string }>(await cgAgentsRes.json(), 'agents')
          const cgOwner = cgAgents.find((a) => a.name?.toLowerCase().includes(cgOwnerRef))
          if (cgOwner) { cgOwnerId = cgOwner.id; cgOwnerName = cgOwner.name }
        }
      }

      const cgRes = await fetch(`/api/paperclip/companies/${activeCompany.id}/goals`, {
        method: 'POST',
        headers: issueHeaders(spec),
        body: JSON.stringify({
          title: (spec.details.description || '').slice(0, 80) || 'Hub goal',
          description: spec.details.description,
          level: cgLevel,
          status: 'active',
          ...(cgOwnerId ? { ownerAgentId: cgOwnerId } : {}),
        }),
      })
      if (!cgRes.ok) {
        const errText = await cgRes.text().catch(() => '')
        throw new Error(`Goal creation failed: ${cgRes.status}${errText ? ` — ${errText.slice(0, 200)}` : ''}`)
      }
      const cgData = await cgRes.json()
      resultMsg = `✅ **Goal Created**\n\n"${cgData.goal?.title || cgData.title || spec.details.description}" is now an active **${cgLevel}-level** goal in **${activeCompany.name}**${cgOwnerName ? `, owned by **${cgOwnerName}**` : ''}.\n\nAgents see goal ancestry on every task they pick up — work created under this goal traces back to it.`
      break
    }

    case 'update_goal': {
      if (!activeCompany) throw new Error('Select a workspace first')

      const ugRef = (spec.details.goalRef || '').toLowerCase()
      const ugListRes = await fetch(`/api/paperclip/goals?companyId=${encodeURIComponent(activeCompany.id)}`)
      if (!ugListRes.ok) throw new Error('Failed to fetch goals for this workspace')
      const ugGoals = pickList<{ id: string; title: string; status?: string }>(await ugListRes.json(), 'goals')
      const ugMatch = ugGoals.find((g) => g.title?.toLowerCase().includes(ugRef))
      if (!ugMatch) {
        const available = ugGoals.slice(0, 8).map((g) => `"${g.title}"`).join(', ') || 'none'
        throw new Error(`Could not find a goal matching "${spec.details.goalRef}". Available: ${available}`)
      }

      const ugChange = (spec.details.change || '').toLowerCase()
      const ugPayload: Record<string, unknown> = {}
      let ugChangeLabel = ''
      if (/\bachiev|complete|done\b/.test(ugChange)) {
        ugPayload.status = 'achieved'
        ugChangeLabel = 'marked achieved 🎉'
      } else if (/\bcancel|drop|abandon\b/.test(ugChange)) {
        ugPayload.status = 'cancelled'
        ugChangeLabel = 'cancelled'
      } else if (/\bactivate|active|start\b/.test(ugChange)) {
        ugPayload.status = 'active'
        ugChangeLabel = 'activated'
      } else if (/\bplan\b/.test(ugChange)) {
        ugPayload.status = 'planned'
        ugChangeLabel = 'moved back to planned'
      } else if (spec.details.change?.trim()) {
        ugPayload.description = spec.details.change.trim()
        ugChangeLabel = 'description updated'
      } else {
        throw new Error('Tell me what to change: activate, achieved, cancel, or a new description.')
      }

      const ugRes = await fetch(`/api/paperclip/goals/${ugMatch.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(ugPayload),
      })
      if (!ugRes.ok) throw new Error(`Goal update failed: ${ugRes.status}`)
      resultMsg = `✅ **Goal Updated**\n\n"${ugMatch.title}" — ${ugChangeLabel}.`
      break
    }

    default:
      throw new Error(`Unsupported action intent: ${spec.intent}`)
  }

  return resultMsg
}
