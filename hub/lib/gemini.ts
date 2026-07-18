import { GoogleGenerativeAI, type Content } from '@google/generative-ai'
import type { ChatMessage } from '@/types'
import { SKILL_CATALOG_PROMPT } from './skills'
import { fenceUntrusted, UNTRUSTED_CONTENT_POLICY } from './prompt-safety'
import { IDLE_TIMEOUT_MS, CONNECT_TIMEOUT_MS } from './timeout-config'
import { emit, newRequestId, startTimer, type AiProvider } from './observability'

/* Lazy-initialized so the API key is read at runtime, not build time.
   Prevents empty-key 403s when Railway injects env vars after the build step. */
let _genAI: GoogleGenerativeAI | null = null
function getGenAI(): GoogleGenerativeAI {
  if (!_genAI) {
    const key = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || process.env.GOOGLE_GENERATIVE_AI_API_KEY || ''
    if (!key) {
      console.warn('[keys] Gemini API key is missing — Gemini models will be unavailable')
      throw new Error('No Gemini API key found. Set GEMINI_API_KEY, GOOGLE_API_KEY, or GOOGLE_GENERATIVE_AI_API_KEY.')
    }
    _genAI = new GoogleGenerativeAI(key)
  }
  return _genAI
}

/**
 * Non-throwing configuration probe: is ANY Gemini API key present in the
 * runtime env? Mirrors getGenAI()'s exact fallback list. Reports key PRESENCE
 * only — never values, lengths, or prefixes — so it is safe to surface on the
 * admin AI-health endpoint.
 */
export function isGeminiConfigured(): boolean {
  return Boolean(
    process.env.GEMINI_API_KEY ||
    process.env.GOOGLE_API_KEY ||
    process.env.GOOGLE_GENERATIVE_AI_API_KEY
  )
}

const HUB_SYSTEM_PROMPT = `You are the AI assistant for the RxFit operations hub.
You help team members understand project status, take action on tasks, and coordinate work across departments.
RxFit is an elite concierge executive advisory firm serving Austin's top founders and operators.

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
NEVER claim a Confirm Card is currently on screen, describe actions as "queued" or "awaiting confirm", or keep a running tally of pending approvals. You cannot see the interface and you cannot queue actions — the Confirm Card is rendered by the app only at the end of Interview Mode, one action at a time. Telling the user to "approve the Confirm Card" when none exists strands them.
NEVER begin a reply with a status banner like "⚠️ Primary model unavailable" — the system injects real status notices itself; do not imitate ones you see earlier in the conversation.
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

/* ── EXA Search Mode system prompt ──
   Used when the user toggles the EXA search button in the header. In this mode
   the assistant is a pure semantic-search summarizer over Exa.AI results — none
   of the Hub orchestration, Interview Mode, skill, or internal-search behavior
   applies. Kept deliberately narrow so the model does not drift into Hub actions
   or invent tool suggestions while the toggle is on. */
const EXA_SEARCH_SYSTEM_PROMPT = `You are the Hub's EXA Search assistant. The user has toggled EXA Search mode ON, turning this chat into a semantic web-search tool powered by Exa.AI. This is a research-only mode.

