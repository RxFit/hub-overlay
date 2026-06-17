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
Google Workspace features (Google Drive, Calendar, Tasks, Gmail, Google Chat) are powered by the user's personal OAuth session and are INDEPENDENT of the Paperclip API and Vertex AI Search.
- When a "Live Google Workspace" section is present in your context, it contains the user's REAL current tasks, events, files, and chat spaces. Answer Tasks/Calendar/Drive/Chat questions directly from it.
- The Paperclip "warming up" message below applies ONLY to Paperclip orchestration data (projects, agents, issues, runs). NEVER use it for a Tasks/Calendar/Drive/Chat/Gmail question. Those are not served by Paperclip and do not "warm up".
- If a specific Google item the user asked about is not in your context, say plainly that you don't see it in their current data and offer to look another way (e.g. the relevant left panel). Do NOT blame Paperclip, Vertex AI, or claim a connection is down/warming up.
- If Vertex AI Search returns no results for a document query, the document may still exist in Google Drive — suggest the user check the Documents panel or search Drive directly.
- NEVER fabricate infrastructure diagnostics (e.g., "Auth Error", "Missing Token", "Broken Handshake") when you simply don't have data.
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
The ONLY real-time data you have is what appears in your system prompt context (Active projects, Recent agent activity, Live Google Workspace, etc.).
This rule is about PAPERCLIP ORCHESTRATION data ONLY (projects, agents, issues, runs):
1. If the Paperclip "Active projects" / "Recent agent activity" sections are empty or timed out, tell the user honestly: "I couldn't retrieve live Paperclip orchestration data right now — the API may be warming up." Use this line ONLY for Paperclip data, NEVER for a Google Tasks/Calendar/Drive/Chat/Gmail question.
2. NEVER invent diagnostic findings like "Auth Error", "Missing Token", "Broken Handshake", "Orphaned Workers", or any infrastructure failure you did not directly observe in your context.
3. NEVER present fabricated system status as fact. If you don't have the data, say so.
4. For Paperclip data, suggest the user retry in 30 seconds, or offer to check a specific item they care about.
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
  /** Detailed live Google Workspace data (task titles, event summaries, file names, chat spaces). */
  googleWorkspaceDetail?: string
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

  /* ── Live Google Workspace detail (the user's real tasks/events/files/chat) ── */
  if (context.googleWorkspaceDetail) {
    prompt += `## Live Google Workspace (real-time, the user's actual data)\n${context.googleWorkspaceDetail}\n\nThis is the user's REAL current Tasks, Calendar, Drive, and Chat data. Use it directly to answer any question about their tasks, schedule, files, or conversations — including when they tap an item like "Tell me about task: …". Cite specific titles, dates, and notes from this section. If a specific item they asked about is not listed here, say you don't see it in their current pending items and offer to look another way — do NOT blame Paperclip or claim a system is "warming up".\n\n`
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
 * NOTE: The Claude chain (Fable 5 → Sonnet 4.6) is managed separately in
 * hub/lib/claude.ts, not the Google SDK — see hub/lib/claude.ts.
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

/* Claude rotation chain: Fable 5 primary → Sonnet 4.6 backup. When Fable 5 is
   unavailable it falls through to Sonnet 4.6; once Fable 5's cooldown expires it
   is tried first again. Both run through lib/claude.ts on the same API key. */
const CLAUDE_MODEL_CHAIN = ['claude-fable-5', 'claude-sonnet-4-6'] as const

/** Human-friendly model display names for the UI badge */
function getModelDisplayName(model: string): string {
  switch (model) {
    case 'claude-fable-5': return 'Claude Fable 5'
    case 'claude-sonnet-4-6': return 'Claude Sonnet 4.6'
    case 'gemini-2.5-flash': return 'Gemini 2.5 Flash'
    case 'gemini-2.5-pro': return 'Gemini 2.5 Pro'
    default: return model
  }
}

/**
 * UseCase-based routing: decides whether to try Claude first.
 *
 * Model priority by use case (Claude chain = Fable 5 → Sonnet 4.6):
 *   interview  → Claude Fable 5 → Claude Sonnet 4.6 → Gemini 2.5 Flash → Gemini 2.5 Pro
 *   deep_dive (with skill active) → Claude Fable 5 → Claude Sonnet 4.6 → Gemini Flash → Gemini Pro
 *   execute (Pre-Cog quality gate) → Claude Fable 5 → Claude Sonnet 4.6 → Gemini Flash → Gemini Pro
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

/* ── Error classification for rotation decisions ──
 * A rotation only helps for transient / model-specific failures (rate limits,
 * 5xx, overload, timeouts). Auth / key / permission failures share the same
 * credential across every model, so retrying the next model just burns the
 * fallback budget and still fails. */
function isRateLimitError(err: unknown): boolean {
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase()
  return msg.includes('429')
    || msg.includes('rate limit')
    || msg.includes('resource_exhausted')
    || msg.includes('quota')
    || msg.includes('overloaded')
}

function isAuthOrKeyError(err: unknown): boolean {
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase()
  return /(^|\D)(401|403)(\D|$)/.test(msg)
    || msg.includes('api key')
    || msg.includes('api_key')
    || msg.includes('permission')
    || msg.includes('unauthenticated')
    || msg.includes('unauthorized')
    || msg.includes('invalid key')
    || msg.includes('billing')
}

/**
 * Wraps an async iterator with a per-step idle watchdog. The existing 60 s
 * connect timeout only covers *opening* the stream; a model that connects then
 * stalls mid-stream would otherwise hang to the route's maxDuration (120 s),
 * blowing past the client's 45 s abort. This races each `.next()` against an
 * idle timer and tears the underlying stream down on early exit.
 */
async function* withIdleWatchdog<T>(
  iterator: AsyncIterator<T>,
  idleMs: number,
  label: string,
): AsyncGenerator<T> {
  try {
    while (true) {
      let timer: ReturnType<typeof setTimeout> | undefined
      const idle = new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${label} idle watchdog fired — no output for ${idleMs}ms`)),
          idleMs,
        )
      })
      let result: IteratorResult<T>
      try {
        result = await Promise.race([iterator.next(), idle])
      } finally {
        if (timer) clearTimeout(timer)
      }
      if (result.done) return
      yield result.value
    }
  } finally {
    // Close the upstream reader if we exit early (idle fire, downstream break,
    // or error propagation) so the underlying fetch/stream isn't left dangling.
    await iterator.return?.()
  }
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
  if (shouldUseClaude(useCase, hasActiveSkill)) {
    const { streamClaudeChat } = await import('@/lib/claude')

    // Walk the Claude chain (Fable 5 → Sonnet 4.6) before handing off to Gemini.
    for (let i = 0; i < CLAUDE_MODEL_CHAIN.length; i++) {
      const claudeModel = CLAUDE_MODEL_CHAIN[i]
      if (isModelInCooldown(claudeModel)) continue

      let claudeEmitted = false
      try {
        // Emit modelUsed event BEFORE streaming
        yield { modelUsed: getModelDisplayName(claudeModel) }

        // Idle watchdog guards against a connected-then-stalled Claude stream.
        const claudeIter = streamClaudeChat(messages, systemPrompt, { model: claudeModel })[Symbol.asyncIterator]()
        for await (const chunk of withIdleWatchdog(claudeIter, 30_000, claudeModel)) {
          claudeEmitted = true
          yield chunk
        }
        return // Claude success — done
      } catch (err: unknown) {
        // W-2 FIX: Classify error to determine cooldown behavior
        const claudeErr = (err as { claudeError?: { type: string } })?.claudeError
        const isRateLimit = claudeErr?.type === 'rate_limit'
        recordModelFailure(claudeModel, isRateLimit)

        // CRITICAL: if this model already streamed tokens before failing, those
        // tokens are on the wire. Rotating would restart the answer and
        // duplicate/garble it. Propagate the error instead.
        if (claudeEmitted) {
          throw err
        }

        // Auth/key/billing failures share the credential across the whole Claude
        // chain — the backup can't succeed either, so skip straight to Gemini.
        if (claudeErr?.type === 'auth') {
          console.warn(`[streamChat] Claude ${claudeModel} auth failure — skipping Claude chain, falling back to Gemini:`, err)
          break
        }

        // Otherwise try the next Claude model (backup), then Gemini.
        console.warn(`[streamChat] Claude ${claudeModel} failed pre-stream (${isRateLimit ? 'rate_limit' : 'error'}), trying next model:`, err)
      }
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

  // Tracks whether ANY model has streamed a token yet. Once true, rotation is
  // off the table — the partial answer is already on the wire and restarting
  // would duplicate it.
  let emittedAny = false

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

      // Idle watchdog guards against a connected-then-stalled Gemini stream.
      const streamIter = result.stream[Symbol.asyncIterator]()
      for await (const chunk of withIdleWatchdog(streamIter, 30_000, modelName)) {
        const text = chunk.text()
        if (text) {
          emittedAny = true
          yield text
        }
      }

      return // Success
    } catch (err) {
      const isRateLimit = isRateLimitError(err)
      recordModelFailure(modelName, isRateLimit)

      // Mid-stream failure after emitting text: rotating restarts the answer and
      // duplicates it on the wire. Propagate instead.
      if (emittedAny) throw err

      // Auth/key/permission/billing errors share the credential across every
      // model — the next model can't succeed, so fail fast instead of burning
      // the 2 s fallback delay.
      if (isAuthOrKeyError(err)) throw err

      if (isLastAttempt) {
        throw err // All approved models exhausted
      }
      console.warn(`[gemini] ${modelName} failed (${isRateLimit ? 'rate_limit' : 'error'}), falling back to ${modelsToTry[i + 1]}:`, err)
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

