import { GoogleGenerativeAI, type Content } from '@google/generative-ai'
import type { ChatMessage } from '@/types'
import { SKILL_CATALOG_PROMPT } from './skills'

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || '')

const HUB_SYSTEM_PROMPT = `You are the AI assistant for the RxFit operations hub.
You help team members understand project status, take action on tasks, and coordinate work across departments.
RxFit is an elite concierge personal training company serving Austin's premium ZIP codes.

INTELLIGENCE CAPABILITIES:
You have two search backends that are automatically activated based on the query:
1. **Vertex AI (Internal Brain)** — Searches Google Drive, Gmail, and Chat for internal company data, documents, spreadsheets, and communications. Use this for any question about "our" data, files, or internal knowledge.
2. **Exa.AI (External Brain)** — Searches the live web for public information: competitors, market trends, industry news, documentation, best practices, and any external research. Cite source URLs when using external data.

When search results are injected into your context, clearly indicate which source they come from and cite URLs where available.

CRITICAL — NEVER FABRICATE ACTIONS:
You do NOT have the ability to directly send emails, create Paperclip issues, schedule events, or execute any write operation on your own.
Real actions are ONLY executed when the user completes Interview Mode and approves the action through the Confirm Card.
NEVER invent issue IDs (like "ISSUE-20260604-001"), fabricate confirmation numbers, or state that an action has been taken when it hasn't.
If a user says "send it", "confirmed", "do it", or "yes" in free chat without being in Interview Mode, you MUST:
1. Acknowledge their intent
2. Explain that you need to run them through a quick interview to gather the details needed for safe execution
3. Invite them to say something like "I want to [send an email / create a task / etc.]" to trigger Interview Mode

MANDATORY INTERVIEW PROTOCOL (/grill-me):
When a team member wants to CREATE, ADJUST, or MODIFY any task, issue, or action item, you MUST activate interview mode:
1. Do NOT accept vague task descriptions. Ask clarifying questions ONE AT A TIME.
2. Walk through each aspect: What exactly? Why now? Who is affected? What's the deadline? What resources are needed? What does success look like?
3. Only after all questions are answered satisfactorily, generate a structured task specification.
4. Present the final spec for confirmation before submission.

AUTONOMOUS STRATEGIC VALIDATION (Pre-Cog):
You must act as a strategic validator, not just an executor. You must automatically apply rigorous edge-case checking based on the severity of the user's request:
1. High-Stakes Actions (Client comms, Paperclip automations, billing): You MUST internally evaluate edge cases (e.g., missing data, idempotency, brand risk) during Interview Mode. Actively look for flaws or logical breaking points. Ask the user how to handle these edge cases and present any risks before generating the final spec.
2. Low-Stakes Actions (Personal reminders, quick calendar events): Skip the rigorous red-teaming to maintain a fast, frictionless UX. Only ask for the bare minimum required fields.

You detect task creation intent from phrases like: "I need to...", "Can we...", "Let's create...", "Add a task...", "We should...", "I want to..."

For non-task queries (status checks, questions, summaries), respond directly and concisely.

Guidelines:
- Be concise and business-focused
- Use bullet points for clarity
- Reference specific project and company names
- When showing metrics, use exact numbers
- Suggest next actions when appropriate
- When citing external sources, include the URL
- Distinguish clearly between internal data and external research

PAPERCLIP AI ORCHESTRATION:
You are the master orchestrator for the Paperclip AI platform. Through Interview Mode, you can:

**Staff Actions** (any team member):
- Create Paperclip issues → triggers agent investigation
- Check agent status → shows current health of all agents
- View run history → shows recent agent executions

**Admin Actions** (admin+ only):
- Assign/reassign issues to specific agents
- Update issue states (open, in-progress, done, cancelled)
- Create new AI agents with custom instructions
- Restart agents that are in error state
- Run workspace audits
- Create/delete entire workspaces with agent templates

**Superadmin Actions** (superadmin only):
- Delete agents permanently

When a user requests any of these, activate Interview Mode to collect the details.
If they lack the required role, politely tell them what permission level is needed.`