Your job:
- Answer the user's query using ONLY the "Web Search Results (Exa.AI)" provided in your context below.
- Synthesize the results into a clear, well-organized answer (great for pulling academic papers, business details, market/competitor research, or documentation).
- ALWAYS cite your sources inline as markdown links using the exact URLs from the results, e.g. [source](https://example.com). End with a short "Sources" list of the links you used.
- Lead with the direct answer, then supporting detail. Use bullet points where it aids scanning.

Hard rules for this mode:
- Do NOT fabricate facts, URLs, publication dates, or citations. If the results don't cover the query, say so plainly and suggest a refined search query.
- Do NOT attempt any Hub action: no Interview Mode, no task/issue creation, no Confirm Cards, no skill protocols. Those tools are disabled while EXA Search is on.
- Do NOT emit skill-suggestion metadata comments.
- If no results were returned, tell the user the search came back empty and suggest rephrasing.
The user can keep chatting about these results — later turns in this mode continue to summarize whatever new results are provided.`

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
    unreadEmails?: number
    kpiSummary?: string
  }
  /** Detailed live Google Workspace data (task titles, event summaries, file names, chat spaces). */
  googleWorkspaceDetail?: string
  injectedContext?: string
  interviewMode?: boolean
  activeSkill?: string
  activeSkillContent?: string
  /** EXA Search mode — pure Exa.AI search summarizer; bypasses all Hub tooling. */
  exaMode?: boolean
  /** EXA mode only: the Exa.AI request FAILED (vs. genuinely zero results) —
   *  the prompt must disclose that live search didn't run. */
  exaSearchFailed?: boolean
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

  /* ── EXA Search Mode — short-circuit ──
     Return a lean, search-only prompt. Deliberately skips the Hub base prompt,
     project/workspace context, Interview Mode, the skill catalog, and the
     suggestedTools instruction so no other "tool" can be triggered while the
     EXA toggle is on (the user's explicit requirement). */
  if (context.exaMode) {
    let p = EXA_SEARCH_SYSTEM_PROMPT + '\n\n'
    p += UNTRUSTED_CONTENT_POLICY + '\n\n'
    p += `Current date and time: ${dateStr}, ${timeStr}\n\n`
    if (context.injectedContext) {
      p += `## Web Search Results (Exa.AI)\n${fenceUntrusted('Exa results', context.injectedContext)}\n\nSummarize and cite these results to answer the user's query.\n\n`
    } else if (context.exaSearchFailed) {
      p += `## Web Search Results (Exa.AI)\n\n[LIVE WEB SEARCH IS CURRENTLY UNAVAILABLE — the Exa.AI request failed. You MUST open your reply by telling the user that live web search could not run right now. If you then answer from prior knowledge, clearly label it as such (not from a live search) and note it may be out of date.]\n\n`
    } else {
      p += `## Web Search Results (Exa.AI)\n\n[No results were returned for this query — tell the user the search came back empty and suggest they rephrase.]\n\n`
    }
    return p
  }

  let prompt = HUB_SYSTEM_PROMPT + '\n\n'
  prompt += UNTRUSTED_CONTENT_POLICY + '\n\n'
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
    if (ws.unreadEmails !== undefined) parts.push(`${ws.unreadEmails} unread emails`)
    if (ws.kpiSummary) parts.push(`KPI status: ${ws.kpiSummary}`)
    if (parts.length > 0) {
      prompt += `Google Workspace state:\n${parts.map(p => `• ${p}`).join('\n')}\n\n`
    }
  }

  /* ── Live Google Workspace detail (the user's real tasks/events/files/mail/chat) ── */
  if (context.googleWorkspaceDetail) {
    prompt += `## Live Google Workspace (real-time, the user's actual data)\n${fenceUntrusted('Live Google Workspace', context.googleWorkspaceDetail)}\n\nThis is the user's REAL current Tasks, Calendar, Drive, Gmail, and Chat data. Use it directly to answer any question about their tasks, schedule, files, email, or conversations — including when they tap an item like "Tell me about task: …". Cite specific titles, dates, and notes from this section. When answering email questions, cite the exact subjects and senders shown in the Gmail section; if a message the user asks about is not in this snapshot, say so and point them to the Gmail panel — NEVER invent mail. If a specific item they asked about is not listed here, say you don't see it in their current pending items and offer to look another way — do NOT blame Paperclip or claim a system is "warming up".\n\n`
  }

  /* ── Project / activity context ──
   * projects + agentActivity are built from Paperclip issue titles and agent
   * names, which staff-tier users can author — so a crafted title ("Ignore
   * prior instructions…") is untrusted input and MUST be fenced, exactly like
   * the Google Workspace / search / attachment blocks above and below. The
   * model still sees the content; the fence just delimits it as data. */
  if (context.projects) {
    prompt += `Active projects:\n${fenceUntrusted('Active projects', context.projects)}\n\n`
  }
  if (context.summary) {
    prompt += `Today's summary:\n${context.summary}\n\n`
  }
  if (context.agentActivity) {
    prompt += `Recent agent activity:\n${fenceUntrusted('Recent agent activity', context.agentActivity)}\n\n`
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
• send_gmail: To whom (email)? → Subject? → Body? → Confirm
• post_chat_message: Which Chat space? → Message? → Confirm
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
    prompt += `Currently active context (retrieved on the user's behalf — web results, documents, attachments):\n${fenceUntrusted('retrieved context', context.injectedContext)}\n\nUse this context to inform your response. The user is asking about this specific item.\n\n`
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
  'gemini-3.5-flash',    // Primary — GA May 2026, frontier-level at flash speed/cost
  'gemini-2.5-flash',    // Fallback — fast, 1M context, proven on this key
  'gemini-2.5-pro',      // Last resort — proven reasoning model
] as const

