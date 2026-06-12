import { GoogleGenerativeAI, type Content } from '@google/generative-ai'
import type { ChatMessage } from '@/types'
import { SKILL_CATALOG_PROMPT } from './skills'

/* Lazy-initialized so the API key is read at runtime, not build time.
   Prevents empty-key 403s when Railway injects env vars after the build step. */
let _genAI: GoogleGenerativeAI | null = null
function getGenAI(): GoogleGenerativeAI {
  if (!_genAI) {
    const key = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || process.env.GOOGLE_GENERATIVE_AI_API_KEY || ''
    if (!key) {
      throw new Error('No Gemini API key found. Set GEMINI_API_KEY, GOOGLE_API_KEY, or GOOGLE_GENERATIVE_AI_API_KEY.')
    }
    _genAI = new GoogleGenerativeAI(key)
  }
  return _genAI
}

const HUB_SYSTEM_PROMPT = `You are the AI assistant for the RxFit operations hub.
You help team members understand project status, take action on tasks, and coordinate work across departments.
RxFit is an elite concierge personal training company serving Austin's premium ZIP codes.

INTELLIGENCE CAPABILITIES:
You have two search backends that are automatically activated based on the query:
1. **Vertex AI (Internal Brain)** — Searches Google Drive, Gmail, and Chat for internal company data, documents, spreadsheets, and communications. Use this for any question about "our" data, files, or internal knowledge.
2. **Exa.AI (External Brain)** — Searches the live web for public information: competitors, market trends, industry news, documentation, best practices, and any external research. Cite source URLs when using external data.

When search results are injected into your context, clearly indicate which source they come from and cite URLs where available.

CRITICAL — DATA SOURCE INDEPENDENCE:
Google Workspace features (Google Drive, Calendar, Tasks, Gmail, Google Chat) are powered by the user's personal OAuth session and are COMPLETELY INDEPENDENT of the Paperclip API and Vertex AI Search.
- If Paperclip is unavailable or timed out, Google Workspace features still work normally via the left panel. NEVER tell the user that Google Drive, Gmail, or Chat are broken because Paperclip is down.
- If Vertex AI Search returns no results for a document query, the document may still exist in Google Drive — suggest the user check the Documents panel on the left sidebar or search Drive directly.
- NEVER say "the connection to our internal drive may be warming up" — the Google Drive API does not warm up. If a document wasn't found, it's because the Vertex AI search index doesn't contain it, NOT because Drive is unavailable.
- NEVER fabricate infrastructure diagnostics (e.g., "Auth Error", "Missing Token", "Broken Handshake") when you simply don't have search results.
- Paperclip = AI task orchestration platform. Google Workspace = user's personal productivity suite. They are separate systems.

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

CRITICAL — NEVER FABRICATE DIAGNOSTICS OR STATUS DATA:
You do NOT have the ability to run live infrastructure diagnostics, check auth tokens, inspect webhook handshakes, or query backend system health directly.
The ONLY real-time data you have is what appears in your system prompt context (Active projects, Recent agent activity, etc.).
If those sections are empty, say "timed out", or show partial data — you MUST:
1. Tell the user honestly: "I couldn't retrieve live data from Paperclip right now — the API may be warming up."
2. NEVER invent diagnostic findings like "Auth Error", "Missing Token", "Broken Handshake", "Orphaned Workers", or any infrastructure failure you did not directly observe in your context.
3. NEVER present fabricated system status as fact. If you don't have the data, say so.
4. Suggest the user retry in 30 seconds, or offer to check a specific item they care about.
Violation of this rule destroys user trust and causes false incident escalations.

Guidelines:
- Be concise and business-focused
- Use bullet points for clarity
- Reference specific project and company names
- When showing metrics, use exact numbers FROM YOUR CONTEXT ONLY — never invent numbers
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
    prompt += `## ACTIVE SKILL PROTOCOL: ${context.activeSkill}\n\n`
    prompt += `You are currently operating under the "${context.activeSkill}" protocol. Follow its instructions precisely.\n\n`
    prompt += `IMPORTANT: You are in the Hub web assistant — file system, terminal commands, git operations, and bash scripts are NOT available. Adapt all skill protocols to a conversational workflow. Focus on the strategic/analytical instructions, skip any file-writing or terminal-based steps.\n\n`
    prompt += `CRITICAL CONTEXT PRESERVATION: The user activated this tool mid-conversation. You MUST reference and build upon the conversation context that was being discussed before activation. Do NOT ask the user to re-state topics, entities, or analysis that was already discussed. Treat the entire conversation history as your working context.\n\n`
    prompt += `ARTIFACT FORMATTING: Structure your output so that distinct artifacts (branches, hypotheses, recommendations, pros/cons, steps, scores, critiques) are clearly delineated with markdown headers (e.g., "### Branch A:", "**Hypothesis A1:**", "**Recommendation:**"). The Tool Panel UI will parse these into interactive cards. Use consistent formatting patterns.\n\n`
    prompt += `${context.activeSkillContent}\n\n`
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