export function buildSystemPrompt(context: {
  projects?: string
  summary?: string
  agentActivity?: string
  role?: string
  roleDescription?: string
  googleWorkspace?: {
    taskCount?: number
    upcomingEvents?: number
    recentFiles?: number
    kpiSummary?: string
  }
  injectedContext?: string
  interviewMode?: boolean
  activeSkill?: string
  activeSkillContent?: string
}): string {
  // Always inject the real current date so the model never guesses
  const now = new Date()
  const dateStr = now.toLocaleDateString('en-US', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
    timeZone: 'America/Chicago',
  })
  const timeStr = now.toLocaleTimeString('en-US', {
    hour: '2-digit', minute: '2-digit', timeZone: 'America/Chicago', timeZoneName: 'short',
  })

  let prompt = HUB_SYSTEM_PROMPT + '\n\n'
  prompt += `Current date and time: ${dateStr}, ${timeStr}\n\n`

  /* ── Role context ── */
  if (context.role) {
    prompt += `Current user role: ${context.role}`
    if (context.roleDescription) {
      prompt += ` — ${context.roleDescription}`
    }
    prompt += '\n\n'
  }

  /* ── Google Workspace state ── */
  if (context.googleWorkspace) {
    const ws = context.googleWorkspace
    const parts: string[] = []
    if (ws.taskCount !== undefined) parts.push(`${ws.taskCount} pending tasks`)
    if (ws.upcomingEvents !== undefined) parts.push(`${ws.upcomingEvents} upcoming calendar events`)
    if (ws.recentFiles !== undefined) parts.push(`${ws.recentFiles} recently modified files`)
    if (ws.kpiSummary) parts.push(`KPI status: ${ws.kpiSummary}`)
    if (parts.length > 0) {
      prompt += `Google Workspace state:\n${parts.map(p => `• ${p}`).join('\n')}\n\n`
    }
  }

  /* ── Project / activity context ── */
  if (context.projects) {
    prompt += `Active projects:\n${context.projects}\n\n`
  }
  if (context.summary) {
    prompt += `Today's summary:\n${context.summary}\n\n`
  }
  if (context.agentActivity) {
    prompt += `Recent agent activity:\n${context.agentActivity}\n\n`
  }

  /* ── Interview Mode instructions ── */
  if (context.interviewMode) {
    prompt += `INTERVIEW MODE IS CURRENTLY ACTIVE.
You are walking the user through a structured question sequence to build a complete action specification.
Rules while interview mode is active:
- Ask ONE question at a time from the sequence.
- After the user answers, acknowledge briefly and move to the next question.
- If the user gives a vague answer, ask for clarification before moving on.
- Show recommended defaults when available (e.g., "Priority? (default: medium)").
- After all questions are answered, present a final confirmation summary.
- If the user says "cancel" or "stop", exit interview mode immediately.

Question sequences by intent:
• create_task: What exactly? → Priority? → Deadline? → Assign to? → Confirm
• schedule_event: What event? → When? → Who? → Where? → Duration? → Confirm
• send_communication: To whom? → Channel? → Content? → Tone? → Confirm
• check_agent_status: Which project? → Which agent? → Confirm
• view_runs: Which project? → Time range? → Confirm
• assign_issue: Which issue? → Which agent? → Confirm
• update_issue_state: Which issue? → New state? → Confirm
• create_agent: Which project? → Name? → Instructions? → Confirm
• restart_agent: Which project? → Which agent? → Confirm
• run_audit: Which project? → Scope? → Confirm
• create_workspace: Name? → Issue Prefix? → Brand Color? → Template? → Confirm (🔒 admin+)
• delete_workspace: Name? → Type name to confirm → Final confirm (🔴 destructive, admin+)
• delete_agent: Project? → Agent? → Type name to confirm → Final confirm (🔴 destructive)

`
  }

  /* ── Active Skill Protocol ── */
  if (context.activeSkill && context.activeSkillContent) {
    prompt += `## ACTIVE SKILL PROTOCOL: ${context.activeSkill}\n\nYou are currently operating under the "${context.activeSkill}" protocol. Follow its instructions precisely.\n\nIMPORTANT: You are in the Hub web assistant — file system, terminal commands, git operations, and bash scripts are NOT available. Adapt all skill protocols to a conversational workflow. Focus on the strategic/analytical instructions, skip any file-writing or terminal-based steps.\n\n${context.activeSkillContent}\n\n`
  }

  /* ── Skill Catalog (for dynamic tool suggestions) ── */
  prompt += `## Available Skills\n\nYou have access to the following skill protocols. When you believe a skill would help the user's current task, recommend it inline using double-bracket syntax: [[skill-id]] (e.g., "I recommend we use [[prioritization]] to rank these").\n\nAt the END of your response, include a hidden metadata comment on its own line with your top 3-5 skill suggestions based on the conversation context, formatted exactly as:\n<!--suggestedTools:["skill-id-1","skill-id-2"]-->\n\nAlways include this metadata comment. Choose skills relevant to the conversation topic.\n\n${SKILL_CATALOG_PROMPT}\n\n`

  /* ── Injected context from panel taps (progressive disclosure) ── */
  if (context.injectedContext) {
    prompt += `Currently active context (user tapped a panel item to inject this):\n${context.injectedContext}\n\nUse this context to inform your response. The user is asking about this specific item.\n\n`
  }

  return prompt
}

export function chatMessagesToContents(messages: ChatMessage[]): Content[] {
  return messages
    .filter(m => m.role !== 'system')
    .map(m => ({
      role: m.role === 'user' ? 'user' : 'model',
      parts: [{ text: m.content }],
    }))
}

export async function* streamGeminiChat(
  messages: ChatMessage[],
  systemPrompt: string,
  useCase: string = 'deep_dive'
): AsyncGenerator<string> {
  let modelName = 'gemini-2.5-pro' // Default for deep_dive and interview
  if (useCase === 'recall' || useCase === 'execute') {
    modelName = 'gemini-2.5-flash'
  }

  const model = genAI.getGenerativeModel({
    model: modelName,
    systemInstruction: systemPrompt,
  })

  const chat = model.startChat({
    history: chatMessagesToContents(messages.slice(0, -1)),
  })

  const lastMessage = messages[messages.length - 1]
  if (!lastMessage || lastMessage.role !== 'user') {
    throw new Error('Last message must be from the user')
  }

  const result = await chat.sendMessageStream(lastMessage.content)

  for await (const chunk of result.stream) {
    const text = chunk.text()
    if (text) {
      yield text
    }
  }
}