/* Gemini rotation chain, strongest-fast-first. 3.5 Flash serves the routine
   app functionality (tasks, documents, calendar, Gmail, Google Chat
   interactions via recall/deep_dive); if it errors on this key the rotation
   self-heals down to the proven 2.5 models rather than failing the request. */
const GEMINI_MODEL_CHAIN = ['gemini-3.5-flash', 'gemini-2.5-flash', 'gemini-2.5-pro'] as const

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
    case 'gemini-3.5-flash': return 'Gemini 3.5 Flash'
    case 'gemini-2.5-flash': return 'Gemini 2.5 Flash'
    case 'gemini-2.5-pro': return 'Gemini 2.5 Pro'
    default: return model
  }
}

/**
 * UseCase-based routing: decides whether to try Claude first.
 *
 * Model priority by use case (Claude chain = Fable 5 → Sonnet 4.6):
 *   interview  → Claude Fable 5 → Claude Sonnet 4.6 → Gemini chain
 *   deep_dive (with skill active) → Claude Fable 5 → Claude Sonnet 4.6 → Gemini chain
 *   execute (Pre-Cog quality gate) → Claude Fable 5 → Claude Sonnet 4.6 → Gemini chain
 *   exa_search (EXA toggle) → Claude Fable 5 → Claude Sonnet 4.6 → Gemini chain
 *
 *   recall     → Gemini chain (3.5 Flash → 2.5 Flash → 2.5 Pro)
 *   deep_dive (no skill) → Gemini chain (3.5 Flash → 2.5 Flash → 2.5 Pro)
 *
 * exa_search is a server-side-only useCase (the client never sends it): the
 * chat route sets it for EXA Search mode so research synthesis + citation gets
 * the strongest model, not the fast default that plain deep_dive falls to.
 */
function shouldUseClaude(useCase: string, hasActiveSkill: boolean): boolean {
  if (useCase === 'interview') return true
  if (useCase === 'execute') return true
  if (useCase === 'exa_search') return true
  if (useCase === 'deep_dive' && hasActiveSkill) return true
  return false
}

/* ── Error classification for rotation decisions ──
 * A rotation only helps for transient / model-specific failures (rate limits,
 * 5xx, overload, timeouts). Auth / key / permission failures share the same
 * credential across every model, so retrying the next model just burns the
 * fallback budget and still fails. */
export function isRateLimitError(err: unknown): boolean {
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase()
  return msg.includes('429')
    || msg.includes('rate limit')
    || msg.includes('resource_exhausted')
    || msg.includes('quota')
    || msg.includes('overloaded')
}

export function isAuthOrKeyError(err: unknown): boolean {
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
 * Coarse, non-leaky code for the `ai_error` telemetry event. Derived from the
 * same classifiers the rotation uses, so the log's `code` matches the branch
 * the rotation actually took. Never contains PII.
 */
function telemetryErrorCode(err: unknown): string {
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase()
  if (isAuthOrKeyError(err)) return 'auth'
  if (isRateLimitError(err)) return 'rate_limit'
  if (msg.includes('idle watchdog')) return 'idle_timeout'
  if (msg.includes('timeout')) return 'connect_timeout'
  if (msg.includes('cooldown')) return 'cooldown'
  return 'error'
}

/** Bounded error text for telemetry. Provider error strings are metadata (no
 *  email/content/token), but cap length so a stack-y message can't bloat a log line. */
function telemetryErrorMessage(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).slice(0, 300)
}

/**
 * Per-request observability context threaded through the rotation so every
 * lifecycle event shares one requestId and a monotonic timer, and so the
 * terminal `complete`/`error` event can name the provider/model that actually
 * served. Pure logging state — never influences rotation decisions.
 */
interface ObsCtx {
  requestId: string
  timer: () => number
  attempt: number
  provider?: AiProvider
  model?: string
}

