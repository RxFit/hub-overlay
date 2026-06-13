import { ActionSpec } from '@/types'
import { PAPERCLIP_BASE_URL } from '@/lib/paperclipConfig'

interface ExecuteActionDeps {
  activeCompany: { id: string; name: string; identifier: string } | null
  mutate: (key: string) => any
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
      const taskTitle = spec.details.description || spec.details.title || spec.summary
      const taskNotes = [
        spec.details.priority ? `Priority: ${spec.details.priority}` : '',
        spec.details.assignee ? `Assigned to: ${spec.details.assignee}` : '',
      ].filter(Boolean).join('\n')

      const res = await fetch('/api/google/tasks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
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
      const eventDesc = [
        spec.details.location ? `Location: ${spec.details.location}` : '',
        spec.details.notes || '',
      ].filter(Boolean).join('\n')

      const res = await fetch('/api/google/calendar', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          summary: eventTitle,
          description: eventDesc,
          start: startISO,
          end: endISO,
          attendees: spec.details.attendees
            ? spec.details.attendees.split(',').map((e: string) => e.trim())
            : undefined,
        }),
      })
      if (!res.ok) throw new Error(`Event creation failed: ${res.status}`)
      const data = await res.json()
      resultMsg = `✅ **Event scheduled!**\n\n"${data.event?.summary || eventTitle}" has been added to your Google Calendar for ${startDate.toLocaleDateString()} at ${startDate.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}.`
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
        headers: { 'Content-Type': 'application/json' },
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

    case 'create_paperclip_issue': {
      const issueTitle = spec.details.title || spec.summary
      const issueDesc = spec.details.description || ''
      const issuePriority = spec.details.priority || 'medium'
      const issueCompany = activeCompany

      const res = await fetch('/api/paperclip/issues', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
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
        headers: { 'Content-Type': 'application/json' },
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
        headers: { 'Content-Type': 'application/json' },
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

    default:
      throw new Error(`Unsupported action intent: ${spec.intent}`)
  }

  return resultMsg
}