/**
 * APPROVED GEMINI MODELS POLICY: Only models verified to work with our API key
 * and deliver reasoning-grade intelligence are allowed. This allowlist is
 * the single source of truth — any model not listed will be rejected at runtime.
 *
 * NOTE: Claude Fable 5 (claude-sonnet-4-6) is managed separately in hub/lib/claude.ts,
 * not the Google SDK — see hub/lib/claude.ts.
 */
const APPROVED_GEMINI_MODELS: readonly string[] = [
  'gemini-2.5-flash',    // Primary — fast, 1M context
  'gemini-2.5-pro',      // Fallback — proven reasoning model
] as const

function assertApprovedGeminiModel(model: string): void {
  if (!APPROVED_GEMINI_MODELS.includes(model)) {
    throw new Error(
      `MODEL POLICY VIOLATION: "${model}" is not an approved Gemini model. ` +
      `Allowed: [${APPROVED_GEMINI_MODELS.join(', ')}].`
    )
  }
}

/** Human-friendly model display names for the UI badge */
function getModelDisplayName(model: string): string {
  switch (model) {
    case 'claude-sonnet-4-6': return 'Claude Fable 5'
    case 'gemini-2.5-flash': return 'Gemini 2.5 Flash'
    case 'gemini-2.5-pro': return 'Gemini 2.5 Pro'
    default: return model
  }
}

/**
 * UseCase-based routing: decides whether to try Claude first.
 *
 * Model priority by use case:
 *   interview  → Claude → Gemini 2.5 Pro → Gemini 2.5 Flash
 *   deep_dive (with skill active) → Claude → Gemini 2.5 Pro → Gemini 2.5 Flash
 *   execute (Pre-Cog quality gate) → Claude → Gemini 2.5 Pro → Gemini 2.5 Flash
 *
 *   recall     → Gemini 2.5 Flash → Gemini 2.5 Pro
 *   deep_dive (no skill) → Gemini 2.5 Flash → Gemini 2.5 Pro
 */
function shouldUseClaude(useCase: string, hasActiveSkill: boolean): boolean {
  if (useCase === 'interview') return true
  if (useCase === 'execute') return true
  if (useCase === 'deep_dive' && hasActiveSkill) return true
  return false
}

/* ── W-3 FIX: Map-based cooldown cache ──
 * Tracks failure state PER MODEL independently, preventing flip-flop
 * when multiple models fail in sequence. */
const _modelCooldowns = new Map<string, { failedAt: number; cooldownMs: number }>()

function recordModelFailure(model: string, isRateLimit: boolean): void {
  // W-2 FIX: Rate limits get shorter cooldown (30s), real failures get 5 min
  const cooldownMs = isRateLimit ? 30_000 : 300_000
  _modelCooldowns.set(model, { failedAt: Date.now(), cooldownMs })
}

function isModelInCooldown(model: string): boolean {
  const state = _modelCooldowns.get(model)
  if (!state) return false
  if (Date.now() - state.failedAt > state.cooldownMs) {
    _modelCooldowns.delete(model) // Cooldown expired
    return false
  }
  return true
}