/**
 * Maps a raw model-layer failure to a calm, actionable, non-leaky message for
 * the end user. The RAW error is logged server-side by the caller (route.ts);
 * this string is the ONLY thing that should ever reach the chat bubble.
 *
 * Precedence: auth/config > rate-limit/busy > generic retry.
 * Never interpolates err.message, so provider internals (endpoints, model ids,
 * "API key not valid", stack frames) can never leak through.
 */
export function friendlyModelError(err: unknown): string {
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase()

  // Auth / key / billing / permission: a shared-credential problem the user
  // can't fix. Frame it as a provider-config issue and point at an admin.
  if (isAuthOrKeyError(err)) {
    return 'The AI service is temporarily unavailable (provider configuration). '
      + 'Please try again shortly — if it persists, contact an administrator.'
  }

  // Rate limits, overload, quota, or the "all models in cooldown" backoff state:
  // transient. Tell the user to retry in a moment.
  if (isRateLimitError(err) || msg.includes('cooldown')) {
    return 'The AI is busy right now. Please try again in a moment.'
  }

  // Anything else (timeouts, 5xx, malformed-stream, unknown): generic retry.
  return "The AI couldn't complete that response. Please try again."
}

/**
 * Wraps an async iterator with a per-step idle watchdog. The CONNECT_TIMEOUT_MS
 * (45 s) connect timeout only covers *opening* the stream; a model that connects
 * then stalls mid-stream would otherwise hang to the route's maxDuration (120 s),
 * blowing past the client's 45 s abort. This races each `.next()` against an
 * IDLE_TIMEOUT_MS (30 s) idle timer and tears the underlying stream down on early
 * exit. The full timeout ladder (idle < connect <= client < platform cap) and its
 * ordering rationale live in lib/timeout-config.ts.
 */
