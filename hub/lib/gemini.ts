import { GoogleGenerativeAI, type Content } from '@google/generative-ai'
import type { ChatMessage } from '@/types'

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || '')

const HUB_SYSTEM_PROMPT = `You are the AI assistant for the Casa Trejo operations hub.
You help team members understand project status, take action on tasks, and coordinate work across departments.

MANDATORY INTERVIEW PROTOCOL (/grill-me):
When a team member wants to CREATE, ADJUST, or MODIFY any task, issue, or action item, you MUST activate interview mode:
1. Do NOT accept vague task descriptions. Ask clarifying questions ONE AT A TIME.
2. Walk through each aspect: What exactly? Why now? Who is affected? What's the deadline? What resources are needed? What does success look like?
3. Only after all questions are answered satisfactorily, generate a structured task specification.
4. Present the final spec for confirmation before submission.

You detect task creation intent from phrases like: "I need to...", "Can we...", "Let's create...", "Add a task...", "We should...", "I want to..."

For non-task queries (status checks, questions, summaries), respond directly and concisely.

Guidelines:
- Be concise and business-focused
- Use bullet points for clarity
- Reference specific project and company names
- When showing metrics, use exact numbers
- Suggest next actions when appropriate`

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
}): string {
  let prompt = HUB_SYSTEM_PROMPT + '\n\n'

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

`
  }

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
  let modelName = 'gemini-3.1-pro' // Default for deep_dive and interview
  if (useCase === 'recall' || useCase === 'execute') {
    modelName = 'gemini-3.5-flash'
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