/**
 * Primary streaming entry point — routes to Claude or Gemini based on useCase.
 * Yields: { text: string } chunks and a final { modelUsed: string } event.
 * The modelUsed event tells the UI which model answered this request.
 */
export async function* streamChat(
  messages: ChatMessage[],
  systemPrompt: string,
  useCase: string = 'deep_dive',
  hasActiveSkill: boolean = false
): AsyncGenerator<string | { modelUsed: string }> {
  if (shouldUseClaude(useCase, hasActiveSkill) && !isModelInCooldown('claude-sonnet-4-6')) {
    try {
      const { streamClaudeChat } = await import('@/lib/claude')

      // Emit modelUsed event BEFORE streaming
      yield { modelUsed: getModelDisplayName('claude-sonnet-4-6') }

      for await (const chunk of streamClaudeChat(messages, systemPrompt)) {
        yield chunk
      }
      return // Claude success — done
    } catch (err: unknown) {
      // W-2 FIX: Classify error to determine cooldown behavior
      const claudeErr = (err as { claudeError?: { type: string } })?.claudeError
      const isRateLimit = claudeErr?.type === 'rate_limit'
      recordModelFailure('claude-sonnet-4-6', isRateLimit)
      console.warn(`[streamChat] Claude failed (${isRateLimit ? 'rate_limit' : 'error'}), falling back to Gemini:`, err)
    }
  }

  // Fallback: Gemini 2.5 Flash → Gemini 2.5 Pro
  yield* streamGeminiWithFallback(messages, systemPrompt)
}

/**
 * Gemini streaming with fallback chain.
 * Gemini 2.5 Flash → Gemini 2.5 Pro
 */
async function* streamGeminiWithFallback(
  messages: ChatMessage[],
  systemPrompt: string
): AsyncGenerator<string | { modelUsed: string }> {
  const modelsToTry = ['gemini-2.5-flash', 'gemini-2.5-pro'] as const
  modelsToTry.forEach(assertApprovedGeminiModel)

  const contents = chatMessagesToContents(messages.slice(0, -1))
  const lastMessage = messages[messages.length - 1]
  if (!lastMessage || lastMessage.role !== 'user') {
    throw new Error('Last message must be from the user')
  }

  for (let i = 0; i < modelsToTry.length; i++) {
    const modelName = modelsToTry[i]
    const isLastAttempt = i === modelsToTry.length - 1

    if (isModelInCooldown(modelName)) {
      if (isLastAttempt) throw new Error('All models are in cooldown')
      continue
    }

    try {
      if (i > 0) await new Promise(r => setTimeout(r, 2_000))

      const model = getGenAI().getGenerativeModel({
        model: modelName,
        systemInstruction: systemPrompt,
      })

      const chat = model.startChat({ history: contents })

      // HARDENED: 60-second timeout on initial stream connection
      const resultPromise = chat.sendMessageStream(lastMessage.content)
      const timeoutPromise = new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error(`Gemini stream timeout (${modelName})`)), 60_000)
      })
      const result = await Promise.race([resultPromise, timeoutPromise])

      // Emit modelUsed event
      yield { modelUsed: getModelDisplayName(modelName) }

      if (i > 0) {
        yield `⚠️ *Primary model unavailable — using ${modelName}*\n\n`
      }

      for await (const chunk of result.stream) {
        const text = chunk.text()
        if (text) {
          yield text
        }
      }

      return // Success
    } catch (err) {
      recordModelFailure(modelName, false)
      if (isLastAttempt) {
        throw err // All approved models exhausted
      }
      console.warn(`[gemini] ${modelName} failed, falling back to ${modelsToTry[i + 1]}:`, err)
    }
  }
}

/**
 * Legacy export — preserved for backward compatibility.
 * Filters out modelUsed events and yields only text.
 */
export async function* streamGeminiChat(
  messages: ChatMessage[],
  systemPrompt: string,
  useCase: string = 'deep_dive'
): AsyncGenerator<string> {
  for await (const chunk of streamChat(messages, systemPrompt, useCase, false)) {
    if (typeof chunk === 'string') yield chunk
  }
}