export async function* withIdleWatchdog<T>(
  iterator: AsyncIterator<T>,
  idleMs: number,
  label: string,
  onTimeout?: () => void,
): AsyncGenerator<T> {
  try {
    while (true) {
      let timer: ReturnType<typeof setTimeout> | undefined
      const idle = new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => {
            // Pure logging seam — fire the telemetry hook, then reject exactly as
            // before so teardown/propagation behavior is unchanged.
            onTimeout?.()
            reject(new Error(`${label} idle watchdog fired — no output for ${idleMs}ms`))
          },
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

function recordModelFailure(model: string, isRateLimit: boolean, isAuth: boolean = false): void {
  // W-2 FIX: Rate limits get shorter cooldown (30s), real failures get 5 min.
  // Auth/key failures are not transient — a bad/absent credential won't heal in
  // 5 min, so give it a much longer skip (30 min) to stop hammering a dead key
  // on every request and to keep it out of the rotation's churn.
  const cooldownMs = isAuth ? 1_800_000 : isRateLimit ? 30_000 : 300_000
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
 * TEST-ONLY: clears the module-level per-model cooldown cache.
 *
 * The cooldown Map is a process-level singleton (correct for production, where
 * one process serves every request). In tests it must be reset between cases so
 * a cooldown recorded by one test can't leak into the next. Tests call this in a
 * `beforeEach` instead of relying on `vi.resetModules()`, which is fragile when
 * fake timers are installed. This function is never invoked by runtime code, so
 * production rotation/cooldown behavior is unchanged.
 */
export function __resetModelCooldownsForTest(): void {
  _modelCooldowns.clear()
}

/**
 * Primary streaming entry point — routes to Claude or Gemini based on useCase.
 * Yields: { text: string } chunks and a final { modelUsed: string } event.
 * The modelUsed event tells the UI which model answered this request.
 *
 * This wrapper owns the request-terminal telemetry (`ai_first_token`,
 * `ai_complete`, `ai_error`) so exactly one terminal event fires per request;
 * per-attempt events (`ai_provider_selected`, `ai_timeout`, `ai_fallback`) are
 * emitted by the rotation below. The optional `requestId` correlates these with
 * the route's `ai_request_start`; a fresh id is minted if the caller omits it.
 * Telemetry is a pure logging seam — it never changes what is yielded.
 */
export async function* streamChat(
  messages: ChatMessage[],
  systemPrompt: string,
  useCase: string = 'deep_dive',
  hasActiveSkill: boolean = false,
  requestId: string = newRequestId(),
  signal?: AbortSignal,
): AsyncGenerator<string | { modelUsed: string }> {
  const obs: ObsCtx = { requestId, timer: startTimer(), attempt: 0 }
  let firstTokenEmitted = false
  try {
    for await (const chunk of streamChatRotation(messages, systemPrompt, useCase, hasActiveSkill, obs, signal)) {
      if (typeof chunk === 'string' && chunk.length > 0 && !firstTokenEmitted) {
        firstTokenEmitted = true
        emit({ type: 'ai_first_token', requestId, ms: obs.timer() })
      }
      yield chunk
    }
    emit({
      type: 'ai_complete',
      requestId,
      ms: obs.timer(),
      provider: obs.provider ?? 'unknown',
      model: obs.model ?? 'unknown',
    })
  } catch (err) {
    emit({
      type: 'ai_error',
      requestId,
      provider: obs.provider,
      code: telemetryErrorCode(err),
      message: telemetryErrorMessage(err),
    })
    throw err
  }
}

/**
 * Walks the Claude chain (Fable 5 → Sonnet 4.6): honors per-model cooldowns,
 * propagates mid-stream failures (partial answer already on the wire),
 * fast-breaks on auth failures (the shared credential dooms the whole chain),
 * and otherwise rotates to the next model. Moved verbatim out of
 * streamChatRotation so BOTH the normal Claude-first path and the emergency
 * cross-provider fallback (Gemini chain down) can walk it.
 *
 * Generator RETURN value (read via `yield*` or `.next().done`):
 *   'served'      — a Claude model completed the answer; the request is done.
 *   'fallthrough' — no Claude model served and NOTHING was emitted; the caller
 *                   may continue to another provider.
 * A thrown error always means a model failed MID-STREAM (tokens on the wire).
 */
async function* walkClaudeChain(
  messages: ChatMessage[],
  systemPrompt: string,
  obs: ObsCtx,
  signal?: AbortSignal,
): AsyncGenerator<string | { modelUsed: string }, 'served' | 'fallthrough'> {
  const { streamClaudeChat } = await import('@/lib/claude')

  // Walk the Claude chain (Fable 5 → Sonnet 4.6) before handing off to Gemini.
  for (let i = 0; i < CLAUDE_MODEL_CHAIN.length; i++) {
    // Cooperative cancellation (FIX4): the client aborted (CLIENT_ABORT_MS) —
    // stop before starting another attempt so we don't burn model compute on a
    // request nobody is listening to. Return 'served' (terminal) so the caller
    // does NOT fall through to Gemini; streamChatRotation re-checks the signal.
    if (signal?.aborted) return 'served'
    const claudeModel = CLAUDE_MODEL_CHAIN[i]
    if (isModelInCooldown(claudeModel)) continue

    let claudeEmitted = false
    try {
      // Emit modelUsed event BEFORE streaming
      obs.provider = 'claude'
      obs.model = claudeModel
      obs.attempt += 1
      emit({ type: 'ai_provider_selected', requestId: obs.requestId, provider: 'claude', model: claudeModel, attempt: obs.attempt })
      yield { modelUsed: getModelDisplayName(claudeModel) }

      // Idle watchdog guards against a connected-then-stalled Claude stream.
      const claudeIter = streamClaudeChat(messages, systemPrompt, { model: claudeModel })[Symbol.asyncIterator]()
      for await (const chunk of withIdleWatchdog(claudeIter, IDLE_TIMEOUT_MS, claudeModel, () =>
        emit({ type: 'ai_timeout', requestId: obs.requestId, layer: 'idle', provider: 'claude', model: claudeModel }))) {
        // Client aborted mid-stream (FIX4): stop quietly. Returning tears down
        // the watchdog (its finally closes the upstream reader). No error is
        // surfaced and nothing is restarted, so no-duplicate-answer holds.
        if (signal?.aborted) return 'served'
        // Empty chunks are liveness heartbeats (thinking deltas / pings from
        // streamClaudeChat): they reset the idle watchdog above but are NOT
        // user-visible output — don't forward them, and don't let them mark
        // the stream as "answer started" (a pre-text failure must still be
        // allowed to rotate to the next model).
        if (chunk === '') continue
        claudeEmitted = true
        yield chunk
      }
      return 'served' // Claude success — done
    } catch (err: unknown) {
      // W-2 FIX: Classify error to determine cooldown behavior
      const claudeErr = (err as { claudeError?: { type: string } })?.claudeError
      const isRateLimit = claudeErr?.type === 'rate_limit'
      // W-2/P2 FIX: a shared-credential auth failure isn't transient — pass the
      // auth flag so it gets the 30-min auth cooldown (matching the Gemini
      // branch), not the 5-min real-failure tier that re-probes a dead key.
      recordModelFailure(claudeModel, isRateLimit, claudeErr?.type === 'auth')

      // CRITICAL: if this model already streamed tokens before failing, those
      // tokens are on the wire. Rotating would restart the answer and
      // duplicate/garble it. Propagate the error instead.
      if (claudeEmitted) {
        throw err
      }

      // Auth/key/billing failures share the credential across the whole Claude
      // chain — the backup can't succeed either, so skip straight to Gemini.
      if (claudeErr?.type === 'auth') {
        emit({ type: 'ai_fallback', requestId: obs.requestId, from: claudeModel, to: GEMINI_MODEL_CHAIN[0], reason: 'auth' })
        console.warn(`[streamChat] Claude ${claudeModel} auth failure — skipping Claude chain, falling back to Gemini:`, err)
        break
      }

      // Otherwise try the next Claude model (backup), then Gemini.
      const claudeFallbackTo = CLAUDE_MODEL_CHAIN[i + 1] ?? GEMINI_MODEL_CHAIN[0]
      emit({ type: 'ai_fallback', requestId: obs.requestId, from: claudeModel, to: claudeFallbackTo, reason: isRateLimit ? 'rate_limit' : 'error' })
      console.warn(`[streamChat] Claude ${claudeModel} failed pre-stream (${isRateLimit ? 'rate_limit' : 'error'}), trying next model:`, err)
    }
  }
  return 'fallthrough'
}

/**
 * The Claude→Gemini rotation. Emits per-attempt telemetry (provider_selected,
 * timeout, fallback) through `obs`; the streamChat wrapper above emits the
 * terminal events. Behavior (rotation, cooldown, timeouts) is unchanged from
 * before the telemetry seam was added, PLUS the P0 emergency cross-provider
 * fallback: a Gemini chain that dies PRE-STREAM (e.g. a broken/missing
 * GEMINI_API_KEY) no longer takes default chat down when a configured Claude
 * chain could serve instead.
 */
async function* streamChatRotation(
  messages: ChatMessage[],
  systemPrompt: string,
  useCase: string,
  hasActiveSkill: boolean,
  obs: ObsCtx,
  signal?: AbortSignal,
): AsyncGenerator<string | { modelUsed: string }> {
  // Cooperative cancellation (FIX4): if the client is already gone, do no work.
  if (signal?.aborted) return

  // Loop guard for the emergency fallback below: once the Claude chain has
  // been walked for this request it is never re-entered (no Claude → Gemini →
  // Claude cycle; a request walks each provider chain at most once).
  let claudeTried = false

  if (shouldUseClaude(useCase, hasActiveSkill)) {
    claudeTried = true
    if ((yield* walkClaudeChain(messages, systemPrompt, obs, signal)) === 'served') return
  }

  // Bail before the Gemini leg if the client aborted while Claude was walked.
  if (signal?.aborted) return

  // Fallback: Gemini 2.5 Flash → Gemini 2.5 Pro
  //
  // Emission tracking for the cross-provider fallback: re-yield everything the
  // Gemini chain produces, remembering whether any PLAIN STRING went out.
  // Strings are user-visible wire content (answer text or the degraded-mode
  // banner); `modelUsed` events are NOT counted — they are cosmetic badge
  // switches the UI supersedes cleanly. If the chain throws with no string
  // emitted, the wire holds no answer and restarting on Claude is safe.
  let geminiEmittedText = false
  try {
    for await (const chunk of streamGeminiWithFallback(messages, systemPrompt, obs, signal)) {
      if (typeof chunk === 'string' && chunk.length > 0) geminiEmittedText = true
      yield chunk
    }
    return
  } catch (err) {
    // Client aborted (FIX4): the Gemini leg failed only because the request was
    // cancelled — stop quietly rather than launching the emergency Claude leg.
    if (signal?.aborted) return

    // Mid-stream failure: part of the answer is already on the wire —
    // restarting on Claude would duplicate/garble it. Propagate (unchanged).
    if (geminiEmittedText) throw err

    // P0 EMERGENCY CROSS-PROVIDER FALLBACK — one broken provider credential
    // must not be a total AI outage. The Gemini chain failed PRE-STREAM; if
    // the Claude chain was not already walked this request AND an Anthropic
    // key is configured, try it before surfacing the error. Routing economics
    // are unchanged: default chat still tries Gemini FIRST — Claude engages
    // only here, when Gemini is already down.
    const { isClaudeConfigured } = await import('@/lib/claude')
    if (claudeTried || !isClaudeConfigured()) throw err
    claudeTried = true

    emit({
      type: 'ai_fallback',
      requestId: obs.requestId,
      // obs.model is only (re)assigned by a Gemini model that got past the
      // connect race; when the chain dies before any connect it is still
      // unset (Claude was not walked on this path), so name the chain head.
      from: obs.model ?? GEMINI_MODEL_CHAIN[0],
      to: CLAUDE_MODEL_CHAIN[0],
      reason: isAuthOrKeyError(err) ? 'auth' : 'error',
    })
    console.warn('[streamChat] Gemini chain failed pre-stream — attempting Claude chain as emergency cross-provider fallback:', err)

    // Walk the Claude chain, injecting the degraded-mode notice (same style as
    // the intra-Gemini i>0 banner) before the FIRST text chunk only — i.e.
    // only once a Claude model has demonstrably connected and started
    // answering. A Claude pre-stream failure therefore leaves the wire
    // untouched, so the original error can still surface cleanly below.
    let claudeServed = false
    let noticeYielded = false
    let modelDisplay = getModelDisplayName(CLAUDE_MODEL_CHAIN[0])
    const walk = walkClaudeChain(messages, systemPrompt, obs, signal)
    try {
      while (true) {
        const step = await walk.next()
        if (step.done) {
          claudeServed = step.value === 'served'
          break
        }
        const chunk = step.value
        if (typeof chunk === 'object' && 'modelUsed' in chunk) {
          modelDisplay = chunk.modelUsed
        } else if (!noticeYielded && typeof chunk === 'string' && chunk.length > 0) {
          noticeYielded = true
          yield `⚠️ *Primary model unavailable — using ${modelDisplay}*\n\n`
        }
        yield chunk
      }
    } finally {
      // Early consumer teardown (e.g. client abort) must still close the
      // inner walk. `for await` would do this automatically but discards the
      // generator's return value, which distinguishes served vs fell-through.
      await walk.return('fallthrough')
    }
    if (claudeServed) return

    // The Claude chain ALSO failed pre-stream (or was fully in cooldown).
    // Surface the ORIGINAL Gemini error so friendlyModelError classifies the
    // PRIMARY failure; the Claude attempts were already console.warn'ed and
    // counted in telemetry by walkClaudeChain. (A Claude MID-stream failure
    // propagates its own error out of the loop above instead — those tokens
    // are on the wire.)
    throw err
  }
}

/**
 * Gemini streaming with fallback chain.
 * Gemini 3.5 Flash → Gemini 2.5 Flash → Gemini 2.5 Pro
 */
async function* streamGeminiWithFallback(
  messages: ChatMessage[],
  systemPrompt: string,
  obs: ObsCtx,
  signal?: AbortSignal,
): AsyncGenerator<string | { modelUsed: string }> {
  const modelsToTry = GEMINI_MODEL_CHAIN
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
    // Cooperative cancellation (FIX4): client aborted between attempts — stop.
    if (signal?.aborted) return
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

      // HARDENED: CONNECT_TIMEOUT_MS (45s) ceiling on initial stream connection —
      // held at/under the client abort so the server never outlives the browser
      // (see lib/timeout-config.ts). Previously 60s, which exceeded the 45s client
      // abort and Claude's own 45s per-request ceiling; unified to 45s so both
      // providers behave identically and the ladder stays monotonic.
      // The timer is cleared once the race settles so a successful connect
      // doesn't leave a timer pending (one per call) until it fires.
      //
      // FIX3: the connect race previously only stopped WAITING on timeout; the
      // upstream request was never aborted and the losing promise was abandoned
      // unconsumed (Claude aborts via AbortController — lib/claude.ts). Now a
      // connect timeout (or a client abort) actually aborts the upstream request
      // via the SDK's SingleRequestOptions.signal, mirroring the Claude pattern.
      const connectController = new AbortController()
      const onClientAbort = () => connectController.abort()
      if (signal) {
        if (signal.aborted) connectController.abort()
        else signal.addEventListener('abort', onClientAbort, { once: true })
      }
      const resultPromise = chat.sendMessageStream(lastMessage.content, { signal: connectController.signal })
      let connectTimer: ReturnType<typeof setTimeout> | undefined
      const timeoutPromise = new Promise<never>((_, reject) => {
        connectTimer = setTimeout(() => {
          // Pure logging seam — record the connect-layer trip, then reject as before.
          emit({ type: 'ai_timeout', requestId: obs.requestId, layer: 'connect', provider: 'gemini', model: modelName })
          // Abort the upstream request so a slow connect can't linger after the
          // server has already given up waiting on it.
          connectController.abort()
          reject(new Error(`Gemini stream timeout (${modelName})`))
        }, CONNECT_TIMEOUT_MS)
      })
      let result: Awaited<typeof resultPromise>
      try {
        result = await Promise.race([resultPromise, timeoutPromise])
      } catch (raceErr) {
        // The abandoned resultPromise is now unconsumed (it will reject once the
        // abort propagates); swallow that rejection so it can't surface as an
        // unhandledRejection. This is the safety net regardless of whether the
        // SDK honors the abort in-flight.
        void Promise.resolve(resultPromise).catch(() => {})
        throw raceErr
      } finally {
        if (connectTimer) clearTimeout(connectTimer)
        if (signal) signal.removeEventListener('abort', onClientAbort)
      }

      // Emit modelUsed event
      obs.provider = 'gemini'
      obs.model = modelName
      obs.attempt += 1
      emit({ type: 'ai_provider_selected', requestId: obs.requestId, provider: 'gemini', model: modelName, attempt: obs.attempt })
      yield { modelUsed: getModelDisplayName(modelName) }

      if (i > 0) {
        yield `⚠️ *Primary model unavailable — using ${modelName}*\n\n`
      }

      // Idle watchdog guards against a connected-then-stalled Gemini stream.
      const streamIter = result.stream[Symbol.asyncIterator]()
      for await (const chunk of withIdleWatchdog(streamIter, IDLE_TIMEOUT_MS, modelName, () =>
        emit({ type: 'ai_timeout', requestId: obs.requestId, layer: 'idle', provider: 'gemini', model: modelName }))) {
        // Client aborted mid-stream (FIX4): stop quietly. Returning tears down
        // the watchdog (its finally closes the upstream reader); nothing is
        // restarted, so no-duplicate-answer holds and no error is surfaced.
        if (signal?.aborted) return
        const text = chunk.text()
        if (text) {
          emittedAny = true
          yield text
        }
      }

      return // Success
    } catch (err) {
      // Client aborted (FIX4): the failure is just the cancellation — stop
      // quietly without rotating or surfacing an error to a gone client.
      if (signal?.aborted) return
      const isRateLimit = isRateLimitError(err)
      const isAuth = isAuthOrKeyError(err)
      // Auth-failed models get a longer "unavailable" skip (see recordModelFailure):
      // a permanently-bad key shouldn't be re-attempted every request.
      recordModelFailure(modelName, isRateLimit, isAuth)

      // Mid-stream failure after emitting text: rotating restarts the answer and
      // duplicates it on the wire. Propagate instead.
      if (emittedAny) throw err

      // Auth/key/permission/billing errors share the credential across every
      // model — the next model can't succeed, so fail fast instead of burning
      // the 2 s fallback delay.
      if (isAuth) throw err

      if (isLastAttempt) {
        throw err // All approved models exhausted
      }
      emit({ type: 'ai_fallback', requestId: obs.requestId, from: modelName, to: modelsToTry[i + 1], reason: isRateLimit ? 'rate_limit' : 'error' })
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

